#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const SESSION_DIR = process.env.RESEARCH_SESSION_DIR ?? join(homedir(), ".research");
const SESSION_PATH = join(SESSION_DIR, "session.json");
const RUNS_PATH = join(SESSION_DIR, "runs.json");
const DEFAULT_WEB_ORIGIN = process.env.ALPHA_RESEARCH_WEB_ORIGIN ?? "https://alpharesearch.nyc";
const DEFAULT_DASHBOARD_ORIGIN = process.env.ALPHA_RESEARCH_DASHBOARD_ORIGIN ?? "https://dashboard.alpharesearch.nyc";

const TERMINAL_STATUSES = new Set([
  "ready",
  "completed",
  "succeeded",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "unknown",
  "worker_unreachable",
]);

const toolSchemas = [
  {
    name: "research_login_status",
    description: "Show the current Alpha Research CLI login status without exposing tokens.",
    inputSchema: objectSchema({}),
  },
  {
    name: "research_login",
    description: "Start the browser login flow and save an Alpha Research CLI session.",
    inputSchema: objectSchema({
      origin: { type: "string", description: "Optional Alpha Research web origin." },
      port: { type: "integer", description: "Optional localhost callback port. Defaults to 43119." },
    }),
  },
  {
    name: "research_logout",
    description: "Remove the saved Alpha Research CLI session from this machine.",
    inputSchema: objectSchema({}),
  },
  {
    name: "research_list_datasets",
    description: "List datasets registered on the Alpha Research control plane.",
    inputSchema: objectSchema({}),
  },
  {
    name: "research_get_dataset",
    description: "Inspect one remote dataset, including profile, deployment status, source coverage, and limitations when available.",
    inputSchema: objectSchema({ datasetId: { type: "string" } }, ["datasetId"]),
  },
  {
    name: "research_list_runs",
    description: "List remote runs, optionally scoped to a dataset.",
    inputSchema: objectSchema({ datasetId: { type: "string" } }),
  },
  {
    name: "research_list_tracked_runs",
    description: "List locally tracked Alpha Research runs from the RESEARCH CLI session directory.",
    inputSchema: objectSchema({}),
  },
  {
    name: "research_start_run",
    description: "Start a typed remote run against a dataset. Use after research design is concrete enough to run.",
    inputSchema: objectSchema({
      datasetId: { type: "string" },
      prompt: { type: "string" },
      type: { type: "string", enum: ["analysis", "fetch", "transform", "label", "hypothesis", "agent", "query", "describe"] },
      config: { type: "object" },
      artifacts: { type: "array", items: { type: "object" } },
    }, ["datasetId", "prompt"]),
  },
  {
    name: "research_start_agent_run",
    description: "Start a remote agent run on a dataset-attached environment and track it locally.",
    inputSchema: objectSchema({
      datasetId: { type: "string" },
      prompt: { type: "string" },
      artifacts: { type: "array", items: { type: "object" } },
    }, ["datasetId", "prompt"]),
  },
  {
    name: "research_continue_agent_run",
    description: "Continue a previous remote agent run when it has a resumable remote agent session artifact.",
    inputSchema: objectSchema({
      runId: { type: "string" },
      prompt: { type: "string" },
      artifacts: { type: "array", items: { type: "object" } },
    }, ["runId", "prompt"]),
  },
  {
    name: "research_wait_for_run",
    description: "Poll a run until it reaches a terminal status or the timeout expires.",
    inputSchema: objectSchema({
      runId: { type: "string" },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 1800 },
    }, ["runId"]),
  },
  {
    name: "research_get_run_results",
    description: "Retrieve a run with status, events, metadata, and produced/requested artifacts.",
    inputSchema: objectSchema({ runId: { type: "string" } }, ["runId"]),
  },
  {
    name: "research_list_run_artifacts",
    description: "List artifacts for a remote run.",
    inputSchema: objectSchema({ runId: { type: "string" } }, ["runId"]),
  },
  {
    name: "research_cancel_run",
    description: "Cancel an in-progress remote run and terminate its worker when possible.",
    inputSchema: objectSchema({ runId: { type: "string" } }, ["runId"]),
  },
  {
    name: "research_list_research_specs",
    description: "List saved research specs or hypothesis plans, optionally scoped to a dataset.",
    inputSchema: objectSchema({ datasetId: { type: "string" } }),
  },
  {
    name: "research_create_research_spec",
    description: "Save a concrete research design or hypothesis plan for a dataset.",
    inputSchema: objectSchema({
      datasetId: { type: "string" },
      hypothesis: { type: "string" },
      spec: { type: "object" },
      status: { type: "string" },
    }, ["datasetId", "hypothesis"]),
  },
];

function objectSchema(properties, required = []) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

async function ensureSessionDir() {
  await mkdir(SESSION_DIR, { recursive: true });
}

async function readSession() {
  try {
    return JSON.parse(await readFile(SESSION_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function writeSession(session) {
  await ensureSessionDir();
  await writeFile(SESSION_PATH, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

async function clearSession() {
  await rm(SESSION_PATH, { force: true });
}

async function readSessionOrThrow() {
  const session = await readSession();
  if (!session?.origin || !session?.accessToken) {
    throw new Error("Not signed in to Alpha Research. Use research_login first.");
  }
  return session;
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function login(input = {}, logger = () => {}) {
  const origin = optionalString(input, "origin") ?? DEFAULT_WEB_ORIGIN;
  const state = crypto.randomUUID();
  const port = Number(input.port ?? 43119);
  const callbackPath = "/cli/callback";
  const callbackUrl = `http://127.0.0.1:${port}${callbackPath}`;
  const loginUrl = new URL("/cli/login", origin);
  loginUrl.searchParams.set("state", state);
  loginUrl.searchParams.set("redirect_uri", callbackUrl);
  loginUrl.searchParams.set("client", "codex-plugin");

  const accessToken = await new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", callbackUrl);
      if (requestUrl.pathname !== callbackPath) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      const returnedState = requestUrl.searchParams.get("state");
      const token = requestUrl.searchParams.get("token");
      if (returnedState !== state || !token) {
        response.statusCode = 400;
        response.end("Missing or invalid Alpha Research auth callback");
        server.close();
        reject(new Error("Invalid Alpha Research auth callback"));
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<html><body><h1>Alpha Research login complete</h1><p>You can return to Codex.</p></body></html>");
      server.close();
      resolve(token);
    });
    server.listen(port, "127.0.0.1", () => {
      logger(`Opening Alpha Research login: ${loginUrl.toString()}`);
      openBrowser(loginUrl.toString());
    });
    server.on("error", reject);
  });

  const session = { origin, accessToken, createdAt: new Date().toISOString() };
  await writeSession(session);
  return session;
}

async function request(path, options = {}) {
  const session = await readSessionOrThrow();
  const response = await fetch(`${session.origin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const detail = text.trim().length > 0 ? ` ${text.trim()}` : "";
    throw new Error(`Remote request failed (${response.status}) for ${path}.${detail}`);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

async function requestOptional(path, options = {}) {
  const session = await readSessionOrThrow();
  const response = await fetch(`${session.origin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const detail = text.trim().length > 0 ? ` ${text.trim()}` : "";
    throw new Error(`Remote request failed (${response.status}) for ${path}.${detail}`);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

async function readTrackedRuns() {
  try {
    const parsed = JSON.parse(await readFile(RUNS_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeTrackedRuns(runs) {
  await ensureSessionDir();
  await writeFile(RUNS_PATH, `${JSON.stringify(runs, null, 2)}\n`, "utf8");
}

async function trackRemoteRun(run) {
  const session = await readSessionOrThrow();
  const now = new Date().toISOString();
  const runs = await readTrackedRuns();
  const next = runs.filter((item) => item.id !== run.id);
  next.push({
    id: run.id,
    datasetId: run.datasetId,
    origin: session.origin,
    status: run.status,
    prompt: run.prompt,
    dashboardUrl: dashboardRunUrl(session.origin, run.id),
    createdAt: run.createdAt ?? now,
    updatedAt: run.updatedAt ?? now,
    lastSeenAt: now,
    terminalAt: isTerminalRunStatus(run.status) ? now : undefined,
  });
  next.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  await writeTrackedRuns(next);
}

function dashboardOriginFor(origin) {
  if (origin.includes("localhost")) return `${origin}?view=dashboard`;
  return DEFAULT_DASHBOARD_ORIGIN;
}

function dashboardRunUrl(origin, runId) {
  const url = new URL(dashboardOriginFor(origin));
  url.searchParams.set("view", "runs");
  url.searchParams.set("runId", runId);
  url.hash = `run-${encodeURIComponent(runId)}`;
  return url.toString();
}

function isTerminalRunStatus(status) {
  return status ? TERMINAL_STATUSES.has(String(status).toLowerCase()) : false;
}

async function runTool(name, input = {}) {
  switch (name) {
    case "research_login_status": {
      const session = await readSession();
      if (!session) return { signedIn: false };
      const me = await request("/api/cli/me").catch((error) => ({ error: String(error.message ?? error) }));
      return { signedIn: true, origin: session.origin, createdAt: session.createdAt, me };
    }
    case "research_login": {
      const session = await login(input);
      return { signedIn: true, origin: session.origin, createdAt: session.createdAt };
    }
    case "research_logout":
      await clearSession();
      return { signedIn: false };
    case "research_list_datasets":
      return await request("/api/cli/datasets");
    case "research_get_dataset":
      return await request(`/api/cli/datasets/${encodeURIComponent(requiredString(input, "datasetId"))}`);
    case "research_list_runs": {
      const datasetId = optionalString(input, "datasetId");
      const suffix = datasetId ? `?datasetId=${encodeURIComponent(datasetId)}` : "";
      return await request(`/api/cli/runs${suffix}`);
    }
    case "research_list_tracked_runs":
      return { runs: await readTrackedRuns() };
    case "research_start_run": {
      const datasetId = requiredString(input, "datasetId");
      const result = await request(`/api/cli/datasets/${encodeURIComponent(datasetId)}/runs`, {
        method: "POST",
        body: {
          prompt: requiredString(input, "prompt"),
          type: optionalString(input, "type"),
          config: objectOrUndefined(input.config),
          artifacts: arrayOrUndefined(input.artifacts),
        },
      });
      await trackRemoteRun(result.run);
      const session = await readSessionOrThrow();
      return { ...result, dashboardUrl: dashboardRunUrl(session.origin, result.run.id), pending: true };
    }
    case "research_start_agent_run": {
      const datasetId = requiredString(input, "datasetId");
      const result = await request(`/api/cli/datasets/${encodeURIComponent(datasetId)}/runs`, {
        method: "POST",
        body: {
          prompt: requiredString(input, "prompt"),
          type: "agent",
          artifacts: arrayOrUndefined(input.artifacts),
        },
      });
      await trackRemoteRun(result.run);
      const session = await readSessionOrThrow();
      return { ...result, dashboardUrl: dashboardRunUrl(session.origin, result.run.id), pending: true };
    }
    case "research_continue_agent_run": {
      const previous = await request(`/api/cli/runs/${encodeURIComponent(requiredString(input, "runId"))}/results`);
      const sessionArtifact = previous.artifacts.find((artifact) => artifact.type === "remote_agent_session");
      const remoteAgentSessionId = sessionArtifact?.content && typeof sessionArtifact.content === "object"
        ? String(sessionArtifact.content.sessionId ?? "")
        : "";
      if (!remoteAgentSessionId) {
        return {
          ok: false,
          reason: "not_resumable",
          run: previous.run,
          producedArtifacts: previous.artifacts.filter((artifact) => artifact.type !== "requested_artifact"),
        };
      }
      const result = await request(`/api/cli/datasets/${encodeURIComponent(previous.run.datasetId)}/runs`, {
        method: "POST",
        body: {
          prompt: requiredString(input, "prompt"),
          type: "agent",
          config: { remoteAgentSessionId, parentRunId: previous.run.id },
          artifacts: arrayOrUndefined(input.artifacts),
        },
      });
      await trackRemoteRun(result.run);
      const session = await readSessionOrThrow();
      return { ...result, dashboardUrl: dashboardRunUrl(session.origin, result.run.id), remoteAgentSessionId, pending: true };
    }
    case "research_wait_for_run":
      return await waitForRun(requiredString(input, "runId"), Number(input.timeoutSeconds ?? 180));
    case "research_get_run_results": {
      const payload = await request(`/api/cli/runs/${encodeURIComponent(requiredString(input, "runId"))}/results`);
      await trackRemoteRun(payload.run);
      const session = await readSessionOrThrow();
      return { ...payload, dashboardUrl: dashboardRunUrl(session.origin, payload.run.id) };
    }
    case "research_list_run_artifacts":
      return await request(`/api/cli/runs/${encodeURIComponent(requiredString(input, "runId"))}/artifacts`);
    case "research_cancel_run": {
      const result = await request(`/api/cli/runs/${encodeURIComponent(requiredString(input, "runId"))}/cancel`, {
        method: "POST",
      });
      await trackRemoteRun(result.run);
      return result;
    }
    case "research_list_research_specs": {
      const datasetId = optionalString(input, "datasetId");
      const suffix = datasetId ? `?datasetId=${encodeURIComponent(datasetId)}` : "";
      return await request(`/api/cli/research-specs${suffix}`);
    }
    case "research_create_research_spec":
      return await request("/api/cli/research-specs", {
        method: "POST",
        body: {
          datasetId: requiredString(input, "datasetId"),
          hypothesis: requiredString(input, "hypothesis"),
          spec: objectOrUndefined(input.spec),
          status: optionalString(input, "status"),
        },
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function waitForRun(runId, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = null;
  while (Date.now() <= deadline) {
    const payload = await request(`/api/cli/runs/${encodeURIComponent(runId)}/results`);
    last = payload;
    await trackRemoteRun(payload.run);
    if (isTerminalRunStatus(payload.run.status)) {
      return { complete: true, ...payload };
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return { complete: false, ...(last ?? await requestOptional(`/api/cli/runs/${encodeURIComponent(runId)}`)) };
}

function requiredString(input, key) {
  const value = input?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required string: ${key}`);
  }
  return value;
}

function optionalString(input, key) {
  const value = input?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function objectOrUndefined(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function arrayOrUndefined(value) {
  return Array.isArray(value) ? value : undefined;
}

function redact(value) {
  return JSON.parse(JSON.stringify(value, (key, nested) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.includes("token")
      || normalizedKey === "authorization"
      || normalizedKey === "uploadurl"
      || normalizedKey === "downloadurl"
      || normalizedKey === "signedurl"
      || normalizedKey === "presignedurl"
    ) {
      return "[redacted]";
    }
    if (typeof nested === "string") return redactString(nested);
    return nested;
  }));
}

function redactString(value) {
  return value
    .replaceAll(/https?:\/\/[^\s"')<>]+X-Amz-[^\s"')<>]+/g, "[redacted-presigned-url]")
    .replaceAll(/https?:\/\/[^\s"')<>]+[?&](?:token|signature|access_token|auth)=[^\s"')<>]+/gi, "[redacted-signed-url]")
    .replaceAll(/(Authorization:\s*)(?:Bearer\s+)?[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replaceAll(/(X-Amz-(?:Credential|Signature)=)[^&\s"')<>]+/g, "$1[redacted]");
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, error) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message: error?.message ?? String(error) },
  })}\n`);
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  if (id === undefined && method?.startsWith("notifications/")) return;
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "alpha-research", version: "0.1.0" },
      });
      return;
    }
    if (method === "tools/list") {
      reply(id, { tools: toolSchemas });
      return;
    }
    if (method === "tools/call") {
      const output = await runTool(params?.name, params?.arguments ?? {});
      reply(id, {
        content: [{ type: "text", text: JSON.stringify(redact(output), null, 2) }],
      });
      return;
    }
    reply(id, {});
  } catch (error) {
    fail(id, error);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      fail(null, error);
    }
  }
});
