import z from "zod"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { ExBashTask } from "@/session/exbash"
import { Tool } from "./tool"
import { ask, collect, parse, resolvePath } from "./bash"
import { assertExternalDirectory } from "./external-directory"
import { RemoteExecutor } from "./remote_executor"

const EXECUTOR = "local"
const LIMIT = 5
const ms = z.preprocess((value) => (value === "" ? undefined : value), z.number().optional())

const parameters = z.object({
  mode: z
    .enum(["run", "list", "attach", "stop", "remove"])
    .optional()
    .describe("Operation mode. Omit or use run to start a command; use attach to send input/read a PTY snapshot; use stop/remove to manage a task."),
  command: z
    .string()
    .optional()
    .describe("Use for run mode. Command argv string parsed by REC without an implicit shell. Use an explicit shell such as bash -lc '...' for pipes, redirects, variables, or other shell syntax."),
  description: z.string().optional().describe("Use for run mode. Clear, concise description of what this command does."),
  workdir: z.string().optional().describe("Use for run mode. Working directory. Defaults to the current opencode directory."),
  executor: z.string().optional().describe("RemoteExecutor executor id. Defaults to local."),
  timeout: ms.describe("Use for run mode. Optional total runtime limit in milliseconds. Leave empty to use REC's default behavior: no total runtime limit."),
  scope: z.enum(["local", "workspace"]).optional().describe("Use for run and list modes. Defaults to local."),
  read_timeout: ms.describe("Use for run and attach modes. Optional read wait in milliseconds. Leave empty to use REC's default read wait. Use 0 to detach/read immediately."),
  asyncID: z.string().optional().describe("Use for list, attach, stop, and remove modes."),
  text: z.string().optional().describe("Use for attach mode. Text to write to the running PTY before reading a snapshot. REC parses escape sequences in text; if escaping is awkward or fails, put the input in a text file and use filePath instead."),
  filePath: z.string().optional().describe("Use for attach mode. Text file path whose bytes are written to the running PTY before reading a snapshot. Prefer this when text input needs exact bytes or would require difficult escaping."),
})

function clean(input: unknown): unknown {
  if (typeof input === "string" && input.trim() === "") return undefined
  if (Array.isArray(input)) return input.map(clean)
  if (input && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, clean(value)]).filter(([, value]) => value !== undefined))
  }
  return input
}

function shell() {
  if (process.platform === "win32") return { file: "powershell.exe", name: "powershell" }
  return { file: "bash", name: "bash" }
}

function workspace(ctx: Tool.Context) {
  return Filesystem.resolve(ctx.directory ?? Instance.directory)
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function local(executor?: string) {
  return (executor?.trim() || EXECUTOR) === EXECUTOR
}

function num(value: unknown) {
  return typeof value === "number" ? value : undefined
}

function wait(input: { read_timeout?: number; timeout?: number }) {
  if (input.read_timeout !== undefined && input.read_timeout !== 0) return input.read_timeout
  if (input.timeout !== undefined && input.timeout !== 0) return input.timeout
  if (input.read_timeout !== undefined) return input.read_timeout
  return input.timeout
}

function rec(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function arr(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const obj = rec(item)
    return obj ? [obj] : []
  })
}

function kind(item: ExBashTask.Info) {
  if (item.state === "running") return "running"
  return "other"
}

function reason(items: ExBashTask.Info[], next?: { scope?: ExBashTask.Scope; kind: ReturnType<typeof kind> }) {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(`${item.scope}\0${kind(item)}`, (counts.get(`${item.scope}\0${kind(item)}`) ?? 0) + 1)
  if (next) counts.set(`${next.scope ?? "local"}\0${next.kind}`, (counts.get(`${next.scope ?? "local"}\0${next.kind}`) ?? 0) + 1)
  const hit = [...counts.entries()].find(([, count]) => count > LIMIT)
  if (!hit) return
  const [scope, type] = hit[0].split("\0")
  return `Too many ${type} exbash tasks in ${scope} scope (${hit[1]}/${LIMIT}). Each local/workspace scope keeps at most ${LIMIT} running and ${LIMIT} other tasks across all executors. Remove stopped or stale tasks with {"mode":"remove","asyncID":"..."}. Unknown tasks are stale records from tasks that were not shut down normally; remove them, or restart/re-run the task if needed.`
}

function merge(base: ExBashTask.Info, hit?: Record<string, unknown>): ExBashTask.Info {
  if (!hit) return base
  const state = ExBashTask.State.safeParse(hit.state).success ? (hit.state as ExBashTask.State) : base.state
  return {
    ...base,
    pid: num(hit.pid),
    totalOutput: num(hit.totalOutput) ?? base.totalOutput,
    state,
    exitCode: num(hit.exitCode) ?? base.exitCode,
    command: base.command,
    description: base.description,
    cwd: base.cwd,
    startedAt: base.startedAt,
    endedAt: base.endedAt ?? num(hit.endedAt),
    error: text(hit.error) ?? base.error,
  } as ExBashTask.Info
}

async function save(ctx: Tool.Context, result: { metadata: Record<string, unknown> }, input: { command: string; description?: string; cwd: string; scope?: ExBashTask.Scope; executor?: string }) {
  const id = text(result.metadata.asyncID)
  if (!id) return
  return ExBashTask.start({
    asyncID: id,
    sessionID: ctx.sessionID,
    workspace: workspace(ctx),
    scope: input.scope ?? "local",
    executor: input.executor ?? EXECUTOR,
    description: text(result.metadata.description) ?? input.description ?? input.command,
    command: text(result.metadata.command) ?? input.command,
    cwd: text(result.metadata.cwd) ?? input.cwd,
    ...(num(result.metadata.pid) === undefined ? {} : { pid: num(result.metadata.pid) }),
    ...(num(result.metadata.totalOutput) === undefined ? {} : { totalOutput: num(result.metadata.totalOutput) }),
    startedAt: num(result.metadata.startedAt) ?? Date.now(),
  })
}

async function sync(item: ExBashTask.Info, hit?: Record<string, unknown>) {
  if (!hit) return ExBashTask.lost({ executor: item.executor, asyncID: item.asyncID }).then((next) => next ?? item)
  const next = merge(item, hit)
  if (next.state === "stopped") {
    return (await ExBashTask.finish({
      asyncID: next.asyncID,
      executor: next.executor,
      exitCode: next.exitCode ?? -1,
      endedAt: next.endedAt ?? Date.now(),
      totalOutput: next.totalOutput,
      error: next.error,
    })) ?? next
  }
  return next
}

async function done(item: ExBashTask.Info, hit?: Record<string, unknown>) {
  const next = merge(item, hit)
  return (await ExBashTask.finish({
    asyncID: next.asyncID,
    executor: next.executor,
    exitCode: next.exitCode ?? -1,
    endedAt: next.endedAt ?? Date.now(),
    totalOutput: next.totalOutput,
    error: next.error,
  })) ?? next
}

function failure(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function known(ctx: Tool.Context, input?: { asyncID?: string; scope?: ExBashTask.Scope; executor?: string }) {
  return (await ExBashTask.get({ sessionID: ctx.sessionID, workspace: workspace(ctx) })).filter(
    (item) =>
      (!input?.asyncID || item.asyncID === input.asyncID) &&
      (!input?.scope || item.scope === input.scope) &&
      item.executor === (input?.executor ?? EXECUTOR),
  )
}

async function guard(ctx: Tool.Context, input: { scope?: ExBashTask.Scope; kind?: ReturnType<typeof kind> }) {
  const items = await ExBashTask.get({ sessionID: ctx.sessionID, workspace: workspace(ctx) })
  const msg = reason(items, input.kind ? { scope: input.scope, kind: input.kind } : undefined)
  if (msg) throw new Error(msg)
}

async function gate(ctx: Tool.Context) {
  const exec = shell()
  await ctx.ask({
    permission: "exbash_executor",
    patterns: [exec.name],
    always: [exec.name],
    metadata: {
      executor: exec.name,
      file: exec.file,
    },
  })
  return exec
}

async function cwd(dir: string | undefined, exec: string) {
  if (!dir) return Instance.directory
  return resolvePath(dir, Instance.directory, exec)
}

async function command(ctx: Tool.Context, input: { command: string; workdir?: string }) {
  const exec = await gate(ctx)
  const dir = await cwd(input.workdir, exec.file)
  const ps = exec.name === "powershell"
  const root = await parse(input.command, ps)
  const scan = await collect(root, dir, ps, exec.file)
  if (!Instance.containsPath(dir)) scan.dirs.add(dir)
  await ask(ctx, scan)
  return dir
}

async function input(ctx: Tool.Context, file: string) {
  const next = await resolvePath(file, Instance.directory, shell().file)
  await assertExternalDirectory(ctx, next, { kind: "file" })
  return next
}

export const ExBashTool = Tool.define("exbash", {
  description: [
    "Extended PTY command control surface backed by RemoteExecutor.",
    "- mode omitted or mode=run: start a command and read output for read_timeout ms before returning. Use read_timeout=0 to detach immediately.",
    "- run commands are parsed by REC as argv and are not wrapped in an implicit shell. For shell syntax like pipes, redirects, variables, cd, or compound commands, explicitly run a shell, for example: bash -lc 'echo hi | cat'.",
    "- mode=list: list REC exbash runs known to this opencode session/workspace, optionally filtered by asyncID or scope.",
    "- mode=attach: write text or text-file bytes to a running PTY, wait read_timeout ms, and return a plain-text PTY snapshot. text is escape-parsed by REC; if text escaping is problematic, write the input to a text file and pass filePath.",
    "- mode=stop: stop a running task by asyncID.",
    "- mode=remove: remove a stopped or stale task by asyncID; remove also clears stale unknown records locally.",
    "- executor selects a configured RemoteExecutor executor. Omit it to use local.",
    "- timeout and read_timeout are optional. Leave them empty for REC defaults. Use read_timeout=0 to return immediately after starting or attaching.",
    "Examples:",
    '- run foreground-ish: {"command":"echo hello","description":"Print hello"}',
    '- run shell syntax explicitly: {"command":"bash -lc \'echo hello | cat\'","description":"Print through a shell pipe"}',
    '- detach immediately: {"command":"sleep 20","description":"Wait in PTY","read_timeout":0}',
    '- list: {"mode":"list"}',
    '- attach: {"mode":"attach","asyncID":"<asyncID>","text":"hello\\n","read_timeout":1000}',
    '- stop: {"mode":"stop","asyncID":"<asyncID>"}',
    '- remove: {"mode":"remove","asyncID":"<asyncID>"}',
  ].join("\n"),
  parameters,
  async execute(args, ctx): Promise<{ title: string; metadata: Record<string, unknown>; output: string }> {
    const arg = clean(args) as z.infer<typeof parameters>
    const mode = arg.mode ?? "run"

    if (mode === "run") {
      const data = z
        .object({
          command: z.string(),
          description: z.string().optional(),
          workdir: z.string().optional(),
          executor: z.string().optional(),
          timeout: z.number().optional(),
          read_timeout: z.number().optional(),
          scope: z.enum(["local", "workspace"]).optional(),
        })
        .parse(arg)
      const exec = data.executor?.trim() || EXECUTOR
      await guard(ctx, { scope: data.scope, kind: "running" })
      const dir = local(exec) ? await command(ctx, data) : await cwd(data.workdir, shell().file)
      const result = await RemoteExecutor.call(
        "exbash",
        {
          command: data.command,
          ...(data.description === undefined ? {} : { description: data.description }),
          ...(local(exec) ? {} : { executor: exec }),
          ...(data.timeout === undefined ? {} : { timeout: data.timeout }),
          ...(data.read_timeout === undefined ? {} : { read_timeout: data.read_timeout }),
          directory: dir,
        },
        { signal: ctx.abort },
      )
      const task = await save(ctx, result, { ...data, cwd: dir })
      if (!task) return result
      return {
        ...result,
        metadata: task,
      }
    }

    if (mode === "list") {
      const data = z.object({ asyncID: z.string().optional(), scope: z.enum(["local", "workspace"]).optional(), executor: z.string().optional() }).parse(arg)
      const exec = data.executor?.trim() || EXECUTOR
      if (local(exec)) {
        await ctx.ask({
          permission: "bash",
          patterns: [data.asyncID ? `exbash list ${data.asyncID}` : "exbash list"],
          always: ["exbash list *"],
          metadata: {},
        })
      }
      const result = await RemoteExecutor.call(
        "exbash_list",
        { ...(local(exec) ? {} : { executor: exec }), ...(data.asyncID === undefined ? {} : { asyncID: data.asyncID }) },
        { signal: ctx.abort },
      )
      const remote = arr(result.metadata.runs)
      const map = new Map(remote.map((item) => [text(item.asyncID), item]))
      const list = await known(ctx, { ...data, executor: exec })
      const ids = new Set(list.map((item) => item.asyncID))
      const runs = await Promise.all(list.map((item) => sync(item, map.get(item.asyncID))))
      const untracked = local(exec) || data.scope !== undefined
        ? []
        : remote.flatMap((item) => {
            const id = text(item.asyncID)
            return id && !ids.has(id) ? [{ ...item, executor: exec, tracked: false }] : []
          })
      const note = `unknown tasks are stale records from tasks that were not shut down normally; remove them, or restart/re-run the task if needed. Each local/workspace scope keeps at most ${LIMIT} running and ${LIMIT} other tasks across all executors. Remote executor probing reports untracked REC PTYs without binding them to opencode tasks.`
      return { title: "Async runs listed", metadata: { runs, untracked, note }, output: JSON.stringify({ note, runs, untracked }, null, 2) }
    }

    if (mode === "attach") {
      const data = z
        .object({
          asyncID: z.string(),
          executor: z.string().optional(),
          text: z.string().optional(),
          filePath: z.string().optional(),
          read_timeout: z.number().optional(),
          timeout: z.number().optional(),
        })
        .parse(arg)
      if (data.text !== undefined && data.filePath !== undefined) throw new Error("Provide only one of text or filePath for attach mode")
      const read_timeout = wait(data)
      const exec = data.executor?.trim() || EXECUTOR
      if (local(exec)) {
        await ctx.ask({
          permission: "bash",
          patterns: [`exbash attach ${data.asyncID}`],
          always: ["exbash attach *"],
          metadata: {},
        })
      }
      const task = await ExBashTask.one({ sessionID: ctx.sessionID, workspace: workspace(ctx), executor: exec, asyncID: data.asyncID })
      if (!task && local(exec)) throw new Error(`Async run not found: ${data.asyncID}`)
      if (task?.state === "unknown") throw new Error(`Async run state unknown: ${data.asyncID}`)
      const result = await RemoteExecutor.call(
        "exbash_attach",
        {
          asyncID: data.asyncID,
          ...(local(exec) ? {} : { executor: exec }),
          ...(data.text === undefined ? {} : { text: data.text }),
          ...(data.filePath === undefined ? {} : { filePath: local(exec) ? await input(ctx, data.filePath) : data.filePath }),
          ...(read_timeout === undefined ? {} : { read_timeout }),
          directory: workspace(ctx),
        },
        { signal: ctx.abort },
      )
      if (task) {
        await sync(task, result.metadata)
        return result
      }
      return {
        ...result,
        metadata: { ...result.metadata, asyncID: data.asyncID, executor: exec, tracked: false },
      }
    }

    const data = z.object({ mode: z.enum(["stop", "remove"]), asyncID: z.string(), executor: z.string().optional() }).parse(arg)
    const exec = data.executor?.trim() || EXECUTOR
    if (local(exec)) {
      await ctx.ask({
        permission: "bash",
        patterns: [`exbash ${data.mode} ${data.asyncID}`],
        always: [`exbash ${data.mode} *`],
        metadata: {},
      })
    }
    const task = await ExBashTask.one({ sessionID: ctx.sessionID, workspace: workspace(ctx), executor: exec, asyncID: data.asyncID })
    if (!task && !local(exec) && data.mode === "stop") {
      const result = await RemoteExecutor.call("exbash_stop", { asyncID: data.asyncID, executor: exec }, { signal: ctx.abort })
      const next = { ...result.metadata, asyncID: data.asyncID, executor: exec, tracked: false }
      return {
        title: "Async run stopped",
        metadata: next,
        output: JSON.stringify(next, null, 2),
      }
    }
    if (!task) throw new Error(`Async run not found: ${data.asyncID}`)
    if (data.mode === "remove" && task.state === "unknown") {
      await ExBashTask.remove({ sessionID: ctx.sessionID, workspace: workspace(ctx), executor: exec, asyncID: data.asyncID })
      return {
        title: "Async run removed",
        metadata: { asyncID: data.asyncID, executor: task.executor, state: task.state, removed: true },
        output: JSON.stringify({ asyncID: data.asyncID, state: task.state, removed: true }, null, 2),
      }
    }
    if (task.state === "unknown") throw new Error(`Async run state unknown: ${data.asyncID}`)
    let result: { title: string; metadata: Record<string, unknown>; output: string } | undefined
    try {
      result = await RemoteExecutor.call(
        data.mode === "stop" ? "exbash_stop" : "exbash_remove",
        { asyncID: data.asyncID, ...(local(exec) ? {} : { executor: exec }) },
        { signal: ctx.abort },
      )
    } catch (error) {
      if (data.mode !== "remove" || task.state === "running") throw error
      await ExBashTask.remove({ sessionID: ctx.sessionID, workspace: workspace(ctx), executor: exec, asyncID: data.asyncID })
      const next = { asyncID: data.asyncID, executor: exec, state: task.state, removed: true, remoteError: failure(error) }
      return {
        title: "Async run removed",
        metadata: next,
        output: JSON.stringify(next, null, 2),
      }
    }
    if (data.mode === "remove") {
      await ExBashTask.remove({ sessionID: ctx.sessionID, workspace: workspace(ctx), executor: exec, asyncID: data.asyncID })
      const next = { asyncID: data.asyncID, executor: exec, removed: true }
      return {
        title: "Async run removed",
        metadata: next,
        output: JSON.stringify(next, null, 2),
      }
    }
    const next = await done(task, result.metadata)
    return {
      title: "Async run stopped",
      metadata: next,
      output: JSON.stringify(next, null, 2),
    }
  },
})
