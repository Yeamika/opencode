#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

use remote_executor_for_session::jsonrpc::{JsonRpcEndpoint, JsonRpcHandler};
use remote_executor_for_session::mcp::{
    create_session_mcp_with_manager, EmbeddedMcp, SessionMcpHandler,
};
use remote_executor_for_session::rec::{new_manager, ShellManager, ToolContext};

mod sqlite_host;
use sqlite_host::SqliteSessionHost;

/// Handle to a session MCP instance. Holds the JSON-RPC endpoint and Caller alive.
#[napi]
pub struct SessionMcpHandle {
    ep: JsonRpcEndpoint<EmbeddedMcp<SessionMcpHandler<SqliteSessionHost>>>,
}

#[napi]
impl SessionMcpHandle {
    /// List available MCP tool definitions.
    ///
    /// Returns JSON: `{ "tools": [ { "name": "...", "description": "...", "inputSchema": {...} } ] }`
    #[napi]
    pub async fn list_tools(&self) -> napi::Result<String> {
        let resp = self
            .ep
            .handle_value(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/list"
            }))
            .await;
        serde_json::to_string_pretty(&resp).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Call an MCP tool by name with JSON arguments.
    ///
    /// Returns the full JSON-RPC response object.
    #[napi]
    pub async fn call_tool(&self, name: String, arguments: String) -> napi::Result<String> {
        let args: Value =
            serde_json::from_str(&arguments).unwrap_or_else(|_| serde_json::json!({}));
        let resp = self
            .ep
            .handle_value(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": args
                }
            }))
            .await;
        serde_json::to_string_pretty(&resp).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Call an MCP tool and return only the content[0].text (the model-visible output).
    #[napi]
    pub async fn call_tool_text(
        &self,
        name: String,
        arguments: String,
    ) -> napi::Result<String> {
        let args: Value =
            serde_json::from_str(&arguments).unwrap_or_else(|_| serde_json::json!({}));
        let resp = self
            .ep
            .handle_value(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": args
                }
            }))
            .await;
        let text = resp
            .pointer("/result/content/0/text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Ok(text)
    }

    /// Call an MCP tool and return only the structuredContent (for programmatic use).
    #[napi]
    pub async fn call_tool_structured(
        &self,
        name: String,
        arguments: String,
    ) -> napi::Result<String> {
        let args: Value =
            serde_json::from_str(&arguments).unwrap_or_else(|_| serde_json::json!({}));
        let resp = self
            .ep
            .handle_value(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": args
                }
            }))
            .await;
        let sc = resp
            .pointer("/result/structuredContent")
            .cloned()
            .unwrap_or(Value::Null);
        serde_json::to_string_pretty(&sc).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Handle a raw JSON-RPC request (supports batch).
    #[napi]
    pub async fn handle_raw(&self, request: String) -> napi::Result<String> {
        let value: Value =
            serde_json::from_str(&request).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let resp = self.ep.handle_value(value).await;
        serde_json::to_string_pretty(&resp).map_err(|e| napi::Error::from_reason(e.to_string()))
    }
}

/// Create a new session MCP handler backed by OpenCode's SQLite database.
///
/// - `db_path`: path to the SQLite database file (e.g. `~/.local/share/opencode/opencode.db`)
/// - `session_id`: the current session ID
/// - `workdir`: the current working directory
///
/// Returns a `SessionMcpHandle` that can be used to call tools.
#[napi]
pub async fn create_session_mcp(
    db_path: String,
    session_id: String,
    workdir: String,
) -> napi::Result<SessionMcpHandle> {
    let host = SqliteSessionHost::new(session_id, workdir.clone(), PathBuf::from(&db_path))
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let host = Arc::new(host);
    let shell_manager = ShellManager::default_shell(80, 24);
    let ctx = ToolContext::new(Some(PathBuf::from(&workdir)));

    let manager = new_manager()
        .await
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let shared_manager = Arc::new(manager);

    let mcp = create_session_mcp_with_manager(ctx, host, shared_manager, shell_manager);
    let ep = JsonRpcEndpoint::new(mcp);

    Ok(SessionMcpHandle { ep })
}

/// Get the default SQLite database path used by OpenCode.
#[napi]
pub fn default_db_path() -> napi::Result<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let data_dir =
        std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| format!("{home}/.local/share"));
    Ok(format!("{data_dir}/opencode/opencode.db"))
}
