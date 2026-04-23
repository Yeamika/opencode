import z from "zod"
import path from "path"
import fs from "fs/promises"
import { createWriteStream } from "fs"
import { randomUUID } from "crypto"
import type { ChildProcess } from "child_process"
import launch from "cross-spawn"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Shell } from "@/shell/shell"
import { Filesystem } from "@/util/filesystem"
import { Tool } from "./tool"
import { BashTool, ask, collect, parse, resolvePath, shellEnv, spawnInput } from "./bash"
import { ExBashTask } from "@/session/exbash"

const ROOT = path.join(Global.Path.data, "exbash")
const INPUT_TIMEOUT = 10_000
const INPUT_WINDOW = 100

type Job = {
  proc?: ChildProcess
  next?: { type: "exit"; code: number | null } | { type: "timeout" } | { type: "stopped" }
  state: Awaited<ReturnType<typeof ExBashTask.start>>
  timer?: ReturnType<typeof setTimeout>
  out?: ReturnType<typeof createWriteStream>
  lines: number
  open: boolean
}

const jobs = new Map<string, Job>()

const opt = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((input) => {
    if (typeof input === "string" && input.trim() === "") return undefined
    return input
  }, schema.optional())

const sync = z.object({
  command: z.string().describe("The command to execute."),
  timeout: z.number().optional().describe("Optional timeout in milliseconds."),
  workdir: opt(z.string()).describe("Working directory. Use this instead of cd."),
  description: z.string().describe("Clear, concise description of what this command does in 5-10 words."),
})

const back = z.object({
  command: z.string().describe("The command to execute."),
  scope: opt(z.enum(["local", "workspace"])).describe(
    "Async task visibility. local means current session only. workspace means any session in the same workspace.",
  ),
  timeout: z.number().optional().describe("Optional timeout in milliseconds."),
  workdir: opt(z.string()).describe("Working directory. Use this instead of cd."),
  description: z.string().describe("Clear, concise description of what this command does in 5-10 words."),
})

const seen = z.object({
  asyncID: opt(z.string()).describe("Optional async run id to inspect one run."),
})

const ctrl = z.object({
  asyncID: z.string().describe("Async run id."),
  action: z.enum(["stop", "remove"]).describe("Force stop a running async run, or remove a stopped run from the list."),
})

const feed = z.object({
  asyncID: z.string().describe("Async run id."),
  wait: opt(z.enum(["return", "attach"])).describe("Return immediately or wait for new task output after writing input."),
  timeout: z.number().optional().describe("Attach wait timeout in milliseconds. Defaults to 10000."),
  window: z.number().optional().describe("Attach output window in bytes. Defaults to 100."),
  text: opt(z.string()).describe("Text to write to the running task stdin."),
  filePath: opt(z.string()).describe("Read this file and write its raw bytes to the running task stdin."),
})

const parameters = z
  .object({
    mode: z.enum(["exec", "exec-async", "list", "control", "input"]),
    exec: opt(sync).describe("Use only when mode=exec."),
    async: opt(back).describe("Use only when mode=exec-async."),
    list: opt(seen).describe("Use only when mode=list."),
    control: opt(ctrl).describe("Use only when mode=control."),
    input: opt(feed).describe("Use only when mode=input."),
  })

function file(id: string) {
  return path.join(ROOT, `${id}.log`)
}

async function inputfile(file: string, ctx: Tool.Context) {
  const next = await resolvePath(file, ctx.directory ?? Instance.directory, Shell.acceptable())
  if (Instance.containsPath(next)) return next
  const dir = path.dirname(next)
  const glob = process.platform === "win32" ? Filesystem.normalizePathPattern(path.join(dir, "*")) : path.join(dir, "*")
  await ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {},
  })
  return next
}

function workspace(ctx: Tool.Context) {
  const dir = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory ?? Instance.directory
  return Filesystem.resolve(dir)
}

function label(input: { status: "running" | "stopped"; exitCode?: number }) {
  if (input.status === "running") return "running"
  return `stopped (exit ${input.exitCode ?? -1})`
}

function detail(state: Awaited<ReturnType<typeof ExBashTask.start>> | Awaited<ReturnType<typeof ExBashTask.get>>[number]) {
  return {
    asyncID: state.asyncID,
    scope: state.scope,
    pid: jobs.get(state.asyncID)?.proc?.pid ?? undefined,
    status: label(state),
    state: state.status,
    exitCode: state.exitCode,
    resultPath: state.resultPath,
    linePointer: state.linePointer,
    command: state.command,
    description: state.description,
    cwd: state.cwd,
    timeout: state.timeout,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    error: state.error,
  }
}

async function finish(job: Job, reason: { type: "exit"; code: number | null } | { type: "timeout" } | { type: "stopped" }, extra?: { error?: string }) {
  if (job.state.status === "stopped") return job.state
  if (job.timer) clearTimeout(job.timer)
  job.timer = undefined
  job.out?.end()
  job.out = undefined
  job.proc = undefined
  job.next = undefined
  const exitCode = reason.type === "exit" ? (reason.code ?? 1) : reason.type === "timeout" ? 124 : 130
  const next = await ExBashTask.finish({
    asyncID: job.state.asyncID,
    exitCode,
    endedAt: Date.now(),
    error: extra?.error,
  })
  if (next) job.state = next
  return job.state
}

async function write(job: Job, data: string | Buffer) {
  if (!job.proc?.stdin || job.proc.stdin.destroyed || !job.proc.stdin.writable) {
    throw new Error(`Async run ${job.state.id} is not accepting stdin`)
  }
  await new Promise<void>((resolve, reject) => {
    job.proc!.stdin!.write(data, (err) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

function count(job: Job, data: Buffer | string) {
  const text = typeof data === "string" ? data : data.toString()
  for (const ch of text) {
    if (!job.open) {
      job.lines += 1
      job.open = true
    }
    if (ch === "\n") job.open = false
  }
  return job.lines
}

async function attach(file: string, offset: number, timeout: number, window: number) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const buf = await fs.readFile(file).catch(() => Buffer.alloc(0))
    if (buf.length > offset) {
      const next = buf.subarray(offset)
      return {
        output: next.subarray(Math.max(0, next.length - window)).toString(),
        bytes: next.length,
        overflow: next.length > window,
        timedOut: false,
      }
    }
    await Bun.sleep(50)
  }
  return {
    output: "",
    bytes: 0,
    overflow: false,
    timedOut: true,
  }
}

async function start(input: {
  shell: string
  name: string
  command: string
  cwd: string
  scope: "local" | "workspace"
  session: Tool.Context["sessionID"]
  workspace: string
  env: NodeJS.ProcessEnv
  timeout?: number
  description: string
}) {
  await fs.mkdir(ROOT, { recursive: true })
  const id = randomUUID()
  const logPath = file(id)
  const state = await ExBashTask.start({
    asyncID: id,
    sessionID: input.session,
    workspace: input.workspace,
    scope: input.scope,
    description: input.description,
    command: input.command,
    cwd: input.cwd,
    timeout: input.timeout,
    startedAt: Date.now(),
  })
  const job: Job = {
    state,
    out: createWriteStream(logPath, { flags: "a" }),
    lines: 0,
    open: false,
  }
  jobs.set(id, job)

  const next = spawnInput(input.shell, input.name, input.command, input.cwd, input.env)
  const proc = launch(next.command, next.args, {
    cwd: input.cwd,
    env: input.env,
    shell: next.options.shell,
    detached: next.options.detached,
    windowsHide: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
  })
  job.proc = proc

  const push = async (data: Buffer | string) => {
    job.out?.write(data)
    await ExBashTask.line({ asyncID: id, linePointer: count(job, data) })
  }

  proc.stdout?.on("data", (data) => {
    void push(data)
  })
  proc.stderr?.on("data", (data) => {
    void push(data)
  })

  proc.once("exit", (code) => {
    void finish(job, job.next ?? { type: "exit", code })
  })
  proc.once("error", (err) => {
    void finish(job, job.next ?? { type: "stopped" }, { error: err.message })
  })

  await new Promise<void>((resolve, reject) => {
    proc.once("spawn", () => resolve())
    proc.once("error", reject)
  })

  if (input.timeout !== undefined) {
    job.timer = setTimeout(() => {
      if (!job.proc || job.state.status === "stopped") return
      job.next = { type: "timeout" }
      void Shell.killTree(job.proc, { exited: () => job.state.status === "stopped" }).then(async () => {
        if (job.state.status === "running") await finish(job, { type: "timeout" })
      })
    }, input.timeout)
  }

  proc.unref()
  return job.state
}

export const ExBashTool = Tool.define("exbash", {
  description: [
    "Extended bash control surface with explicit sync and async execution modes.",
    "Only include the nested block that belongs to the selected mode.",
    "Omit unrelated blocks entirely. Do not send empty string placeholders.",
    "- mode=exec: run a shell command and wait for completion.",
    "- mode=exec-async: run a shell command in the background and return immediately.",
    "- exec-async scope=local keeps the task visible only in the current session.",
    "- exec-async scope=workspace keeps the task visible in the same workspace.",
    "- mode=list: show async runs with status, result file path, and current line pointer.",
    "- mode=control: stop a running async run or remove a stopped run from the list.",
    "- mode=input: write text or file bytes into a running async task stdin.",
    "- input wait=attach waits for new output, default timeout 10000ms, default output window 100 bytes.",
    "Use exec.command/exec.description for mode=exec.",
    "Use async.command/async.description for mode=exec-async.",
    "Examples:",
    '- exec: {"mode":"exec","exec":{"command":"echo hello","description":"Print hello"}}',
    '- exec-async: {"mode":"exec-async","async":{"command":"sh -lc \'sleep 1; echo hello\'","description":"Run async echo","scope":"local"}}',
    '- list: {"mode":"list","list":{"asyncID":"<asyncID>"}}',
    '- control: {"mode":"control","control":{"asyncID":"<asyncID>","action":"stop"}}',
    '- input: {"mode":"input","input":{"asyncID":"<asyncID>","text":"hello","wait":"attach"}}',
  ].join("\n"),
  parameters,
  async execute(args, ctx) {
    if (args.mode === "list") {
      const input = seen.parse(args.list ?? {})
      await ctx.ask({
        permission: "bash",
        patterns: [input.asyncID ? `exbash list ${input.asyncID}` : "exbash list"],
        always: ["exbash list *"],
        metadata: {},
      })
      const runs = (await ExBashTask.get({ sessionID: ctx.sessionID, workspace: workspace(ctx) }))
        .filter((item) => !input.asyncID || item.asyncID === input.asyncID)
        .map(detail)
      const output = JSON.stringify({ runs }, null, 2)
      return { title: "Async runs listed", metadata: { runs }, output }
    }

    if (args.mode === "input") {
      if (!args.input) throw new Error("mode input requires the input block")
      const input = feed.parse(args.input)
      if ((input.text !== undefined ? 1 : 0) + (input.filePath !== undefined ? 1 : 0) !== 1) {
        throw new Error("Provide exactly one of text or filePath for input mode.")
      }
      if (input.timeout !== undefined && input.timeout < 0) {
        throw new Error(`Invalid timeout value: ${input.timeout}. Timeout must be a positive number.`)
      }
      if (input.window !== undefined && input.window < 0) {
        throw new Error(`Invalid window value: ${input.window}. Window must be a positive number.`)
      }
      await ctx.ask({
        permission: "bash",
        patterns: [`exbash input ${input.asyncID}`],
        always: ["exbash input *"],
        metadata: {},
      })
      const job = jobs.get(input.asyncID)
      const state = await ExBashTask.one({ sessionID: ctx.sessionID, workspace: workspace(ctx), asyncID: input.asyncID })
      if (!state) throw new Error(`Async run not found: ${input.asyncID}`)
      if (state.status !== "running") throw new Error(`Async run ${input.asyncID} is not running`)
      if (!job?.proc) throw new Error(`Async run ${input.asyncID} cannot accept input in this process`)
      const stat = await fs.stat(state.resultPath).catch(() => ({ size: 0 }))

      const data = input.filePath !== undefined
        ? Buffer.from(await Bun.file(await inputfile(input.filePath, ctx)).arrayBuffer())
        : input.text!

      await write(job, data)
      const wait = input.wait ?? "return"
      const next =
        wait === "attach" ? await attach(state.resultPath, stat.size, input.timeout ?? INPUT_TIMEOUT, input.window ?? INPUT_WINDOW) : undefined
      const output = {
        asyncID: input.asyncID,
        wait,
        wrote: typeof data === "string" ? Buffer.byteLength(data) : data.length,
        source: typeof data === "string" ? "text" : "file",
        ...(next ? next : {}),
      }
      return { title: "Async input sent", metadata: output, output: JSON.stringify(output, null, 2) }
    }

    if (args.mode === "control") {
      if (!args.control) throw new Error("mode control requires the control block")
      const input = ctrl.parse(args.control)
      await ctx.ask({
        permission: "bash",
        patterns: [`exbash ${input.action} ${input.asyncID}`],
        always: [`exbash ${input.action} *`],
        metadata: {},
      })
      const job = jobs.get(input.asyncID)
      const state = await ExBashTask.one({ sessionID: ctx.sessionID, workspace: workspace(ctx), asyncID: input.asyncID })
      if (!state) throw new Error(`Async run not found: ${input.asyncID}`)

      if (input.action === "stop") {
        if (state.status === "stopped") {
          const item = await detail(state)
          return { title: "Async run already stopped", metadata: item, output: JSON.stringify(item, null, 2) }
        }
        if (!job?.proc) throw new Error(`Async run ${input.asyncID} cannot be stopped in this process`)
        job.next = { type: "stopped" }
        await Shell.killTree(job.proc, { exited: () => job.state.status === "stopped" })
        const next = await finish(job, { type: "stopped" })
        const item = await detail(next)
        return { title: "Async run stopped", metadata: item, output: JSON.stringify(item, null, 2) }
      }

      if (state.status !== "stopped") {
        throw new Error(`Async run ${input.asyncID} must be stopped before removal`)
      }

      jobs.delete(input.asyncID)
      await ExBashTask.remove(input.asyncID)
      await fs.rm(file(input.asyncID), { force: true })
      const output = { asyncID: input.asyncID, removed: true, resultPath: state.resultPath }
      return { title: "Async run removed", metadata: output, output: JSON.stringify(output, null, 2) }
    }

    if (args.mode === "exec") {
      if (!args.exec) throw new Error("mode exec requires the exec block")
      const input = sync.parse(args.exec)
      const bash = await BashTool.init()
      return bash.execute(
        {
          command: input.command,
          timeout: input.timeout,
          workdir: input.workdir,
          description: input.description,
        },
        ctx,
      )
    }

    if (!args.async) throw new Error("mode exec-async requires the async block")
    const input = back.parse(args.async)

    const shell = Shell.acceptable()
    const name = Shell.name(shell)
    const cwd = input.workdir ? await resolvePath(input.workdir, Instance.directory, shell) : Instance.directory
    const scope = input.scope ?? "local"
    if (input.timeout !== undefined && input.timeout < 0) {
      throw new Error(`Invalid timeout value: ${input.timeout}. Timeout must be a positive number.`)
    }

    const ps = ["powershell", "pwsh"].includes(name)
    const root = await parse(input.command, ps)
    const scan = await collect(root, cwd, ps, shell)
    if (!Instance.containsPath(cwd)) scan.dirs.add(cwd)
    await ask(ctx, scan)

    const state = await start({
      shell,
      name,
      command: input.command,
      cwd,
      scope,
      session: ctx.sessionID,
      workspace: workspace(ctx),
      env: await shellEnv(ctx, cwd),
      timeout: input.timeout,
      description: input.description,
    })
    const item = await detail(state)
    ctx.metadata({ metadata: item })
    return {
      title: input.description,
      metadata: item,
      output: JSON.stringify(item, null, 2),
    }
  },
})
