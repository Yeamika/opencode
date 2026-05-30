---
name: reload-scope-read
description: Read local and global workspace state and print the exact paths used.
---

# reload-scope-read

Suggested flow:

1. Call `workspaceOverview` with `{"scope":"local"}`.
2. Call `workspaceOverview` with `{"scope":"global"}`.
3. Call `workspaceMcp` with `{"mode":"read","scope":"local"}`.
4. Call `workspaceMcp` with `{"mode":"read","scope":"global"}`.
5. Explain the exact paths returned for local and global config/tool/skill reads.
