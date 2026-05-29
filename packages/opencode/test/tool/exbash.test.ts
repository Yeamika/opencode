import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import z from "zod"
import "../../src/server/projectors"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { Permission } from "../../src/permission"
import { ExBashTool } from "../../src/tool/exbash"
import { RemoteExecutor } from "../../src/tool/remote_executor"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const base = {
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const calls: Array<{ tool: string; args: Record<string, unknown>; opts?: { timeout?: number } }> = []
let seq = 0

afterEach(() => {
  calls.length = 0
})

async function ctx(title: string, dir: string, rules?: Permission.Ruleset) {
  const session = await Session.create({ title })
  return {
    ...base,
    sessionID: session.id,
    directory: dir,
    ask: async (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) => {
      if (!rules) return
      for (const item of req.patterns) {
        const rule = Permission.evaluate(req.permission, item, rules)
        if (rule.action === "deny") throw new Permission.DeniedError({ ruleset: rules })
      }
    },
  }
}

async function repo<T>(fn: (dir: string) => Promise<T>) {
  await using tmp = await tmpdir({ git: true })
  const { project } = await Project.fromDirectory(tmp.path)
  await Instance.reload({ directory: tmp.path, project, worktree: tmp.path })
  return Instance.provide({ directory: tmp.path, fn: () => fn(tmp.path) })
}

function mock() {
  return spyOn(RemoteExecutor, "call").mockImplementation(async (tool, args, opts) => {
    calls.push({ tool, args, opts })
    if (tool === "exbash" || tool === "exbash_shell") {
      if (args.command === "echo done") {
        return {
          title: String(args.description ?? args.command ?? "exbash"),
          metadata: {
            description: args.description ?? args.command,
            exit: 0,
            output: "done\n",
          },
          output: "done\n",
        }
      }
      if (args.command === "sleep snapshot" || args.command === "empty detach") {
        const id = `rex-test-${++seq}`
        return {
          title: String(args.description ?? args.command ?? "exbash"),
          metadata: {
            asyncID: id,
            command: args.command,
            description: args.description ?? args.command,
            cwd: args.directory,
            startedAt: Date.now(),
            state: "running",
            status: "running",
            detached: true,
          },
          output: args.command === "empty detach" ? "" : "before-detach\n",
        }
      }
      const id = `rex-test-${++seq}`
      return {
        title: String(args.description ?? args.command ?? "exbash"),
        metadata: {
          asyncID: id,
          command: args.command,
          description: args.description ?? args.command,
          cwd: args.directory,
          timeout: args.timeout,
          startedAt: Date.now(),
          state: "running",
          status: "running",
        },
        output: JSON.stringify({ asyncID: id }),
      }
    }
    if (tool === "exbash_list") {
      return {
        title: "Async runs listed",
        metadata: {
          runs: calls
            .filter((item) => item.tool === "exbash" || item.tool === "exbash_shell")
            .map((item, idx) => {
              const id = `rex-test-${idx + 1}`
              const stopped = calls.find((call) => call.tool === "exbash_stop" && call.args.asyncID === id)
              return {
                asyncID: id,
                command: item.args.command,
                description: item.args.command,
                cwd: item.args.directory,
                state: stopped ? "stopped" : "running",
                status: stopped ? "stopped (exit 0)" : "running",
                ...(stopped ? { exitCode: 0, endedAt: Date.now() } : {}),
                startedAt: Date.now(),
              }
            }),
        },
        output: "{}",
      }
    }
    if (tool === "exbash_stop") {
      return {
        title: "Async run stopped",
        metadata: {
          asyncID: args.asyncID,
          command: "bad command",
          description: "bad command",
          cwd: "bad cwd",
          timeout: null,
          state: "stopped",
          exitCode: 0,
          endedAt: Date.now(),
          totalOutput: 5,
        },
        output: JSON.stringify({ asyncID: args.asyncID, tool }),
      }
    }
    return {
      title: tool,
      metadata: { asyncID: args.asyncID, removed: tool === "exbash_remove" },
      output: JSON.stringify({ asyncID: args.asyncID, tool }),
    }
  })

  test.serial("maps runexe to REC direct executable mode", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        await tool.execute({ mode: "runexe", command: "python --version", description: "Python version" }, await ctx("runexe", dir))

        expect(calls[0]).toMatchObject({
          tool: "exbash",
          args: {
            command: "python --version",
            description: "Python version",
            directory: dir,
          },
        })
      })
    } finally {
      call.mockRestore()
    }
  })
}

describe("tool.exbash", () => {
  test("exports an object json schema", async () => {
    expect(z.toJSONSchema((await ExBashTool.init()).parameters).type).toBe("object")
  })

  test.serial("runs through REC and stores opencode scope metadata", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const result = await tool.execute(
          {
            command: "echo hello",
            description: "Echo hello",
            read_timeout: -1,
            timeout: -1,
            scope: "workspace",
          },
          await ctx("run", dir),
        )

        expect(calls[0]).toMatchObject({
          tool: "exbash_shell",
          args: {
            command: "echo hello",
            description: "Echo hello",
            read_timeout: -1,
            timeout: -1,
            directory: dir,
          },
        })
        expect(result.metadata.scope).toBe("workspace")
        expect(result.metadata.executor).toBe("local")
        expect(result.metadata.workspace).toBeUndefined()
        expect(result.metadata.timeout).toBeUndefined()
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("returns plaintext output when run completes before detach", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const result = await tool.execute({ command: "echo done", description: "Complete immediately" }, await ctx("plaintext run", dir))

        expect(result.output).toBe("done\n")
        expect(result.metadata).toMatchObject({ exit: 0, output: "done\n" })
        expect(result.metadata.asyncID).toBeUndefined()
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("extends outer RemoteExecutor wait for long run read_timeout", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        await tool.execute({ command: "sleep 40", read_timeout: 40_000 }, await ctx("long run wait", dir))

        expect(calls.at(-1)).toMatchObject({ tool: "exbash_shell", opts: { timeout: 45_000 } })
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("returns detached run snapshot as output", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const result = await tool.execute({ command: "sleep snapshot", read_timeout: 100 }, await ctx("detached snapshot", dir))

        expect(result.output).toBe("before-detach\n")
        expect(result.metadata).toMatchObject({ state: "running" })
        expect(result.metadata.output).toBeUndefined()
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("shows async metadata when detached output is empty", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const result = await tool.execute({ command: "empty detach", read_timeout: 0 }, await ctx("empty detach", dir))
        const out = JSON.parse(result.output) as { asyncID: string; state: string }

        expect(out.asyncID).toBe(result.metadata.asyncID as string)
        expect(out.state).toBe("running")
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("keeps local runs private to the creating session", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const one = await ctx("one", dir)
        const two = await ctx("two", dir)
        const result = await tool.execute({ command: "sleep 1", read_timeout: 0 }, one)
        const id = result.metadata.asyncID as string

        const own = JSON.parse((await tool.execute({ mode: "list", asyncID: id }, one)).output) as { runs: Array<{ asyncID: string }> }
        const other = JSON.parse((await tool.execute({ mode: "list", asyncID: id }, two)).output) as { runs: Array<{ asyncID: string }> }

        expect(own.runs.map((item) => item.asyncID)).toContain(id)
        expect(other.runs).toHaveLength(0)
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("shares workspace runs across sessions in the same workspace", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const one = await ctx("workspace one", dir)
        const two = await ctx("workspace two", dir)
        const result = await tool.execute({ command: "sleep 1", read_timeout: 0, scope: "workspace" }, one)
        const id = result.metadata.asyncID as string

        const all = JSON.parse((await tool.execute({ mode: "list", asyncID: id }, two)).output) as { runs: Array<{ asyncID: string; scope: string; executor: string }> }
        const local = JSON.parse((await tool.execute({ mode: "list", scope: "local", asyncID: id }, two)).output) as { runs: Array<unknown> }
        const listed = JSON.parse((await tool.execute({ mode: "list", scope: "workspace", asyncID: id }, two)).output) as { runs: Array<{ asyncID: string; scope: string; executor: string }> }

        expect(all.runs).toMatchObject([{ asyncID: id, scope: "workspace", executor: "local" }])
        expect(local.runs).toHaveLength(0)
        expect(listed.runs).toMatchObject([{ asyncID: id, scope: "workspace", executor: "local" }])
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("stores and controls runs per selected executor", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const c = await ctx("remote executor", dir)
        const result = await tool.execute({ command: "sleep 1", read_timeout: 0, executor: "box" }, c)
        const id = result.metadata.asyncID as string

        const all = JSON.parse((await tool.execute({ mode: "list", asyncID: id }, c)).output) as { runs: Array<{ asyncID: string; executor: string }> }
        const local = JSON.parse((await tool.execute({ mode: "list", asyncID: id, executor: "local" }, c)).output) as { runs: Array<unknown> }
        const remote = JSON.parse((await tool.execute({ mode: "list", asyncID: id, executor: "box" }, c)).output) as { runs: Array<{ asyncID: string; executor: string }> }

        expect(calls[0]).toMatchObject({ tool: "exbash_shell", args: { executor: "box" } })
        expect(calls).toContainEqual(expect.objectContaining({ tool: "exbash_list", args: { executor: "box", asyncID: id } }))
        expect(result.metadata.executor).toBe("box")
        expect(all.runs).toMatchObject([{ asyncID: id, executor: "box" }])
        expect(local.runs).toHaveLength(0)
        expect(remote.runs).toMatchObject([{ asyncID: id, executor: "box" }])
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("marks a remembered run unknown when REC no longer lists it", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const c = await ctx("unknown", dir)
        const result = await tool.execute({ command: "sleep 1", read_timeout: 0 }, c)
        const id = result.metadata.asyncID as string
        calls.length = 0

        const listed = JSON.parse((await tool.execute({ mode: "list", asyncID: id }, c)).output) as { runs: Array<{ asyncID: string; state: string }> }

        expect(listed.runs).toMatchObject([{ asyncID: id, state: "unknown" }])
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("removes unknown runs from opencode without REC", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const c = await ctx("remove unknown", dir)
        const result = await tool.execute({ command: "sleep 1", read_timeout: 0 }, c)
        const id = result.metadata.asyncID as string
        calls.length = 0

        await tool.execute({ mode: "list", asyncID: id }, c)
        calls.length = 0
        const removed = await tool.execute({ mode: "remove", asyncID: id }, c)
        const listed = JSON.parse((await tool.execute({ mode: "list", asyncID: id }, c)).output) as { runs: Array<unknown> }

        expect(removed.metadata).toMatchObject({ asyncID: id, executor: "local", state: "unknown", removed: true })
        expect(calls).not.toContainEqual(expect.objectContaining({ tool: "exbash_remove" }))
        expect(listed.runs).toHaveLength(0)
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("rejects when a scope has too many running tasks and allows remove", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const c = await ctx("task limit", dir)
        for (let i = 0; i < 5; i++) await tool.execute({ command: `sleep ${i}`, read_timeout: 0 }, c)

        await expect(tool.execute({ command: "sleep 5", read_timeout: 0 }, c)).rejects.toThrow("Too many running exbash tasks in local scope")
        const listed = JSON.parse((await tool.execute({ mode: "list" }, c)).output) as { note: string; runs: Array<{ asyncID: string }> }
        expect(listed.note).toContain("unknown tasks are stale records")
        await tool.execute({ mode: "remove", asyncID: listed.runs[0]!.asyncID }, c)
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("counts task limits across executors by scope", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const c = await ctx("executor bucket", dir)
        for (let i = 0; i < 3; i++) await tool.execute({ command: `local ${i}`, read_timeout: 0 }, c)
        for (let i = 0; i < 2; i++) await tool.execute({ command: `remote ${i}`, executor: "box", read_timeout: 0 }, c)

        await expect(tool.execute({ command: "remote 3", executor: "other", read_timeout: 0 }, c)).rejects.toThrow(
          "Too many running exbash tasks in local scope (6/5)",
        )
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("attach requires a known opencode run and forwards to REC", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const c = await ctx("attach", dir)
        const result = await tool.execute({ command: "cat", read_timeout: 0 }, c)
        const id = result.metadata.asyncID as string

        await expect(tool.execute({ mode: "attach", asyncID: "missing", text: "x" }, c)).rejects.toThrow("Async run not found")
        await tool.execute({ mode: "attach", asyncID: id, text: "fallback\n", timeout: 123 }, c)
        expect(calls.at(-1)).toMatchObject({ tool: "exbash_attach", args: { asyncID: id, text: "fallback\n", read_timeout: 123 } })
        expect(calls.at(-1)?.args.timeout).toBeUndefined()

        await tool.execute({ mode: "attach", asyncID: id, text: "hello\n", read_timeout: -1, timeout: 123 }, c)

        expect(calls.at(-1)).toMatchObject({
          tool: "exbash_attach",
          args: {
            asyncID: id,
            text: "hello\n",
            read_timeout: -1,
            directory: dir,
          },
        })
        expect(calls.at(-1)?.args.timeout).toBeUndefined()

        await tool.execute({ mode: "attach", asyncID: id, text: "long\n", read_timeout: 40_000 }, c)
        expect(calls.at(-1)).toMatchObject({ tool: "exbash_attach", opts: { timeout: 45_000 } })
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("remove drops the opencode task row", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const c = await ctx("remove", dir)
        const result = await tool.execute({ command: "sleep 1", read_timeout: 0 }, c)
        const id = result.metadata.asyncID as string

        await tool.execute({ mode: "remove", asyncID: id }, c)
        const listed = JSON.parse((await tool.execute({ mode: "list", asyncID: id }, c)).output) as { runs: Array<unknown> }

        expect(calls.at(-2)).toMatchObject({ tool: "exbash_remove", args: { asyncID: id } })
        expect(listed.runs).toHaveLength(0)
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("remove drops stopped opencode task row when REC remove fails", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const c = await ctx("remove stale stopped", dir)
        const result = await tool.execute({ command: "sleep 1", read_timeout: 0 }, c)
        const id = result.metadata.asyncID as string
        await tool.execute({ mode: "stop", asyncID: id }, c)
        call.mockImplementation(async (tool, args) => {
          calls.push({ tool, args })
          if (tool === "exbash_remove") throw new Error("not found in REC")
          return { title: tool, metadata: { runs: [] }, output: "{}" }
        })

        const removed = await tool.execute({ mode: "remove", asyncID: id }, c)
        const listed = JSON.parse((await tool.execute({ mode: "list", asyncID: id }, c)).output) as { runs: Array<unknown> }

        expect(removed.metadata).toMatchObject({ asyncID: id, executor: "local", state: "stopped", removed: true, remoteError: "not found in REC" })
        expect(listed.runs).toHaveLength(0)
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("stop returns stable opencode task metadata", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const c = await ctx("stop", dir)
        const result = await tool.execute({ command: "sleep 1", description: "DESC_QUICK_DONE_TEST", read_timeout: 0, timeout: 10000 }, c)
        const id = result.metadata.asyncID as string

        const stopped = await tool.execute({ mode: "stop", asyncID: id }, c)
        const first = (JSON.parse((await tool.execute({ mode: "list", asyncID: id }, c)).output) as { runs: Array<{ endedAt?: number }> }).runs[0]
        const second = (JSON.parse((await tool.execute({ mode: "list", asyncID: id }, c)).output) as { runs: Array<{ endedAt?: number }> }).runs[0]

        expect(stopped.metadata).toMatchObject({
          asyncID: id,
          description: "DESC_QUICK_DONE_TEST",
          command: "sleep 1",
          cwd: dir,
          state: "stopped",
          exitCode: 0,
        })
        expect(stopped.metadata.timeout).toBeUndefined()
        expect(first?.endedAt).toBe(second?.endedAt)
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("denies before calling REC when permissions reject", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        await expect(
          tool.execute(
            { command: "echo blocked" },
            await ctx("deny", dir, [
              { permission: "exbash_executor", pattern: "*", action: "deny" },
              { permission: "bash", pattern: "*", action: "allow" },
            ]),
          ),
        ).rejects.toThrow("The user has specified a rule")

        expect(calls).toHaveLength(0)
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("skips local command permissions for remote executor", async () => {
    const call = mock()
    try {
      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        await tool.execute(
          { command: "echo remote", executor: "box", read_timeout: 0 },
          await ctx("remote bypass", dir, [
            { permission: "exbash_executor", pattern: "*", action: "deny" },
            { permission: "bash", pattern: "*", action: "deny" },
          ]),
        )

        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ tool: "exbash_shell", args: { executor: "box", command: "echo remote" } })
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("probes untracked remote ptys without binding them", async () => {
    const call = mock()
    try {
      call.mockImplementation(async (tool, args) => {
        calls.push({ tool, args })
        if (tool === "exbash_list") {
          return {
            title: "Async runs listed",
            metadata: {
              runs: [
                {
                  asyncID: "rex-foreign",
                  command: "top",
                  description: "top",
                  cwd: "/tmp",
                  state: "running",
                  status: "running",
                  totalOutput: 0,
                  startedAt: Date.now(),
                },
              ],
            },
            output: "rex-foreign running totalOutput=0 command=top",
          }
        }
        if (tool === "exbash_attach") return { title: "Async input sent", metadata: { asyncID: "rex-foreign", wrote: 1 }, output: "ok" }
        if (tool === "exbash_stop") return { title: "Async run stopped", metadata: { asyncID: "rex-foreign", state: "stopped", exitCode: 0 }, output: "" }
        return { title: tool, metadata: {}, output: "" }
      })

      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const c = await ctx("remote probe", dir)
        const listed = JSON.parse((await tool.execute({ mode: "list", executor: "box" }, c)).output) as {
          runs: Array<unknown>
          untracked: Array<{ asyncID: string; executor: string; tracked: boolean }>
        }

        expect(listed.runs).toHaveLength(0)
        expect(listed.untracked).toMatchObject([{ asyncID: "rex-foreign", executor: "box", tracked: false }])
        const attached = await tool.execute({ mode: "attach", asyncID: "rex-foreign", executor: "box", text: "x" }, c)
        const stopped = await tool.execute({ mode: "stop", asyncID: "rex-foreign", executor: "box" }, c)
        const again = JSON.parse((await tool.execute({ mode: "list", executor: "box" }, c)).output) as { runs: Array<unknown> }

        expect(attached.metadata).toMatchObject({ asyncID: "rex-foreign", executor: "box", tracked: false })
        expect(stopped.metadata).toMatchObject({ asyncID: "rex-foreign", executor: "box", tracked: false, state: "stopped" })
        expect(again.runs).toHaveLength(0)
        await expect(tool.execute({ mode: "remove", asyncID: "rex-foreign", executor: "box" }, c)).rejects.toThrow("Async run not found")
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("remote list without scope probes all remote ptys", async () => {
    const call = mock()
    try {
      call.mockImplementation(async (tool, args) => {
        calls.push({ tool, args })
        if (tool === "exbash_list") {
          return {
            title: "Async runs listed",
            metadata: {
              runs: [
                { asyncID: "rex-one", command: "one", description: "one", cwd: "/tmp", state: "running", status: "running", totalOutput: 0, startedAt: 1 },
                { asyncID: "rex-two", command: "two", description: "two", cwd: "/tmp", state: "running", status: "running", totalOutput: 0, startedAt: 2 },
              ],
            },
            output: "rex-one running\nrex-two running",
          }
        }
        return { title: tool, metadata: {}, output: "" }
      })

      await repo(async (dir) => {
        const tool = await ExBashTool.init()
        const c = await ctx("remote all", dir)
        const all = JSON.parse((await tool.execute({ mode: "list", executor: "box" }, c)).output) as {
          untracked: Array<{ asyncID: string }>
        }

        expect(calls.at(-1)).toMatchObject({ tool: "exbash_list", args: { executor: "box" } })
        expect(calls.at(-1)?.args.asyncID).toBeUndefined()
        expect(all.untracked.map((item) => item.asyncID)).toEqual(["rex-one", "rex-two"])
      })
    } finally {
      call.mockRestore()
    }
  })
})
