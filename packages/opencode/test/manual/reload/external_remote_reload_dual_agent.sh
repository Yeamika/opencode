#!/bin/sh
set -eu

OPENCODE_BIN="${OPENCODE_BIN:-/tmp/opencode-reload-latest}"
OPENCODE_PORT="${OPENCODE_PORT:-9302}"
export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-/runtime/opencode-config}"

pkill -f "$OPENCODE_BIN serve --hostname 0.0.0.0 --port $OPENCODE_PORT" || true

workspace=/runtime/workspaces/remote-reload-dual
rm -rf "$workspace"
mkdir -p "$workspace/.opencode/tools" "$workspace/.opencode/skills"
cat > "$workspace/opencode.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {}
}
EOF

"$OPENCODE_BIN" serve --hostname 0.0.0.0 --port "$OPENCODE_PORT" >/tmp/opencode-remote-reload.log 2>&1 &
server_pid=$!
sleep 6

payload='{"permission":[{"permission":"*","pattern":"*","action":"allow"}]}'
sid1=$(curl -s -X POST "http://127.0.0.1:${OPENCODE_PORT}/session" -H 'content-type: application/json' -H "x-opencode-directory: $workspace" -d "$payload" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
sid2=$(curl -s -X POST "http://127.0.0.1:${OPENCODE_PORT}/session" -H 'content-type: application/json' -H "x-opencode-directory: $workspace" -d "$payload" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")

printf '%s
printf '%s

cat > "$workspace/.opencode/tools/demo.ts" <<'EOF'
export default {
  description: "Demo tool",
  args: {},
  async execute() {
    return "demo tool ok"
  },
}
EOF

mkdir -p "$workspace/.opencode/skills/reload-test-skill"
cat > "$workspace/.opencode/skills/reload-test-skill/SKILL.md" <<'EOF'
---
name: reload-test-skill
description: demo reload skill
---

# reload-test-skill

Demo reload skill.
EOF

cat > "$workspace/opencode.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "demo-remote-workspace": {
      "type": "remote",
      "url": "http://host.docker.internal:8811/mcp",
      "enabled": true,
      "oauth": false
    }
  }
}
EOF

curl -s -X POST "http://127.0.0.1:${OPENCODE_PORT}/project/reload" -H "x-opencode-directory: $workspace"
echo

cat <<'EOF' | timeout 300s "$OPENCODE_BIN" run --attach "http://127.0.0.1:${OPENCODE_PORT}" --session "$sid1" --dir "$workspace" -m zai/glm-5 --format json || true
Call the skill tool to load reload-test-skill. Then call the tool named demo. Then call the tool named demo-remote-workspace_demo_ping. Finally answer with three lines: skill, demo tool, demo mcp.
EOF

cat <<'EOF' | timeout 300s "$OPENCODE_BIN" run --attach "http://127.0.0.1:${OPENCODE_PORT}" --session "$sid2" --dir "$workspace" -m zai/glm-5 --format json || true
Call the skill tool to load reload-test-skill. Then call the tool named demo. Then call the tool named demo-remote-workspace_demo_ping. Finally answer with three lines: skill, demo tool, demo mcp.
EOF

kill $server_pid >/dev/null 2>&1 || true
