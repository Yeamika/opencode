---
name: reload-broken-mcp
description: Add a broken remote MCP, run reload, and report the exact failure reason.
---

# reload-broken-mcp

Use this repo-local MCP snippet:

- `packages/opencode/test/manual/reload/assets/mcp/broken-remote.json`

Suggested flow:
1. Call `workspaceMcp` with:
   - `mode: "write"`
   - `scope: "local"`
   - `name: "broken-remote"`
   - `value: <contents of broken-remote.json>`
2. Call `reload` with `{}`.
3. Read the `opencodeLogPath` returned by `reload`.
4. Report the exact MCP failure reason.
