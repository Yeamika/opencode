---
name: reload-remove-assets
description: Remove demo MCP/tool/skill assets from the current workspace and verify disappearance after reload.
---

# reload-remove-assets

Use the same repo-local asset paths that were used for installation.

Suggested flow:
1. Call `workspaceTool` with:
   - `mode: "delete"`
   - `filePath: <absolute path to demo.ts>`
2. Call `workspaceSkill` with:
   - `mode: "delete"`
   - `directoryPath: <absolute path to reload-demo-skill>`
3. Call `workspaceMcp` with:
   - `mode: "delete"`
   - `scope: "local"`
   - `name: "demo-remote-workspace"`
4. Call `reload` with `{}`.
5. Call `workspaceOverview` with `{"scope":"local"}`.
6. Verify that the tool, skill, and MCP are gone.
