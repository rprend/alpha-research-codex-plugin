# Alpha Research Codex Plugin Marketplace

This repository publishes the Alpha Research Codex plugin as a Codex plugin marketplace.

The plugin lets Codex use Alpha Research from a thread to:

- inspect login status
- list and inspect datasets
- list, inspect, start, wait for, and cancel remote runs
- list run artifacts
- create and list research specs
- guide dataset intake, research design, and research operations

The MCP server is standalone. It does not require a local Alpha Research source checkout and does not require local OpenAI, DigitalOcean, or dashboard secrets.

## Install

Install the marketplace:

```bash
codex plugin marketplace add rprend/alpha-research-codex-plugin
```

Then open the Codex desktop app plugin page, find **Alpha Research**, and install or enable it.

If the marketplace is already installed and you want the latest version:

```bash
codex plugin marketplace upgrade alpha-research
```

## Authentication

The plugin reuses the standard RESEARCH CLI session file at:

```text
~/.research/session.json
```

If you already ran `research login`, the plugin should work immediately. If not, ask Codex to run the Alpha Research login tool, or run the CLI login first:

```bash
research login
```

No access tokens are stored in this repository or printed by the MCP tools.

## Smoke Test

After installation, test the MCP server directly from a checkout of this marketplace:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"research_login_status","arguments":{}}}' \
  | node plugins/alpha-research/mcp/server.js
```

Expected:

- `initialize` returns server `alpha-research`
- `tools/list` returns the Alpha Research MCP tools
- `research_login_status` returns signed-in state without tokens

## Repository Layout

- `.agents/plugins/marketplace.json`: Codex marketplace index
- `plugins/alpha-research/.codex-plugin/plugin.json`: plugin metadata shown in Codex
- `plugins/alpha-research/.mcp.json`: MCP server registration
- `plugins/alpha-research/mcp/server.js`: standalone stdio MCP server
- `plugins/alpha-research/skills/alpha-research/SKILL.md`: Codex behavior guidance

## Security

The MCP server redacts token-like fields, auth headers, signed URL fields, and presigned URLs embedded in strings before returning tool output.
