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
import { ExBashTask } from "@/session/exbash"
import { SessionID } from "@/session/schema"
import { existsSync, realpathSync } from "fs"
import { dirname, join, resolve } from "path"

declare const OPENCODE_LIBC: string | undefined
declare const OPENCODE_REFS_WORKER_PATH: string | undefined

type Result = {
  title: string
  metadata: Record<string, unknown>
  output: string
}

type WorkerRequest = {
  id: number
  dbPath: string
  sessionID: string
  workdir: string
  tool: string
  args: string
}

type WorkerResponse =
  | {
      id: number
      json: string
    }
  | {
      id: number
      error: string
    }
  | {
      event: "exbash.changed"
      sessionID: string
      workspace: string
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
const pending = new Map<number, { resolve: (json: string) => void; reject: (error: Error) => void }>()
type RefsAddon = { createSessionMcp(dbPath: string, sessionID: string, workdir: string): SessionMcpHandle }
let addon: RefsAddon | undefined
let worker: Worker | undefined
let seq = 0
let idle: ReturnType<typeof setTimeout> | undefined

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
  const compiledLibc = typeof OPENCODE_LIBC === "string" ? OPENCODE_LIBC : undefined
  const isMusl =
    compiledLibc === "musl" ||
    (compiledLibc === undefined &&
      !(process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
        ?.glibcVersionRuntime)
  if (process.arch === "x64") return isMusl ? "refs-opencode.linux-x64-musl.node" : "refs-opencode.linux-x64-gnu.node"
  if (process.arch === "arm64")
    return isMusl ? "refs-opencode.linux-arm64-musl.node" : "refs-opencode.linux-arm64-gnu.node"
}

function bindingName() {
  if (process.platform === "linux") return linuxBinding()
  if (process.platform === "win32" && process.arch === "x64") return "refs-opencode.win32-x64-msvc.node"
  if (process.platform === "win32" && process.arch === "arm64") return "refs-opencode.win32-arm64-msvc.node"
  if (process.platform === "darwin" && process.arch === "x64") return "refs-opencode.darwin-x64.node"
  if (process.platform === "darwin" && process.arch === "arm64") return "refs-opencode.darwin-arm64.node"
}

function realDir(file: string | undefined) {
  if (!file) return
  try {
    return dirname(realpathSync.native(file))
  } catch {
    return
  }
}

function loadAddon(): RefsAddon {
  if (addon) return addon
  const filename = bindingName()
  if (!filename) throw new Error(`REFS-opencode native addon is not available for ${process.platform}-${process.arch}.`)
  const moduleDir = import.meta.dirname
  const binaryDirs = [
    process.env.OPENCODE_BIN_DIR,
    process.execPath ? dirname(process.execPath) : undefined,
    realDir(process.execPath),
  ]
  const candidates = Array.from(
    new Set(
      [
        ...binaryDirs.map((dir) => (dir ? join(dir, filename) : undefined)),
        join(process.cwd(), filename),
        join(process.cwd(), "../REFS-opencode", filename),
        join(process.cwd(), "packages/REFS-opencode", filename),
        moduleDir ? resolve(moduleDir, "../../../REFS-opencode", filename) : undefined,
      ].filter((item): item is string => !!item),
    ),
  )
  for (const file of candidates) {
    if (!existsSync(file)) continue
    addon = require(file) as RefsAddon
    return addon
  }
  throw new Error(`REFS-opencode native addon ${filename} not found. Checked: ${candidates.join(", ")}`)
}

function workerTarget() {
  if (typeof OPENCODE_REFS_WORKER_PATH !== "undefined") return OPENCODE_REFS_WORKER_PATH
  return new URL("./refs-worker.ts", import.meta.url)
}

function clearIdle() {
  if (!idle) return
  clearTimeout(idle)
  idle = undefined
}

function scheduleIdle() {
  if (pending.size > 0) return
  clearIdle()
  idle = setTimeout(() => {
    worker?.terminate()
    worker = undefined
    idle = undefined
  }, 1000)
  const timer = idle as ReturnType<typeof setTimeout> & { unref?: () => void }
  timer.unref?.()
}

function refsWorker() {
  if (worker) {
    clearIdle()
    return worker
  }
  worker = new Worker(workerTarget())
  const ref = worker as Worker & { unref?: () => void }
  ref.unref?.()
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    if ("event" in event.data) {
      if (event.data.event === "exbash.changed") {
        void ExBashTask.refresh({
          sessionID: SessionID.zod.parse(event.data.sessionID),
          workspace: event.data.workspace,
        }).catch(() => undefined)
      }
      return
    }
    const item = pending.get(event.data.id)
    if (!item) return
    pending.delete(event.data.id)
    if ("error" in event.data) {
      item.reject(new Error(event.data.error))
      scheduleIdle()
      return
    }
    item.resolve(event.data.json)
    scheduleIdle()
  }
  worker.onerror = (event) => {
    const error = new Error(event.message)
    for (const item of pending.values()) item.reject(error)
    pending.clear()
    worker = undefined
    clearIdle()
  }
  return worker
}

export function callToolAsync(input: {
  dbPath?: string
  sessionID: string
  workdir: string
  tool: string
  argsJson: string
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    try {
      refsWorker().postMessage({
        id,
        dbPath: input.dbPath ?? Database.Path,
        sessionID: input.sessionID,
        workdir: input.workdir,
        tool: input.tool,
        args: input.argsJson,
      } satisfies WorkerRequest)
    } catch (error) {
      pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
      scheduleIdle()
    }
  })
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
