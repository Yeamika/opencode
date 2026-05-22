import z from "zod"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { ExBashTask } from "@/session/exbash"
import { Tool } from "./tool"
import { ask, collect, parse, resolvePath } from "./bash"
import { assertExternalDirectory } from "./external-directory"
import { RemoteExecutor } from "./remote_executor"

const EXECUTOR = "local"

const parameters = z.object({
  mode: z
    .enum(["run", "list", "attach", "control"])
    .optional()
    .describe("Operation mode. Omit or use run to start a command; use attach to send input/read a PTY snapshot."),
  command: z.string().optional().describe("Use for run mode. The shell command to execute."),
  description: z.string().optional().describe("Use for run mode. Clear, concise description of what this command does."),
  workdir: z.string().optional().describe("Use for run mode. Working directory. Defaults to the current opencode directory."),
  executor: z.string().optional().describe("RemoteExecutor executor id. Defaults to local."),
  timeout: z.number().optional().describe("Use for run mode. Passed through to REC. Omit to use REC default."),
  scope: z.enum(["local", "workspace"]).optional().describe("Use for run and list modes. Defaults to local."),
  read_timeout: z
    .number()
    .optional()
    .describe("Use for run and attach modes. Passed through to REC. Use 0 to detach immediately. Omit to use REC default."),
  asyncID: z.string().optional().describe("Use for list, attach, and control modes."),
  action: z.enum(["stop", "remove"]).optional().describe("Use for control mode."),
  text: z.string().optional().describe("Use for attach mode. Text to write to the running PTY before reading a snapshot."),
  filePath: z.string().optional().describe("Use for attach mode. File bytes to write to the running PTY before reading a snapshot."),
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

function num(value: unknown) {
  return typeof value === "number" ? value : undefined
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

function merge(base: ExBashTask.Info, hit?: Record<string, unknown>): ExBashTask.Info {
  if (!hit) return base
  const state = ExBashTask.State.safeParse(hit.state).success ? (hit.state as ExBashTask.State) : base.state
  return {
    ...base,
    pid: num(hit.pid),
    state,
    exitCode: num(hit.exitCode) ?? base.exitCode,
    command: text(hit.command) ?? base.command,
    description: text(hit.description) ?? base.description,
    cwd: text(hit.cwd) ?? base.cwd,
    startedAt: num(hit.startedAt) ?? base.startedAt,
    endedAt: num(hit.endedAt) ?? base.endedAt,
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
    startedAt: num(result.metadata.startedAt) ?? Date.now(),
  })
}

async function sync(item: ExBashTask.Info, hit?: Record<string, unknown>) {
  if (!hit) return ExBashTask.lost({ executor: item.executor, asyncID: item.asyncID }).then((next) => next ?? item)
  const next = merge(item, hit)
  if (next.state === "stopped") {
    await ExBashTask.finish({
      asyncID: next.asyncID,
      executor: next.executor,
      exitCode: next.exitCode ?? -1,
      endedAt: next.endedAt ?? Date.now(),
      error: next.error,
    })
  }
  return next
}

async function known(ctx: Tool.Context, input?: { asyncID?: string; scope?: ExBashTask.Scope; executor?: string }) {
  return (await ExBashTask.get({ sessionID: ctx.sessionID, workspace: workspace(ctx) })).filter(
    (item) =>
      (!input?.asyncID || item.asyncID === input.asyncID) &&
      (!input?.scope || item.scope === input.scope) &&
      item.executor === (input?.executor ?? EXECUTOR),
  )
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
    "- mode=list: list REC exbash runs known to this opencode session/workspace, optionally filtered by asyncID or scope.",
    "- mode=attach: write text or file bytes to a running PTY, wait read_timeout ms, and return a plain-text PTY snapshot.",
    "- mode=control: stop or remove a run with action=stop or action=remove; remove also clears stale unknown records locally.",
    "- executor selects a configured RemoteExecutor executor. Omit it to use local.",
    "- timeout and read_timeout are passed through to REC; opencode does not default or reinterpret them.",
    "Examples:",
    '- run foreground-ish: {"command":"echo hello","description":"Print hello"}',
    '- detach immediately: {"command":"sleep 20","description":"Wait in PTY","read_timeout":0}',
    '- list: {"mode":"list"}',
    '- attach: {"mode":"attach","asyncID":"<asyncID>","text":"hello\\n","read_timeout":1000}',
    '- control: {"mode":"control","asyncID":"<asyncID>","action":"stop"}',
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
      const dir = await command(ctx, data)
      const result = await RemoteExecutor.call(
        "exbash",
        {
          command: data.command,
          ...(data.description === undefined ? {} : { description: data.description }),
          ...(data.executor === undefined ? {} : { executor: data.executor }),
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
      await ctx.ask({
        permission: "bash",
        patterns: [data.asyncID ? `exbash list ${data.asyncID}` : "exbash list"],
        always: ["exbash list *"],
        metadata: {},
      })
      const result = await RemoteExecutor.call(
        "exbash_list",
        { ...(data.executor === undefined ? {} : { executor: data.executor }) },
        { signal: ctx.abort },
      )
      const map = new Map(arr(result.metadata.runs).map((item) => [text(item.asyncID), item]))
      const runs = await Promise.all((await known(ctx, data)).map((item) => sync(item, map.get(item.asyncID))))
      return { title: "Async runs listed", metadata: { runs }, output: JSON.stringify({ runs }, null, 2) }
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
      if (data.timeout !== undefined) throw new Error("read_timeout is required instead of timeout for attach mode")
      if (data.text !== undefined && data.filePath !== undefined) throw new Error("Provide only one of text or filePath for attach mode")
      await ctx.ask({
        permission: "bash",
        patterns: [`exbash attach ${data.asyncID}`],
        always: ["exbash attach *"],
        metadata: {},
      })
      const exec = data.executor ?? EXECUTOR
      const task = await ExBashTask.one({ sessionID: ctx.sessionID, workspace: workspace(ctx), executor: exec, asyncID: data.asyncID })
      if (!task) throw new Error(`Async run not found: ${data.asyncID}`)
      if (task.state === "unknown") throw new Error(`Async run state unknown: ${data.asyncID}`)
      const result = await RemoteExecutor.call(
        "exbash_attach",
        {
          asyncID: data.asyncID,
          ...(data.executor === undefined ? {} : { executor: data.executor }),
          ...(data.text === undefined ? {} : { text: data.text }),
          ...(data.filePath === undefined ? {} : { filePath: await input(ctx, data.filePath) }),
          ...(data.read_timeout === undefined ? {} : { read_timeout: data.read_timeout }),
          directory: workspace(ctx),
        },
        { signal: ctx.abort },
      )
      await sync(task, result.metadata)
      return result
    }

    const data = z.object({ asyncID: z.string(), executor: z.string().optional(), action: z.enum(["stop", "remove"]) }).parse(arg)
    await ctx.ask({
      permission: "bash",
      patterns: [`exbash ${data.action} ${data.asyncID}`],
      always: [`exbash ${data.action} *`],
      metadata: {},
    })
    const exec = data.executor ?? EXECUTOR
    const task = await ExBashTask.one({ sessionID: ctx.sessionID, workspace: workspace(ctx), executor: exec, asyncID: data.asyncID })
    if (!task) throw new Error(`Async run not found: ${data.asyncID}`)
    if (data.action === "remove" && task.state === "unknown") {
      await ExBashTask.remove({ sessionID: ctx.sessionID, workspace: workspace(ctx), executor: exec, asyncID: data.asyncID })
      return {
        title: "Async run removed",
        metadata: { asyncID: data.asyncID, executor: task.executor, state: task.state, removed: true },
        output: JSON.stringify({ asyncID: data.asyncID, state: task.state, removed: true }, null, 2),
      }
    }
    if (task.state === "unknown") throw new Error(`Async run state unknown: ${data.asyncID}`)
    const result = await RemoteExecutor.call(
      data.action === "stop" ? "exbash_stop" : "exbash_remove",
      { asyncID: data.asyncID, ...(data.executor === undefined ? {} : { executor: data.executor }) },
      { signal: ctx.abort },
    )
    if (data.action === "remove") await ExBashTask.remove({ sessionID: ctx.sessionID, workspace: workspace(ctx), executor: exec, asyncID: data.asyncID })
    else await sync(task, result.metadata)
    return result
  },
})
