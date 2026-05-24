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

const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
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
  return spyOn(RemoteExecutor, "call").mockImplementation(async (tool, args) => {
    calls.push({ tool, args })
    if (tool === "exbash") {
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
            .filter((item) => item.tool === "exbash")
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
          tool: "exbash",
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

        const listed = JSON.parse((await tool.execute({ mode: "list", asyncID: id }, two)).output) as { runs: Array<{ asyncID: string; scope: string; executor: string }> }

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

        const local = JSON.parse((await tool.execute({ mode: "list", asyncID: id }, c)).output) as { runs: Array<unknown> }
        const remote = JSON.parse((await tool.execute({ mode: "list", asyncID: id, executor: "box" }, c)).output) as { runs: Array<{ asyncID: string; executor: string }> }

        expect(calls[0]).toMatchObject({ tool: "exbash", args: { executor: "box" } })
        expect(result.metadata.executor).toBe("box")
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
        for (let i = 0; i < 10; i++) await tool.execute({ command: `sleep ${i}`, read_timeout: 0 }, c)

        await expect(tool.execute({ command: "sleep 10", read_timeout: 0 }, c)).rejects.toThrow("Too many running exbash tasks in local scope")
        const listed = JSON.parse((await tool.execute({ mode: "list" }, c)).output) as { note: string; runs: Array<{ asyncID: string }> }
        expect(listed.note).toContain("unknown tasks are stale records")
        await tool.execute({ mode: "remove", asyncID: listed.runs[0]!.asyncID }, c)
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
})
