#!/bin/sh
set -eu

OPENCODE_BIN="${OPENCODE_BIN:-/tmp/opencode-reload-latest}"
OPENCODE_PORT="${OPENCODE_PORT:-9301}"
export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-/runtime/opencode-config}"

pkill -f "$OPENCODE_BIN serve --hostname 0.0.0.0 --port $OPENCODE_PORT" || true

workspace=/runtime/workspaces/reload-manual-bad-mcp
rm -rf "$workspace"
mkdir -p "$workspace/.opencode/tools" "$workspace/.opencode/skills"
cat > "$workspace/opencode.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "broken-remote": {
      "type": "remote",
      "url": "http://127.0.0.1:65530/mcp",
      "enabled": true,
      "oauth": false
    }
  }
}
EOF

"$OPENCODE_BIN" serve --hostname 0.0.0.0 --port "$OPENCODE_PORT" >/tmp/opencode-reload-bad-mcp.log 2>&1 &
server_pid=$!
sleep 6

payload='{"permission":[{"permission":"*","pattern":"*","action":"allow"}]}'
session_id=$(curl -s -X POST "http://127.0.0.1:${OPENCODE_PORT}/session" -H 'content-type: application/json' -H "x-opencode-directory: $workspace" -d "$payload" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")

cat <<'EOF' | timeout 420s "$OPENCODE_BIN" run --attach "http://127.0.0.1:${OPENCODE_PORT}" --session "$session_id" --dir "$workspace" -m zai/glm-5 --format json || true
Do not explain first.

1. Call reload with exactly {}.
2. If reload returns a current opencode log path, inspect that path.
3. Then answer with the exact failure reason for broken-remote in one short sentence.
EOF

echo '---MCP---'
curl -sf "http://127.0.0.1:${OPENCODE_PORT}/mcp?directory=%2Fruntime%2Fworkspaces%2Freload-manual-bad-mcp"
echo

kill $server_pid >/dev/null 2>&1 || true
