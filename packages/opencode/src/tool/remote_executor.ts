import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"

export namespace RemoteExecutor {
  const log = Log.create({ service: "remote.executor" })

  export const Scope = z.enum(["workspace", "user"])
  export type Scope = z.infer<typeof Scope>

  export const Info = z
    .object({
      id: z
        .string()
        .trim()
        .min(1)
        .regex(/^[A-Za-z0-9._-]+$/, "executor id may only contain letters, numbers, dot, underscore, and dash"),
      url: z.string().trim().min(1),
      system: z.string().optional(),
      device: z.string().optional(),
      labels: z.record(z.string(), z.string()).optional(),
    })
    .strict()
  export type Info = z.infer<typeof Info>

  const Reinfos = z
    .object({
      executors: z.array(Info).default([]),
    })
    .strict()
  export type Reinfos = z.infer<typeof Reinfos>

  export type View = Info & { scope: Scope | "builtin"; readonly?: boolean; connected: boolean }
  export type List = {
    default: "local"
    bridge: { running: boolean }
    userFile: string
    workspaceFile: string
    user: View[]
    workspace: View[]
    executors: View[]
  }

  type Result = {
    title: string
    metadata: Record<string, unknown>
    output: string
  }

  export const FileStamp = z.object({
    fileKey: z.string(),
    canonicalPath: z.string(),
    kind: z.enum(["file", "directory", "missing", "other"]),
    size: z.number().optional(),
    mtimeMs: z.number().optional(),
  })
  export type FileStamp = z.infer<typeof FileStamp>

  type Pending = {
    resolve(result: unknown): void
    reject(error: Error): void
    timer: NodeJS.Timeout
    abort?: () => void
  }

  type State = {
    key: string
    child: ChildProcessWithoutNullStreams
    buf: string
    seq: number
    pending: Map<number, Pending>
    connected: Map<string, string>
    ready: Promise<void>
  }

  type Cfg = {
    command: string[]
    cwd?: string
    environment?: Record<string, string>
    timeout: number
  }

  let state: State | undefined

  export async function enabled() {
    return (await Config.get()).experimental?.remote_executor?.enabled !== false
  }

  export async function call(
    tool: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeout?: number; executor?: string },
  ): Promise<Result> {
    const cfg = await config()
    if (!cfg) throw new Error("Remote executor is not enabled")
    const timeout = opts?.timeout ?? cfg.timeout
    const executor = target(args, opts?.executor)
    const dir = directory(args, executor)
    const proc = start(cfg)
    await proc.ready
    if (executor !== "local") await ensure(proc, Instance.directory, executor, timeout)
    const result = await request(
      proc,
      "tools/call",
      {
        name: tool,
        arguments: argsWithDir(args, timeout, executor, dir),
      },
      timeout,
      opts?.signal,
    )
    return output(tool, result)
  }

  export async function stat(filePath: string, executor = "local") {
    return stamp((await call("stat", { filePath, ...(executor === "local" ? {} : { executor }) })).metadata.file)
  }

  export function stamp(value: unknown) {
    const result = FileStamp.safeParse(value)
    return result.success ? result.data : undefined
  }

  export async function reload(dir = Instance.directory) {
    const cfg = await config()
    if (!cfg) throw new Error("Remote executor is not enabled")
    stop()
    const proc = start(cfg)
    await proc.ready
    for (const item of (await list(dir)).executors) {
      if (item.scope === "builtin") continue
      await connect(proc, item, cfg.timeout, true)
    }
    const result = await request(proc, "tools/call", { name: "list_executor", arguments: {} }, cfg.timeout)
    return output("list_executor", result)
  }

  export async function reconnect(dir = Instance.directory, id: string) {
    const target = id.trim()
    if (!target) throw new Error("id is required for reconnect")
    const items = (await list(dir)).executors.filter((item) => item.scope !== "builtin" && item.id === target)
    if (target && target !== "local" && items.length === 0) throw new Error(`executor not configured for this workspace: ${target}`)
    const cfg = await config()
    if (!cfg) throw new Error("Remote executor is not enabled")
    const proc = start(cfg)
    await proc.ready
    if (target === "local") {
      const result = await request(proc, "tools/call", { name: "list_executor", arguments: {} }, cfg.timeout)
      return output("list_executor", result)
    }
    for (const item of items) await connect(proc, item, cfg.timeout, true)
    const result = await request(proc, "tools/call", { name: "list_executor", arguments: {} }, cfg.timeout)
    return output("list_executor", result)
  }

  export async function list(dir = Instance.directory): Promise<List> {
    const paths = files(dir)
    const [user, workspace] = await Promise.all([load(paths.userFile), load(paths.workspaceFile)])
    const stat = current()
    const usr = user.executors.map((item) => view(item, "user", stat.ids.has(item.id)))
    const wks = workspace.executors.map((item) => view(item, "workspace", stat.ids.has(item.id)))
    const map = new Map<string, View>()
    usr.forEach((item) => map.set(item.id, item))
    wks.forEach((item) => map.set(item.id, item))
    return {
      default: "local",
      bridge: { running: stat.running },
      userFile: paths.userFile,
      workspaceFile: paths.workspaceFile,
      user: sort(usr),
      workspace: sort(wks),
      executors: [local(stat.ids.has("local")), ...sort([...map.values()])],
    }
  }

  export async function save(scope: Scope, value: Reinfos, dir = Instance.directory) {
    await store(file(scope, dir), value.executors)
  }

  export async function upsert(scope: Scope, value: Info, dir = Instance.directory) {
    const target = file(scope, dir)
    const data = await load(target)
    await store(target, [...data.executors.filter((item) => item.id !== value.id), value])
  }

  export async function remove(scope: Scope, id: string, dir = Instance.directory) {
    const next = id.trim()
    if (next === "local") throw new Error("local executor is built in and cannot be removed")
    const target = file(scope, dir)
    const data = await load(target)
    await store(target, data.executors.filter((item) => item.id !== next))
  }

  export function files(dir = Instance.directory) {
    const root = path.resolve(dir || Instance.directory)
    return {
      userFile: path.join(Global.Path.home, ".opencode", "remote_executor_infos.json"),
      workspaceFile: path.join(root, ".opencode", "remote_executor_infos.json"),
    }
  }

  export function patch(file: string, before: string, after: string, exists: boolean) {
    const name = rel(file)
    const lines = ["*** Begin Patch"]
    if (!exists) {
      lines.push(`*** Add File: ${name}`)
      lines.push(...split(after).map((line) => `+${line}`))
      lines.push("*** End Patch")
      return lines.join("\n")
    }
    lines.push(`*** Update File: ${name}`)
    lines.push("@@")
    lines.push(...split(before).map((line) => `-${line}`))
    lines.push(...split(after).map((line) => `+${line}`))
    lines.push("*** End Patch")
    return lines.join("\n")
  }

  async function config(): Promise<Cfg | undefined> {
    const cfg = (await Config.get()).experimental?.remote_executor ?? {}
    if (cfg?.enabled === false) return
    return {
      command: cfg.command?.length ? cfg.command : [bin()],
      cwd: cfg.cwd ?? process.cwd(),
      environment: cfg.environment,
      timeout: cfg.timeout ?? 30_000,
    }
  }

  function bin() {
    const env = process.env.OPENCODE_REMOTE_EXECUTOR_BIN
    if (env) return env
    const exe = process.platform === "win32" ? "remote-caller-mcp.exe" : "remote-caller-mcp"
    const names = [`.${exe}`, exe]
    const roots = [process.env.OPENCODE_BIN_DIR, path.dirname(process.execPath), real(process.execPath)]
      .flatMap((file) => (file ? [file] : []))
      .filter((item, index, all) => all.indexOf(item) === index)
    const hit = roots.flatMap((root) => names.map((name) => path.join(root, name))).find((file) => fs.existsSync(file))
    return hit ?? exe
  }

  function real(file: string) {
    try {
      return path.dirname(fs.realpathSync.native(file))
    } catch {
      return undefined
    }
  }

  function rel(file: string) {
    const target = path.relative(Instance.directory, file).replaceAll("\\", "/")
    if (target && !target.startsWith("..") && !path.isAbsolute(target)) return target
    return file
  }

  function split(text: string) {
    const next = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    if (!next) return []
    return next.endsWith("\n") ? next.slice(0, -1).split("\n") : next.split("\n")
  }

  function directory(args: Record<string, unknown>, executor = "local") {
    const dir = typeof args.dir === "string" ? args.dir : typeof args.directory === "string" ? args.directory : Instance.directory
    if (executor !== "local") return dir
    return path.resolve(dir)
  }

  function target(args: Record<string, unknown>, executor?: string) {
    const next = executor ?? (typeof args.executor === "string" ? args.executor : typeof args.targetExecutor === "string" ? args.targetExecutor : undefined)
    return next?.trim() || "local"
  }

  function argsWithDir(args: Record<string, unknown>, timeout: number, executor: string, dir: string) {
    const { dir: _, directory: _dir, executor: _exec, targetExecutor: _target, toolTimeoutMs: _timeout, ...rest } = args
    return {
      ...rest,
      directory: dir,
      targetExecutor: executor,
      toolTimeoutMs: typeof args.toolTimeoutMs === "number" ? args.toolTimeoutMs : timeout,
    }
  }

  async function ensure(state: State, dir: string, id: string, timeout: number) {
    const item = (await list(dir)).executors.find((item) => item.id === id)
    if (!item || item.scope === "builtin") throw new Error(`executor not configured for this workspace: ${id}`)
    await connect(state, item, timeout)
  }

  async function connect(state: State, item: Info, timeout: number, force = false) {
    const key = signature(item)
    if (!force && state.connected.get(item.id) === key) return
    try {
      const result = await request(
        state,
        "tools/call",
        {
          name: "connect_to_executor",
          arguments: clean(item),
        },
        timeout,
      )
      output("connect_to_executor", result)
      if (force) await verify(state, item, timeout)
      state.connected.set(item.id, key)
    } catch (error) {
      throw new Error(`failed to connect executor ${item.id} (${item.url}): ${message(error)}`)
    }
  }

  async function verify(state: State, item: Info, timeout: number) {
    const result = await request(
      state,
      "tools/call",
      {
        name: "exbash_list",
        arguments: {
          targetExecutor: item.id,
          toolTimeoutMs: timeout,
        },
      },
      timeout,
    )
    output("exbash_list", result)
  }

  function start(cfg: Cfg) {
    const key = JSON.stringify({ command: cfg.command, cwd: cfg.cwd, environment: cfg.environment })
    if (state?.key === key && !state.child.killed) return state
    stop()

    const child = spawn(cfg.command[0]!, cfg.command.slice(1), {
      cwd: cfg.cwd,
      env: {
        ...process.env,
        ...cfg.environment,
      },
      stdio: "pipe",
    })
    const next: State = {
      key,
      child,
      buf: "",
      seq: 0,
      pending: new Map(),
      connected: new Map(),
      ready: Promise.resolve(),
    }
    state = next

    child.stdout.on("data", (chunk) => receive(next, chunk.toString()))
    child.stderr.on("data", (chunk) => log.info(chunk.toString().trimEnd()))
    child.on("error", (error) => fail(next, error))
    child.on("exit", (code, signal) => {
      fail(next, new Error(`remote executor exited: ${signal ?? code ?? "unknown"}`))
      if (state === next) state = undefined
    })

    next.ready = request(next, "initialize", {}, cfg.timeout).then(() => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n")
    })
    return next
  }

  function stop() {
    if (!state) return
    fail(state, new Error("remote executor restarted"))
    state.child.kill()
    state = undefined
  }

  function request(state: State, method: string, params: unknown, timeout: number, signal?: AbortSignal) {
    const id = ++state.seq
    return new Promise<unknown>((resolve, reject) => {
      const clear = () => {
        state.pending.delete(id)
        clearTimeout(timer)
        if (abort) signal?.removeEventListener("abort", abort)
      }
      const timer = setTimeout(() => {
        clear()
        reject(new Error(`remote executor ${method} timed out after ${timeout}ms`))
      }, timeout)
      timer.unref?.()
      const abort = signal
        ? () => {
            clear()
            reject(new Error(`remote executor ${method} aborted`))
          }
        : undefined
      if (signal?.aborted) return abort?.()
      signal?.addEventListener("abort", abort!, { once: true })
      state.pending.set(id, {
        resolve: (result) => {
          clear()
          resolve(result)
        },
        reject: (error) => {
          clear()
          reject(error)
        },
        timer,
        abort,
      })
      state.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
        if (!error) return
        const item = state.pending.get(id)
        if (!item) return
        item.reject(error)
      })
    })
  }

  function receive(state: State, text: string) {
    state.buf += text
    const lines = state.buf.split(/\r?\n/)
    state.buf = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch (error) {
        log.error("failed to parse remote executor output", { line, error })
        continue
      }
      const obj = record(msg)
      const id = typeof obj?.id === "number" ? obj.id : undefined
      if (id === undefined) continue
      const item = state.pending.get(id)
      if (!item) continue
      if (obj?.error) {
        const err = record(obj.error)
        item.reject(new Error(typeof err?.message === "string" ? err.message : JSON.stringify(obj.error)))
        continue
      }
      item.resolve(obj?.result)
    }
  }

  function fail(state: State, error: Error) {
    for (const item of state.pending.values()) item.reject(error)
    state.pending.clear()
  }

  function output(tool: string, result: unknown): Result {
    const obj = record(result) ?? {}
    if (obj.isError) throw new Error(text(obj.content) || `remote executor ${tool} failed`)
    const data = record(obj.structuredContent) ?? {}
    return {
      title: typeof data.title === "string" ? data.title : tool,
      metadata: record(data.metadata) ?? {},
      output: typeof data.output === "string" ? data.output : text(obj.content),
    }
  }

  async function load(file: string): Promise<Reinfos> {
    let raw = ""
    try {
      raw = await fsp.readFile(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { executors: [] }
      throw new Error(`failed to read executor info ${file}: ${message(error)}`)
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (error) {
      throw new Error(`invalid executor info JSON in ${file}: ${message(error)}`)
    }
    const parsed = Reinfos.safeParse(Array.isArray(json) ? { executors: json } : json)
    if (!parsed.success) throw new Error(`invalid executor info in ${file}:\n${issues(parsed.error)}`)
    check(file, parsed.data.executors)
    return parsed.data
  }

  async function store(file: string, executors: Info[]) {
    const next = executors.map((item) => Info.parse(item))
    check(file, next)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, JSON.stringify({ executors: sort(next) }, null, 2) + "\n")
  }

  function check(file: string, executors: Info[]) {
    const ids = new Set<string>()
    for (const item of executors) {
      if (item.id === "local") throw new Error(`invalid executor info in ${file}: local executor is built in and cannot be configured`)
      if (ids.has(item.id)) throw new Error(`invalid executor info in ${file}: duplicate executor id ${item.id}`)
      ids.add(item.id)
    }
  }

  function file(scope: Scope, dir: string) {
    const paths = files(dir)
    return scope === "user" ? paths.userFile : paths.workspaceFile
  }

  function current() {
    if (!state || state.child.killed) return { running: false, ids: new Set<string>() }
    return { running: true, ids: new Set(["local", ...state.connected.keys()]) }
  }

  function local(connected: boolean): View {
    return { id: "local", url: "local", scope: "builtin", readonly: true, connected }
  }

  function view(item: Info, scope: Scope, connected: boolean): View {
    return { ...item, scope, connected }
  }

  function sort<T extends { id: string }>(items: T[]) {
    return items.toSorted((a, b) => a.id.localeCompare(b.id))
  }

  function signature(item: Info) {
    return JSON.stringify(clean(item))
  }

  function clean(item: Info) {
    const labels = item.labels ? Object.fromEntries(Object.entries(item.labels).sort(([a], [b]) => a.localeCompare(b))) : undefined
    return {
      id: item.id,
      url: item.url,
      ...(item.system === undefined ? {} : { system: item.system }),
      ...(item.device === undefined ? {} : { device: item.device }),
      ...(labels === undefined ? {} : { labels }),
    }
  }

  function issues(error: z.ZodError) {
    return error.issues.map((issue) => `=> ${addr(issue)}: ${issue.message}`).join("\n")
  }

  function addr(issue: z.ZodIssue) {
    if (!issue.path.length) return "$"
    return issue.path.map((part) => String(part)).join(".")
  }

  function message(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }

  function record(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    return value as Record<string, unknown>
  }

  function text(value: unknown) {
    if (!Array.isArray(value)) return ""
    return value
      .map((item) => {
        const obj = record(item)
        if (obj?.type !== "text" || typeof obj.text !== "string") return
        return obj.text
      })
      .filter((item): item is string => typeof item === "string")
      .join("\n")
  }
}
