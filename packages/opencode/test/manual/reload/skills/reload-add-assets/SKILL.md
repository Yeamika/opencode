---
name: reload-add-assets
description: Add demo MCP/tool/skill assets into the current workspace and verify them after reload.
---

# reload-add-assets

Use these repo-local assets:

- tool file:
  - `packages/opencode/test/manual/reload/assets/tools/demo.ts`
- skill folder:
  - `packages/opencode/test/manual/reload/assets/skills/reload-demo-skill`
- MCP snippet:
  - `packages/opencode/test/manual/reload/assets/mcp/demo-remote.json`

Suggested flow:
1. Call `workspaceTool` with:
   - `mode: "write"`
   - `filePath: <absolute path to demo.ts>`
2. Call `workspaceSkill` with:
   - `mode: "write"`
   - `directoryPath: <absolute path to reload-demo-skill>`
3. Call `workspaceMcp` with:
   - `mode: "write"`
   - `scope: "local"`
   - `name: "demo-remote-workspace"`
   - `value: <contents of demo-remote.json>`
4. Call `reload` with `{}`.
5. Call `workspaceOverview` with `{"scope":"local"}`.
6. Verify that the copied tool, skill, and MCP appear and can be called.
