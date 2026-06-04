/**
 * REFS Bridge: drop-in replacement for RemoteExecutor.call().
 *
 * Uses the embedded MCP from REFS-opencode napi-rs addon instead of
 * spawning a child process. Same interface, same result shape.
 *
 * Usage:
 *   import { RefsBridge } from "./refs-bridge"
 *   const result = await RefsBridge.call("FileAction", { mode: "create", ... }, { signal: ctx.abort })
 */

import type { SessionMcpHandle, ToolCallResult } from "./refs-opencode"
// @ts-ignore - native addon loaded at runtime
import { createSessionMcp, defaultDbPath } from "@opencode-ai/refs-opencode"
import { Database } from "@/storage/db"
import { Instance } from "@/project/instance"

type Result = {
  title: string
  metadata: Record<string, unknown>
  output: string
}

let handle: SessionMcpHandle | undefined

/**
 * Initialize the REFS MCP handle. Call once at startup.
 * Reads the same SQLite database that OpenCode uses.
 */
export function init(dbPath?: string, sessionId?: string, workdir?: string): SessionMcpHandle {
  const db = dbPath ?? defaultDbPath()
  const sid = sessionId ?? "default"
  const dir = workdir ?? Instance.directory
  handle = createSessionMcp(db, sid, dir)
  return handle
}

/**
 * Get the current MCP handle. Initializes lazily if needed.
 */
export function getHandle(): SessionMcpHandle {
  if (!handle) return init()
  return handle
}

/**
 * Call a tool via the embedded MCP. Drop-in replacement for RemoteExecutor.call().
 *
 * @param tool - tool name (e.g. "FileAction", "read", "rg", "exbash")
 * @param args - tool arguments
 * @param opts - optional signal/timeout/executor (signal and timeout are noted but
 *               the embedded MCP doesn't support abort yet; executor is passed through)
 */
export async function call(
  tool: string,
  args: Record<string, unknown>,
  opts?: { signal?: AbortSignal; timeout?: number; executor?: string },
): Promise<Result> {
  const mcp = getHandle()

  // Merge executor into args if provided
  const merged = { ...args }
  if (opts?.executor && opts.executor !== "local") {
    merged.executor = opts.executor
  }

  const json = mcp.callTool(tool, JSON.stringify(merged))
  const parsed = JSON.parse(json) as {
    error?: { code: number; message: string }
    result?: ToolCallResult
  }

  if (parsed.error) {
    throw new Error(parsed.error.message || `REFS ${tool} failed`)
  }

  const result = parsed.result
  if (!result) {
    throw new Error(`REFS ${tool} returned no result`)
  }

  // Extract structuredContent (same as RemoteExecutor.output())
  const sc = (result.structuredContent ?? {}) as Record<string, unknown>
  const meta = (sc.metadata ?? {}) as Record<string, unknown>
  const title = typeof sc.title === "string" ? sc.title : tool

  // Extract output text (merge message/text/info like RemoteExecutor.outputString)
  const outputObj = sc.output as Record<string, unknown> | undefined
  let output: string
  if (typeof sc.output === "string") {
    output = sc.output
  } else if (outputObj && typeof outputObj === "object") {
    const parts = [outputObj.message, outputObj.text, outputObj.info]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
    output = parts.length ? parts.join("\n") : result.content?.[0]?.text ?? ""
  } else {
    output = result.content?.[0]?.text ?? ""
  }

  return { title, metadata: meta, output }
}

/**
 * Check if REFS is available (always true when the addon is loaded).
 */
export async function enabled(): Promise<boolean> {
  try {
    getHandle()
    return true
  } catch {
    return false
  }
}

/**
 * List executor information. Replaces RemoteExecutor.list().
 */
export async function list(dir?: string): Promise<Record<string, unknown>> {
  const mcp = getHandle()
  const json = mcp.callToolText(
    "RemoteExecutorManager",
    JSON.stringify({ method: "list_executor" }),
  )
  try {
    return JSON.parse(json)
  } catch {
    return { executors: [] }
  }
}
