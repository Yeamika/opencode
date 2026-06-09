/**
 * REFS-opencode: napi-rs bindings for RemoteExecutorForSession SDK.
 *
 * Provides an embedded MCP handler that reads/writes OpenCode's SQLite database
 * directly, handling hashRef pipeline, Caller routing, and exbash task tracking.
 *
 * Tool schemas are the single source of truth from the Rust SDK's `mcptooldefs.rs`,
 * read dynamically via `tools/list` - never duplicated in TS.
 *
 * Native addon is loaded lazily at runtime - the .node file must be built
 * by napi-rs before use. If not available, functions will throw.
 */

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
  callTool(name: string, argsJson: string): string
  callToolText(name: string, argsJson: string): string
  listExecutorsJson(): string
  handleRaw(request: string): string
  setExbashChangedCallback(callback: (eventJson: string) => void): void
}

// Lazy-loaded native addon reference
let _addon: any = undefined

/**
 * Load the native addon. Throws if not built.
 * The .node file is resolved by Bun/Node at runtime from the package directory.
 */
function getAddon(): any {
  if (_addon) return _addon
  // Dynamic require so the import doesn't fail at module load time
  // when the .node file hasn't been built yet
  try {
    // Bun resolves .node files from the package root
    _addon = require("../refs-opencode.linux-x64-gnu.node")
    return _addon
  } catch {
    throw new Error(
      "REFS-opencode native addon not found. Run `napi build --platform` in packages/REFS-opencode first.",
    )
  }
}

/**
 * Create a session MCP handler backed by OpenCode's SQLite database.
 */
export function createSessionMcp(dbPath: string, sessionId: string, workdir: string): SessionMcpHandle {
  return getAddon().createSessionMcp(dbPath, sessionId, workdir)
}

/**
 * Get the default SQLite database path used by OpenCode.
 */
export function defaultDbPath(): string {
  return getAddon().defaultDbPath()
}

/**
 * Get SDK tool definitions by calling tools/list on the MCP handle.
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
