# Alpha Research Codex Plugin

This plugin gives Codex thread-native access to Alpha Research datasets, remote runs, artifacts, and research specs.

It uses the saved RESEARCH CLI session at `~/.research/session.json` and calls the Alpha Research dashboard API. It does not require local source checkouts or infrastructure secrets.

## Tools

- `research_login_status`
- `research_login`
- `research_logout`
- `research_list_datasets`
- `research_get_dataset`
- `research_list_runs`
- `research_list_tracked_runs`
- `research_start_run`
- `research_start_agent_run`
- `research_continue_agent_run`
- `research_wait_for_run`
- `research_get_run_results`
- `research_list_run_artifacts`
- `research_cancel_run`
- `research_list_research_specs`
- `research_create_research_spec`

## Manual MCP Smoke Test

From the repository root:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"research_login_status","arguments":{}}}' \
  | node plugins/alpha-research/mcp/server.js
```

From this installed plugin package directory:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"research_login_status","arguments":{}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"research_list_datasets","arguments":{}}}' \
  | node ./mcp/server.js
```
