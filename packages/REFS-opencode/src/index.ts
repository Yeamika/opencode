/**
 * REFS-opencode: napi-rs bindings for RemoteExecutorForSession SDK.
 *
 * Provides an embedded MCP handler that reads/writes OpenCode's SQLite database
 * directly, handling hashRef pipeline, Caller routing, and exbash task tracking.
 *
 * Tool schemas are the single source of truth from the Rust SDK's `mcptooldefs.rs`,
 * read dynamically via `tools/list` - never duplicated in TS.
 */

// @ts-ignore - native addon (built by napi-rs)
import refsAddon from "../refs-opencode.linux-x64-gnu.node" assert { type: "native" }

export interface ToolDefinition {
  name: string
  description: string | null
  inputSchema: Record<string, unknown>
}

export interface ToolCallResult {
  content: Array<{ type: string; text: string }>
  structuredContent?: unknown
}

export interface SessionMcpHandle {
  listTools(): string
  callTool(name: string, arguments: string): string
  callToolText(name: string, arguments: string): string
  callToolStructured(name: string, arguments: string): string
  handleRaw(request: string): string
}

/**
 * Create a session MCP handler backed by OpenCode's SQLite database.
 *
 * @param dbPath - path to the SQLite database file
 * @param sessionId - the current session ID
 * @param workdir - the current working directory
 */
export function createSessionMcp(
  dbPath: string,
  sessionId: string,
  workdir: string,
): SessionMcpHandle {
  return refsAddon.createSessionMcp(dbPath, sessionId, workdir)
}

/**
 * Get the default SQLite database path used by OpenCode.
 */
export function defaultDbPath(): string {
  return refsAddon.defaultDbPath()
}

/**
 * Get SDK tool definitions by calling tools/list on the MCP handle.
 * Returns parsed tool definitions with name, description, and JSON Schema.
 *
 * This is the single source of truth for tool schemas - they come from
 * the Rust SDK's `mcptooldefs.rs` and should NOT be duplicated in TS.
 */
export function getSdkToolDefinitions(handle: SessionMcpHandle): ToolDefinition[] {
  const json = handle.listTools()
  const parsed = JSON.parse(json)
  return parsed?.result?.tools ?? []
}

/**
 * Parse a tool call result from the JSON string returned by callTool().
 */
export function parseToolCallResult(json: string): {
  error?: { code: number; message: string }
  result?: ToolCallResult
} {
  return JSON.parse(json)
}

/**
 * Extract the model-visible output text from a tool call result.
 */
export function extractOutputText(json: string): string {
  const parsed = parseToolCallResult(json)
  return parsed?.result?.content?.[0]?.text ?? ""
}

/**
 * Extract the structured content from a tool call result.
 */
export function extractStructuredContent(json: string): unknown {
  const parsed = parseToolCallResult(json)
  return parsed?.result?.structuredContent
}
