/**
 * Module declaration for @opencode-ai/refs-opencode native addon.
 * The actual module is a napi-rs native addon loaded at runtime.
 */

declare module "@opencode-ai/refs-opencode" {
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

  export function createSessionMcp(dbPath: string, sessionId: string, workdir: string): SessionMcpHandle
  export function defaultDbPath(): string
  export function getSdkToolDefinitions(handle: SessionMcpHandle): ToolDefinition[]
  export function parseToolCallResult(json: string): {
    error?: { code: number; message: string }
    result?: ToolCallResult
  }
  export function extractOutputText(json: string): string
  export function extractStructuredContent(json: string): unknown
}
