/**
 * REFS Bridge for the embedded REFS MCP.
 *
 * Uses the embedded MCP from REFS-opencode napi-rs addon instead of
 * spawning a child process. Same interface, same result shape.
 *
 * Usage:
 *   import { RefsBridge } from "./refs-bridge"
 *   const result = await RefsBridge.call("FileAction", { mode: "create", ... }, { signal: ctx.abort })
 */

import type { SessionMcpHandle, ToolCallResult } from "./refs-opencode"
import { Database } from "@/storage/db"
import { Instance } from "@/project/instance"
import { existsSync } from "fs"
import { dirname, join } from "path"

type Result = {
  title: string
  metadata: Record<string, unknown>
  output: string
}

export type ExecutorListItem = {
  id: string
  default?: boolean
  system?: string
  device?: string
  url?: string
  labels?: Record<string, string>
}

const handles = new Map<string, SessionMcpHandle>()
type RefsAddon = { createSessionMcp(dbPath: string, sessionID: string, workdir: string): SessionMcpHandle }
let addon: RefsAddon | undefined

type HandleInput = {
  dbPath?: string
  sessionID?: string
  workdir?: string
}

function handleKey(input: Required<HandleInput>) {
  return `${input.dbPath}\n${input.workdir}`
}

function linuxBinding() {
  if (process.platform !== "linux") return
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined
  const isMusl = !report?.header?.glibcVersionRuntime
  if (process.arch === "x64") return isMusl ? "refs-opencode.linux-x64-musl.node" : "refs-opencode.linux-x64-gnu.node"
  if (process.arch === "arm64") return isMusl ? "refs-opencode.linux-arm64-musl.node" : "refs-opencode.linux-arm64-gnu.node"
}

function bindingName() {
  if (process.platform === "linux") return linuxBinding()
  if (process.platform === "win32" && process.arch === "x64") return "refs-opencode.win32-x64-msvc.node"
  if (process.platform === "win32" && process.arch === "arm64") return "refs-opencode.win32-arm64-msvc.node"
  if (process.platform === "darwin" && process.arch === "x64") return "refs-opencode.darwin-x64.node"
  if (process.platform === "darwin" && process.arch === "arm64") return "refs-opencode.darwin-arm64.node"
}

function loadAddon(): RefsAddon {
  if (addon) return addon
  const filename = bindingName()
  if (!filename) throw new Error(`REFS-opencode native addon is not available for ${process.platform}-${process.arch}.`)
  const candidates = [
    process.env.OPENCODE_BIN_DIR ? join(process.env.OPENCODE_BIN_DIR, filename) : undefined,
    process.execPath ? join(dirname(process.execPath), filename) : undefined,
    join(process.cwd(), filename),
  ].filter((item): item is string => !!item)
  for (const file of candidates) {
    if (!existsSync(file)) continue
    addon = require(file) as RefsAddon
    return addon
  }
  throw new Error(`REFS-opencode native addon ${filename} not found next to the opencode binary.`)
}

/**
 * Initialize the REFS MCP handle. Call once at startup.
 * Reads the same SQLite database that OpenCode uses.
 */
export function init(dbPath?: string, sessionID?: string, workdir?: string): SessionMcpHandle {
  const db = dbPath ?? Database.Path
  const sid = sessionID ?? "default"
  const dir = workdir ?? Instance.directory
  const key = handleKey({ dbPath: db, sessionID: sid, workdir: dir })
  const handle = loadAddon().createSessionMcp(db, sid, dir)
  handles.set(key, handle)
  return handle
}

/**
 * Get the current MCP handle. Initializes lazily if needed.
 */
export function getHandle(input: HandleInput = {}): SessionMcpHandle {
  const db = input.dbPath ?? Database.Path
  const sid = input.sessionID ?? "default"
  const dir = input.workdir ?? Instance.directory
  const key = handleKey({ dbPath: db, sessionID: sid, workdir: dir })
  const handle = handles.get(key)
  if (!handle) return init(db, sid, dir)
  return handle
}

/**
 * Call a tool via the embedded MCP.
 *
 * @param tool - tool name (e.g. "FileAction", "read", "rg", "exbash")
 * @param args - tool arguments
 * @param opts - optional signal/timeout/executor (signal and timeout are noted but
 *               the embedded MCP doesn't support abort yet; executor is passed through)
 */
export async function call(
  tool: string,
  args: Record<string, unknown>,
  opts?: { signal?: AbortSignal; timeout?: number; executor?: string; sessionID?: string; workdir?: string },
): Promise<Result> {
  const sessionID = opts?.sessionID ?? "default"
  const mcp = getHandle({ sessionID, workdir: opts?.workdir })

  // The MCP schema exposes this field, but OpenCode owns the value.
  const merged: Record<string, unknown> = { ExecutorSessionID: sessionID, ...args }
  merged.ExecutorSessionID = sessionID
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

  return { title: tool, metadata: {}, output: result.content?.[0]?.text ?? "" }
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
 */
export async function list(
  dir?: string,
  sessionID?: string,
): Promise<{ executors: ExecutorListItem[]; default?: string }> {
  const mcp = getHandle({ workdir: dir, sessionID })
  const parsed = JSON.parse(mcp.listExecutorsJson()) as { executors?: unknown; default?: unknown }
  const defaultExecutor = typeof parsed.default === "string" ? parsed.default : undefined
  const executors = Array.isArray(parsed.executors)
    ? parsed.executors.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return []
        const record = item as Record<string, unknown>
        if (typeof record.id !== "string") return []
        return [
          {
            id: record.id,
            ...(record.system === undefined || typeof record.system !== "string" ? {} : { system: record.system }),
            ...(record.device === undefined || typeof record.device !== "string" ? {} : { device: record.device }),
            ...(record.url === undefined || typeof record.url !== "string" ? {} : { url: record.url }),
            ...(record.labels && typeof record.labels === "object" && !Array.isArray(record.labels)
              ? { labels: record.labels as Record<string, string> }
              : {}),
            ...(record.id === defaultExecutor ? { default: true } : {}),
          } satisfies ExecutorListItem,
        ]
      })
    : []
  return { executors, ...(defaultExecutor ? { default: defaultExecutor } : {}) }
}
