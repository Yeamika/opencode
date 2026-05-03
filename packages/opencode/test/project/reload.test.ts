import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import type { Tool } from "ai"
import { MCP } from "../../src/mcp"
import { Instance } from "../../src/project/instance"
import { Reload } from "../../src/project/reload"
import { MessageID, SessionID } from "../../src/session/schema"
import { ReloadTool } from "../../src/tool/reload"
import { tmpdir } from "../fixture/fixture"

describe("project.reload", () => {
  afterEach(async () => {
    mock.restore()
    await Instance.disposeAll()
  })

  test("requester can arrive before other sessions", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a = SessionID.make("session_reload-a")
        const b = SessionID.make("session_reload-b")
        Reload.enter(Instance.directory, a)
        Reload.enter(Instance.directory, b)

        try {
          const promise = Reload.request(Instance.directory)
          Reload.arrive(Instance.directory, a)

          expect(await Promise.race([promise.then(() => "done"), Bun.sleep(50).then(() => "pending")])).toBe(
            "pending",
          )

          await Reload.wait(Instance.directory, b)
          await promise
          expect(Reload.status(Instance.directory)).toBe("idle")
        } finally {
          Reload.leave(Instance.directory, a)
          Reload.leave(Instance.directory, b)
        }
      },
    })
  })

  test("reload tool does not wait on its own session", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReloadTool.init()
        const sessionID = SessionID.make("session_reload-tool")
        Reload.enter(Instance.directory, sessionID)

        const task = tool.execute(
          {},
          {
            sessionID,
            messageID: MessageID.make("message_reload-tool"),
            callID: "call_reload-tool",
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: async () => {},
          },
        )

        try {
          const result = await Promise.race([
            task.then((value) => ({ type: "result" as const, value })),
            // This assertion is about self-wait deadlock, not sub-second timing.
            Bun.sleep(2000).then(() => ({ type: "timeout" as const })),
          ])

          expect(result.type).toBe("result")
          if (result.type === "result") {
            expect(result.value.title).toBe("Workspace reloaded")
            expect(result.value.output).toContain("Workspace inventory:")
            expect(result.value.output).toContain("Workspace tools:")
            expect(result.value.output).toContain("MCP servers:")
            expect(result.value.output).toContain("MCP tools:")
            expect(result.value.output).toContain("Skills:")
            expect(result.value.output).toContain("Current agent: build")
          }
        } finally {
          Reload.leave(Instance.directory, sessionID)
          await task.catch(() => undefined)
        }
      },
    })
  })

  test("reload tool reports added skills after reload", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReloadTool.init()
        const a = SessionID.make("session_reload-report-a")
        const b = SessionID.make("session_reload-report-b")
        Reload.enter(Instance.directory, a)
        Reload.enter(Instance.directory, b)

        const task = tool.execute(
          {},
          {
            sessionID: a,
            messageID: MessageID.make("message_reload-report"),
            callID: "call_reload-report",
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: async () => {},
          },
        )

        try {
          await Bun.sleep(50)
          const dir = path.join(tmp.path, ".opencode", "skills", "reload_test_skill")
          await fs.mkdir(dir, { recursive: true })
          await Bun.write(
            path.join(dir, "SKILL.md"),
            [
              "---",
              "name: reload_test_skill",
              "description: test skill added during reload",
              "---",
              "",
              "Reload test skill content.",
            ].join("\n"),
          )

          await Reload.wait(Instance.directory, b)
          const result = await task
          expect(result.output).toContain("Skills:")
          expect(result.output).toContain("(+1)")
          expect(result.output).toContain("Changes:")
          expect(result.output).toContain("Skills added: reload_test_skill")
        } finally {
          Reload.leave(Instance.directory, a)
          Reload.leave(Instance.directory, b)
          await task.catch(() => undefined)
        }
      },
    })
  })

  test("reload tool reports MCP tool count changes after reload", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReloadTool.init()
        const a = SessionID.make("session_reload-mcp-a")
        const b = SessionID.make("session_reload-mcp-b")
        Reload.enter(Instance.directory, a)
        Reload.enter(Instance.directory, b)

        const status = spyOn(MCP, "status").mockResolvedValue({
          "reload-mcp": { status: "connected" },
        } as any)

        let count = 0
        const tools = spyOn(MCP, "tools").mockImplementation(async (): Promise<Record<string, Tool>> => {
          count += 1
          if (count === 1) {
            return {
              reload_mcp_test_tool: {} as any,
            }
          }
          return {
            reload_mcp_test_tool: {} as any,
            reload_mcp_next_tool: {} as any,
          }
        })

        const task = tool.execute(
          {},
          {
            sessionID: a,
            messageID: MessageID.make("message_reload-mcp"),
            callID: "call_reload-mcp",
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: async () => {},
          },
        )

        try {
          await Bun.sleep(50)
          await Reload.wait(Instance.directory, b)
          const result = await task
          expect(result.output).toContain("MCP servers: 1 (no change)")
          expect(result.output).toContain("MCP tools: 1 -> 2 (+1)")
          expect(status).toHaveBeenCalledTimes(2)
          expect(tools).toHaveBeenCalledTimes(2)
        } finally {
          Reload.leave(Instance.directory, a)
          Reload.leave(Instance.directory, b)
          await task.catch(() => undefined)
        }
      },
    })
  })
})
