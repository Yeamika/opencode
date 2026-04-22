import z from "zod"
import path from "path"
import fs from "fs/promises"
import { closeSync, openSync } from "fs"
import { randomUUID } from "crypto"
import type { ChildProcess } from "child_process"
import launch from "cross-spawn"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Shell } from "@/shell/shell"
import { Filesystem } from "@/util/filesystem"
import { Tool } from "./tool"
import { BashTool, ask, collect, parse, resolvePath, shellEnv, spawnInput } from "./bash"

const ROOT = path.join(Global.Path.data, "exbash")

type Reason = { type: "exit"; code: number | null } | { type: "timeout" } | { type: "stopped" }

type State = {
  id: string
  scope: "local" | "workspace"
  session: string
  workspace: string
  pid: number | null
  status: "running" | "stopped"
  reason?: Reason
  command: string
  description: string
  cwd: string
  logPath: string
  timeout?: number
  startedAt: number
  endedAt?: number
  error?: string
}

type Job = {
  proc?: ChildProcess
  next?: Reason
  state: State
  timer?: ReturnType<typeof setTimeout>
}

const jobs = new Map<string, Job>()

const parameters = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("exec"),
    command: z.string().describe("The command to execute."),
    async: z.boolean().optional().describe("Set true to run in the background and return immediately."),
    scope: z
      .enum(["local", "workspace"])
      .optional()
      .describe("Async task visibility. local means current session only. workspace means any session in the same workspace."),
    timeout: z.number().optional().describe("Optional timeout in milliseconds. Works for both sync and async runs."),
    workdir: z.string().optional().describe("Working directory. Use this instead of cd."),
    description: z.string().describe("Clear, concise description of what this command does in 5-10 words."),
  }),
  z.object({
    mode: z.literal("list"),
    asyncID: z.string().optional().describe("Optional async run id to inspect one run."),
  }),
  z.object({
    mode: z.literal("control"),
    asyncID: z.string().describe("Async run id."),
    action: z.enum(["stop", "remove"]).describe("Force stop a running async run, or remove a stopped run from the list."),
  }),
])

function file(id: string) {
  return path.join(ROOT, `${id}.json`)
}

async function save(state: State) {
  await fs.mkdir(ROOT, { recursive: true })
  await fs.writeFile(file(state.id), JSON.stringify(state, null, 2))
}

async function load(id: string) {
  try {
    return JSON.parse(await fs.readFile(file(id), "utf-8")) as State
  } catch {
    return
  }
}

function workspace(ctx: Tool.Context) {
  const dir = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory ?? Instance.directory
  return Filesystem.resolve(dir)
}

function visible(state: State, ctx: Tool.Context) {
  if (state.scope === "local") return state.session === ctx.sessionID
  return state.workspace === workspace(ctx)
}

async function lines(file: string) {
  const text = await Filesystem.readText(file).catch(() => "")
  if (!text) return 0
  const body = text.replace(/(?:\r?\n)+$/, "")
  if (!body) return 0
  return body.split(/\r?\n/).length
}

function label(state: State) {
  if (state.status === "running") return "running"
  if (!state.reason) return "stopped"
  if (state.reason.type === "exit") return `stopped (exit ${state.reason.code ?? "signal"})`
  if (state.reason.type === "timeout") return "stopped (timeout)"
  return "stopped (killed)"
}

async function detail(state: State) {
  return {
    asyncID: state.id,
    scope: state.scope,
    pid: state.pid,
    status: label(state),
    state: state.status,
    reason: state.reason,
    resultPath: state.logPath,
    statusPath: file(state.id),
    linePointer: await lines(state.logPath),
    command: state.command,
    description: state.description,
    cwd: state.cwd,
    timeout: state.timeout,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    error: state.error,
  }
}

async function list(id?: string) {
  if (id) {
    const item = await load(id)
    return item ? [item] : []
  }

  await fs.mkdir(ROOT, { recursive: true })
  const entries = await fs.readdir(ROOT, { withFileTypes: true }).catch(() => [])
  const out: State[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    try {
      out.push(JSON.parse(await fs.readFile(path.join(ROOT, entry.name), "utf-8")) as State)
    } catch {}
  }
  return out.toSorted((a, b) => b.startedAt - a.startedAt)
}

async function finish(job: Job, reason: Reason, extra?: { error?: string }) {
  if (job.state.status === "stopped") return job.state
  if (job.timer) clearTimeout(job.timer)
  job.timer = undefined
  job.proc = undefined
  job.next = undefined
  job.state = {
    ...job.state,
    status: "stopped",
    reason,
    endedAt: Date.now(),
    ...(extra?.error ? { error: extra.error } : {}),
  }
  await save(job.state)
  return job.state
}

async function start(input: {
  shell: string
  name: string
  command: string
  cwd: string
  scope: "local" | "workspace"
  session: string
  workspace: string
  env: NodeJS.ProcessEnv
  timeout?: number
  description: string
}) {
  await fs.mkdir(ROOT, { recursive: true })
  const id = randomUUID()
  const logPath = path.join(ROOT, `${id}.log`)
  const out = openSync(logPath, "a")
  const state: State = {
    id,
    scope: input.scope,
    session: input.session,
    workspace: input.workspace,
    pid: null,
    status: "running",
    command: input.command,
    description: input.description,
    cwd: input.cwd,
    logPath,
    timeout: input.timeout,
    startedAt: Date.now(),
  }
  const job: Job = { state }
  jobs.set(id, job)
  await save(state)

  try {
    const next = spawnInput(input.shell, input.name, input.command, input.cwd, input.env)
    const proc = launch(next.command, next.args, {
      cwd: input.cwd,
      env: input.env,
      shell: next.options.shell,
      detached: true,
      windowsHide: process.platform === "win32",
      stdio: ["ignore", out, out],
    })
    job.proc = proc

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

    job.state = { ...job.state, pid: proc.pid ?? null }
    await save(job.state)

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
  } finally {
    closeSync(out)
  }
}

export const ExBashTool = Tool.define("exbash", {
  description: [
    "Extended bash control surface with three modes.",
    "- mode=exec: run a shell command; set async=true to run in the background.",
    "- async scope=local keeps the task visible only in the current session.",
    "- async scope=workspace keeps the task visible in the same workspace.",
    "- mode=list: show async runs with status, result file path, and current line pointer.",
    "- mode=control: stop a running async run or remove a stopped run from the list.",
    "Use the same command, workdir, timeout, and description fields as bash for exec mode.",
  ].join("\n"),
  parameters,
  async execute(args, ctx) {
    if (args.mode === "list") {
      await ctx.ask({
        permission: "bash",
        patterns: [args.asyncID ? `exbash list ${args.asyncID}` : "exbash list"],
        always: ["exbash list *"],
        metadata: {},
      })
      const runs = await Promise.all((await list(args.asyncID)).filter((item) => visible(item, ctx)).map(detail))
      const output = JSON.stringify({ runs }, null, 2)
      return { title: "Async runs listed", metadata: { runs }, output }
    }

    if (args.mode === "control") {
      await ctx.ask({
        permission: "bash",
        patterns: [`exbash ${args.action} ${args.asyncID}`],
        always: [`exbash ${args.action} *`],
        metadata: {},
      })
      const job = jobs.get(args.asyncID)
      const state = job?.state ?? (await load(args.asyncID))
      if (!state || !visible(state, ctx)) throw new Error(`Async run not found: ${args.asyncID}`)

      if (args.action === "stop") {
        if (state.status === "stopped") {
          const item = await detail(state)
          return { title: "Async run already stopped", metadata: item, output: JSON.stringify(item, null, 2) }
        }
        if (!job?.proc) throw new Error(`Async run ${args.asyncID} cannot be stopped in this process`)
        job.next = { type: "stopped" }
        await Shell.killTree(job.proc, { exited: () => job.state.status === "stopped" })
        const next = await finish(job, { type: "stopped" })
        const item = await detail(next)
        return { title: "Async run stopped", metadata: item, output: JSON.stringify(item, null, 2) }
      }

      if (state.status !== "stopped") {
        throw new Error(`Async run ${args.asyncID} must be stopped before removal`)
      }

      jobs.delete(args.asyncID)
      await fs.rm(file(args.asyncID), { force: true })
      const output = { asyncID: args.asyncID, removed: true, resultPath: state.logPath }
      return { title: "Async run removed", metadata: output, output: JSON.stringify(output, null, 2) }
    }

    if (!args.async) {
      const bash = await BashTool.init()
      return bash.execute(
        {
          command: args.command,
          timeout: args.timeout,
          workdir: args.workdir,
          description: args.description,
        },
        ctx,
      )
    }

    const shell = Shell.acceptable()
    const name = Shell.name(shell)
    const cwd = args.workdir ? await resolvePath(args.workdir, Instance.directory, shell) : Instance.directory
    const scope = args.scope ?? "local"
    if (args.timeout !== undefined && args.timeout < 0) {
      throw new Error(`Invalid timeout value: ${args.timeout}. Timeout must be a positive number.`)
    }

    const ps = ["powershell", "pwsh"].includes(name)
    const root = await parse(args.command, ps)
    const scan = await collect(root, cwd, ps, shell)
    if (!Instance.containsPath(cwd)) scan.dirs.add(cwd)
    await ask(ctx, scan)

    const state = await start({
      shell,
      name,
      command: args.command,
      cwd,
      scope,
      session: ctx.sessionID,
      workspace: workspace(ctx),
      env: await shellEnv(ctx, cwd),
      timeout: args.timeout,
      description: args.description,
    })
    const item = await detail(state)
    ctx.metadata({ metadata: item })
    return {
      title: args.description,
      metadata: item,
      output: JSON.stringify(item, null, 2),
    }
  },
})
