import z from "zod"
import path from "path"
import fs from "fs/promises"
import { createWriteStream } from "fs"
import { randomUUID } from "crypto"
import type { ChildProcess } from "child_process"
import launch from "cross-spawn"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Shell } from "@/shell/shell"
import { Filesystem } from "@/util/filesystem"
import { which } from "@/util/which"
import { Tool } from "./tool"
import { ask, collect, invoke, parse, resolvePath, shellEnv, spawnInput } from "./bash"
import { ExBashTask } from "@/session/exbash"

const ROOT = path.join(Global.Path.data, "exbash")
const ASYNC_TIMEOUT = 10_000
const INPUT_TIMEOUT = 10_000
const INPUT_WINDOW = 100
const OUTPUT = 30_000

type Job = {
  proc?: ChildProcess
  next?: { type: "exit"; code: number | null } | { type: "timeout" } | { type: "stopped" }
  state: Awaited<ReturnType<typeof ExBashTask.start>>
  timer?: ReturnType<typeof setTimeout>
  out?: ReturnType<typeof createWriteStream>
  lines: number
  open: boolean
}

type Exec = {
  file: string
  name: string
  args: string[]
}

type Key = "bash" | "powershell" | "cmd" | "node" | "python"

type Paths = Partial<Record<Key, string | string[]>>

const jobs = new Map<string, Job>()

const sync = z.object({
  command: z.string().describe("The command to execute."),
  timeout: z.number().optional().describe("Optional timeout in milliseconds."),
  workdir: z.string().optional().describe("Working directory. Use this instead of cd."),
  executor: z
    .string()
    .optional()
    .describe("Optional executor. Built-ins: bash, powershell, cmd, node, python. Other strings are treated as command prefixes."),
  description: z.string().describe("Clear, concise description of what this command does in 5-10 words."),
})

const back = z.object({
  command: z.string().describe("The command to execute."),
  scope: z.enum(["local", "workspace"]).optional().describe(
    "Async task visibility. local means current session only. workspace means any session in the same workspace.",
  ),
  timeout: z.number().optional().describe("Optional timeout in milliseconds."),
  workdir: z.string().optional().describe("Working directory. Use this instead of cd."),
  executor: z
    .string()
    .optional()
    .describe("Optional executor. Built-ins: bash, powershell, cmd, node, python. Other strings are treated as command prefixes."),
  description: z.string().describe("Clear, concise description of what this command does in 5-10 words."),
})

const auto = back.extend({
  async_timeout: z.number().optional().describe("Milliseconds to wait before detaching into async mode. Defaults to 10000."),
})

const seen = z.object({
  asyncID: z.string().optional().describe("Optional async run id to inspect one run."),
  scope: z.enum(["local", "workspace"]).optional().describe("Optional scope filter for list."),
})

const ctrl = z.object({
  asyncID: z.string().describe("Async run id."),
  action: z.enum(["stop", "remove"]).describe("Force stop a running async run, or remove a stopped run from the list."),
})

const feed = z.object({
  asyncID: z.string().describe("Async run id."),
  wait: z.enum(["return", "attach"]).optional().describe("Return immediately or wait for new task output after writing input."),
  timeout: z.number().optional().describe("Attach wait timeout in milliseconds. Defaults to 10000."),
  window: z.number().optional().describe("Attach output window in bytes. Defaults to 100."),
  text: z.string().optional().describe("Text to write to the running task stdin."),
  filePath: z.string().optional().describe("Read this file and write its raw bytes to the running task stdin."),
})

const parameters = z
  .object({
    mode: z.enum(["exec_timeout_async", "exec_async", "list", "control", "input"]),
    command: z.string().optional().describe("Use for exec_timeout_async and exec_async."),
    description: z.string().optional().describe("Use for exec_timeout_async and exec_async."),
    workdir: z.string().optional().describe("Use for exec_timeout_async and exec_async."),
    executor: z.string().optional().describe("Use for exec_timeout_async and exec_async."),
    scope: z.enum(["local", "workspace"]).optional().describe("Use for exec_timeout_async, exec_async, or as an optional filter for list."),
    timeout: z.number().optional().describe("Use for exec_timeout_async, exec_async, or input wait=attach."),
    async_timeout: z.number().optional().describe("Use for exec_timeout_async."),
    asyncID: z.string().optional().describe("Use for list, control, and input."),
    action: z.enum(["stop", "remove"]).optional().describe("Use for control."),
    wait: z.enum(["return", "attach"]).optional().describe("Use for input."),
    window: z.number().optional().describe("Use for input wait=attach."),
    text: z.string().optional().describe("Use for input."),
    filePath: z.string().optional().describe("Use for input."),
  })

function clean(input: unknown): unknown {
  if (typeof input === "string" && input.trim() === "") return undefined
  if (Array.isArray(input)) return input.map(clean)
  if (input && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, clean(value)]).filter(([, value]) => value !== undefined))
  }
  return input
}

function file(id: string) {
  return path.join(ROOT, `${id}.log`)
}

function clip(text: string) {
  if (text.length <= OUTPUT) return text
  return text.slice(0, OUTPUT) + "\n\n..."
}

function key(text: string): Key | undefined {
  if (text === "pwsh" || text === "powershell") return "powershell"
  if (text === "bash" || text === "cmd" || text === "node" || text === "python") return text
}

function list(input?: string | string[]) {
  if (!input) return []
  return (Array.isArray(input) ? input : [input]).map((item) => item.trim()).filter(Boolean)
}

function pathy(text: string) {
  return path.isAbsolute(text) || text.startsWith(".") || text.includes("/") || text.includes("\\")
}

function prog(text: string, root?: string) {
  const next = process.platform === "win32" ? Filesystem.windowsPath(text) : text
  if (!root || !pathy(next) || path.isAbsolute(next)) return next
  return Filesystem.resolve(path.join(root, next))
}

function select(input: string | string[] | undefined, root?: string) {
  const vals = list(input)
  const seen = vals.map((item) => prog(item, root))
  for (const item of seen) {
    if (pathy(item)) {
      if (Filesystem.stat(item)) return item
      continue
    }
    const hit = which(item)
    if (hit) return hit
  }
  return seen[0]
}

function split(text: string) {
  const list = text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) ?? []
  return list.map((item) => {
    if (item.startsWith('"') && item.endsWith('"')) {
      return item.slice(1, -1).replace(/\\(["\\])/g, "$1")
    }
    if (item.startsWith("'") && item.endsWith("'")) {
      return item.slice(1, -1).replace(/\\(['\\])/g, "$1")
    }
    return item
  })
}

function prefix(text: string, root?: string) {
  const list = split(text.trim())
  if (!list.length) throw new Error("Executor must not be empty")
  const file = prog(list[0], root)
  return {
    file,
    name: Shell.name(file),
    args: list.slice(1),
  }
}

function builtin(text: Key, root?: string, cfg?: Paths) {
  if (text === "bash") {
    const file = select(cfg?.bash, root) || (process.platform === "win32" ? Shell.gitbash() || "bash" : which("bash") || "/bin/bash")
    return { file, name: "bash", args: ["-lc"] }
  }

  if (text === "powershell") {
    const file = select(cfg?.powershell, root) || which("pwsh") || which("powershell") || "powershell"
    return { file, name: Shell.name(file), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] }
  }

  if (text === "cmd") {
    const file = select(cfg?.cmd, root) || process.env.COMSPEC || "cmd.exe"
    return {
      file: process.platform === "win32" ? Filesystem.windowsPath(file) : file,
      name: "cmd",
      args: ["/d", "/s", "/c"],
    }
  }

  if (text === "node") {
    const file = select(cfg?.node, root) || "node"
    return { file, name: "node", args: ["-e"] }
  }

  const file = select(cfg?.python, root) || "python"
  return { file, name: "python", args: ["-c"] }
}

function native(root: string, cfg?: Paths): Exec {
  const file = Shell.acceptable()
  const name = Shell.name(file)
  const next = key(name)
  if (!next) return { file, name, args: [] }
  if (!list(cfg?.[next]).length) return { file, name, args: [] }
  const exec = builtin(next, root, cfg)
  return {
    file: exec.file,
    name: exec.name,
    args: [],
  }
}

function raw(text?: string): Exec {
  const next = text?.trim()
  if (!next) {
    const file = Shell.acceptable()
    return { file, name: Shell.name(file), args: [] }
  }

  const hit = key(next.toLowerCase())
  if (hit) return builtin(hit)
  return prefix(next)
}

async function pick(text: string | undefined, root: string): Promise<Exec> {
  const cfg = (await Config.get()).experimental?.exbash?.executors
  const next = text?.trim()
  if (!next) return native(root, cfg)

  const hit = key(next.toLowerCase())
  if (hit) return builtin(hit, root, cfg)
  return prefix(next, root)
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
  const dir = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : Instance.worktree !== "/" ? Instance.worktree : ctx.directory ?? Instance.directory
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
    throw new Error(`Async run ${job.state.asyncID} is not accepting stdin`)
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

async function read(id: string) {
  return fs.readFile(file(id), "utf8").catch(() => "")
}

async function wipe(id: string) {
  jobs.delete(id)
  await ExBashTask.remove(id)
  await fs.rm(file(id), { force: true })
}

async function settle(id: string, timeout: number, ctx: Tool.Context, description: string) {
  const end = Date.now() + timeout
  let output = ""
  while (true) {
    const next = await read(id)
    if (next !== output) {
      output = next
      ctx.metadata({
        metadata: {
          output: clip(output),
          description,
        },
      })
    }
    const state = jobs.get(id)?.state
    if (state?.status === "stopped") {
      const last = await read(id)
      if (last !== output) output = last
      return { state, output }
    }
    if (Date.now() >= end) return { output }
    await Bun.sleep(50)
  }
}

async function start(input: {
  shell: string
  name: string
  args: string[]
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

  const next = spawnInput(input.shell, input.name, input.command, input.cwd, input.env, input.args)
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

async function queue(
  input: {
    exec: Exec
    command: string
    cwd: string
    scope: "local" | "workspace"
    timeout?: number
    description: string
  },
  ctx: Tool.Context,
) {
  const ps = ["powershell", "pwsh"].includes(input.exec.name)
  const root = await parse(input.command, ps)
  const scan = await collect(root, input.cwd, ps, input.exec.file)
  if (!Instance.containsPath(input.cwd)) scan.dirs.add(input.cwd)
  await ask(ctx, scan)
  return start({
    shell: input.exec.file,
    name: input.exec.name,
    args: input.exec.args,
    command: input.command,
    cwd: input.cwd,
    scope: input.scope,
    session: ctx.sessionID,
    workspace: workspace(ctx),
    env: await shellEnv(ctx, input.cwd),
    timeout: input.timeout,
    description: input.description,
  })
}

export const ExBashTool = Tool.define("exbash", {
  description: [
    "Extended bash control surface with explicit sync and async execution modes.",
    "Only include fields that belong to the selected mode.",
    "Omit unrelated fields entirely. Do not send empty string placeholders.",
    "- mode=exec_timeout_async: run first in the foreground, then detach into an async task after async_timeout ms if still running.",
    "- mode=exec_async: run a shell command in the background and return immediately.",
    "- if executor is omitted, exbash prefers the system-native supported executor.",
    "- executor accepts bash, powershell, cmd, node, python, or a custom command prefix for async modes.",
    "- async_timeout defaults to 10000 for exec_timeout_async.",
    "- exec_async scope=local keeps the task visible only in the current session.",
    "- exec_async scope=workspace keeps the task visible in the same workspace.",
    "- exec_async and detached exec_timeout_async calls return asyncID and resultPath immediately.",
    "- mode=list: show async runs with status, result file path, and current line pointer.",
    "- mode=control: stop a running async run or remove a stopped run from the list.",
    "- mode=input: write text or file bytes into a running async task stdin.",
    "- input wait=attach waits for new output, default timeout 10000ms, default output window 100 bytes.",
    "Examples:",
    '- exec_timeout_async: {"mode":"exec_timeout_async","command":"sleep 20","description":"Wait and detach","async_timeout":10000}',
    '- exec_async: {"mode":"exec_async","command":"Write-Output hello","description":"Run async echo","scope":"local","executor":"powershell"}',
    '- list: {"mode":"list"}',
    '- list filtered: {"mode":"list","scope":"workspace","asyncID":"<asyncID>"}',
    '- control: {"mode":"control","asyncID":"<asyncID>","action":"stop"}',
    '- input: {"mode":"input","asyncID":"<asyncID>","text":"hello","wait":"attach"}',
  ].join("\n"),
  parameters,
  async execute(args, ctx): Promise<{ title: string; metadata: Record<string, unknown>; output: string }> {
    const arg = clean(args) as z.infer<typeof parameters>

    if (arg.mode === "list") {
      const input = seen.parse(arg)
      await ctx.ask({
        permission: "bash",
        patterns: [input.asyncID ? `exbash list ${input.asyncID}` : "exbash list"],
        always: ["exbash list *"],
        metadata: {},
      })
      const runs = (await ExBashTask.get({ sessionID: ctx.sessionID, workspace: workspace(ctx) }))
        .filter((item) => (!input.asyncID || item.asyncID === input.asyncID) && (!input.scope || item.scope === input.scope))
        .map(detail)
      const output = JSON.stringify({ runs }, null, 2)
      return { title: "Async runs listed", metadata: { runs }, output }
    }

    if (arg.mode === "input") {
      const input = feed.parse(arg)
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
      const tail =
        wait === "attach" ? await attach(state.resultPath, stat.size, input.timeout ?? INPUT_TIMEOUT, input.window ?? INPUT_WINDOW) : undefined
      const output = {
        asyncID: input.asyncID,
        wait,
        wrote: typeof data === "string" ? Buffer.byteLength(data) : data.length,
        source: typeof data === "string" ? "text" : "file",
        ...(tail ? tail : {}),
      }
      return { title: "Async input sent", metadata: output, output: JSON.stringify(output, null, 2) }
    }

    if (arg.mode === "control") {
      const input = ctrl.parse(arg)
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

    if (arg.mode === "exec_timeout_async") {
      const input = auto.parse(arg)
      const asyncTimeout = input.async_timeout ?? ASYNC_TIMEOUT
      if (asyncTimeout < 0) {
        throw new Error(`Invalid async_timeout value: ${asyncTimeout}. async_timeout must be a positive number.`)
      }
      if (input.timeout !== undefined && input.timeout < 0) {
        throw new Error(`Invalid timeout value: ${input.timeout}. Timeout must be a positive number.`)
      }
      const shell = raw(input.executor).file
      const cwd = input.workdir ? await resolvePath(input.workdir, Instance.directory, shell) : Instance.directory
      const exec = await pick(input.executor, workspace(ctx))
      const state = await queue(
        {
          exec,
          command: input.command,
          cwd,
          scope: input.scope ?? "local",
          timeout: input.timeout,
          description: input.description,
        },
        ctx,
      )
      const next = await settle(state.asyncID, asyncTimeout, ctx, input.description)
      if (next.state?.status === "stopped") {
        await wipe(state.asyncID)
        return {
          title: input.description,
          metadata: {
            output: clip(next.output),
            exit: next.state.exitCode,
            description: input.description,
          },
          output: next.output,
        }
      }
      const item = {
        ...detail(jobs.get(state.asyncID)?.state ?? state),
        detached: true,
        asyncTimeout,
      }
      ctx.metadata({
        metadata: {
          ...item,
          output: clip(next.output),
        },
      })
      return {
        title: input.description,
        metadata: {
          ...item,
          output: clip(next.output),
        },
        output: JSON.stringify(item, null, 2),
      }
    }

    const input = back.parse(arg)

    const shell = raw(input.executor).file
    const cwd = input.workdir ? await resolvePath(input.workdir, Instance.directory, shell) : Instance.directory
    const exec = await pick(input.executor, workspace(ctx))
    if (input.timeout !== undefined && input.timeout < 0) {
      throw new Error(`Invalid timeout value: ${input.timeout}. Timeout must be a positive number.`)
    }

    const state = await queue(
      {
        exec,
        command: input.command,
        cwd,
        scope: input.scope ?? "local",
        timeout: input.timeout,
        description: input.description,
      },
      ctx,
    )
    const item = await detail(state)
    ctx.metadata({ metadata: item })
    return {
      title: input.description,
      metadata: item,
      output: JSON.stringify(item, null, 2),
    }
  },
})
