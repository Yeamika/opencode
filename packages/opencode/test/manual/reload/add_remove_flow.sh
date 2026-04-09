#!/bin/sh
set -eu

OPENCODE_BIN="${OPENCODE_BIN:-/tmp/opencode-reload-latest}"
OPENCODE_PORT="${OPENCODE_PORT:-9301}"
export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-/runtime/opencode-config}"

pkill -f "$OPENCODE_BIN serve --hostname 0.0.0.0 --port $OPENCODE_PORT" || true

workspace=/runtime/workspaces/reload-manual-add-remove
rm -rf "$workspace"
mkdir -p "$workspace/.opencode/tools" "$workspace/.opencode/skills"
cat > "$workspace/opencode.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {}
}
EOF

"$OPENCODE_BIN" serve --hostname 0.0.0.0 --port "$OPENCODE_PORT" >/tmp/opencode-reload-manual.log 2>&1 &
server_pid=$!
sleep 6

payload='{"permission":[{"permission":"*","pattern":"*","action":"allow"}]}'
session_id=$(curl -s -X POST "http://127.0.0.1:${OPENCODE_PORT}/session" -H 'content-type: application/json' -H "x-opencode-directory: $workspace" -d "$payload" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")

cat <<'EOF' | timeout 300s "$OPENCODE_BIN" run --attach "http://127.0.0.1:${OPENCODE_PORT}" --session "$session_id" --dir "$workspace" -m zai/glm-5 --format json || true
Call workspaceTool with mode write, name demo.ts, and content exactly:

```ts
export default {
  description: "Demo tool",
  args: {},
  async execute() {
    return "demo tool ok"
  },
}
```

Call workspaceSkill with mode write, name reload-test-skill, and content exactly:

```md
---
name: reload-test-skill
description: demo reload skill
---

# reload-test-skill

Demo reload skill.
```

Call workspaceMcp with mode write, name demo-remote-workspace, and value:

```json
{
  "type": "remote",
  "url": "http://host.docker.internal:8811/mcp",
  "enabled": true,
  "oauth": false
}
```

Call reload with exactly {}.
EOF

echo '---POST-ADD-MCP---'
curl -sf "http://127.0.0.1:${OPENCODE_PORT}/mcp?directory=%2Fruntime%2Fworkspaces%2Freload-manual-add-remove"
echo

session_id=$(curl -s -X POST "http://127.0.0.1:${OPENCODE_PORT}/session" -H 'content-type: application/json' -H "x-opencode-directory: $workspace" -d "$payload" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")

cat <<'EOF' | timeout 300s "$OPENCODE_BIN" run --attach "http://127.0.0.1:${OPENCODE_PORT}" --session "$session_id" --dir "$workspace" -m zai/glm-5 --format json || true
Call workspaceMcp with mode delete and name demo-remote-workspace.
Call workspaceTool with mode delete and name demo.ts.
Call workspaceSkill with mode delete and name reload-test-skill.
Call reload with exactly {}.
EOF

echo '---POST-DELETE-MCP---'
curl -sf "http://127.0.0.1:${OPENCODE_PORT}/mcp?directory=%2Fruntime%2Fworkspaces%2Freload-manual-add-remove"
echo

kill $server_pid >/dev/null 2>&1 || true
