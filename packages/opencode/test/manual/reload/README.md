## Reload Manual Test Scripts

These scripts are intended to run inside the Linux test container after placing the built reload CLI at `OPENCODE_BIN`.

Defaults:

- `OPENCODE_BIN=/tmp/opencode-reload-latest`
- `OPENCODE_PORT=9301`
- `OPENCODE_CONFIG_DIR=/runtime/opencode-config`

Scripts:

- `add_remove_flow.sh`: add workspace MCP/tool/skill, reload, then delete and reload
- `bad_mcp_flow.sh`: add a broken remote MCP, reload, and inspect the reported failure
- `external_remote_reload_dual_agent.sh`: two agents on one workspace, external reload, then both agents call the refreshed tool/skill/MCP
