import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Reload } from "../../src/project/reload"
import { MessageID, SessionID } from "../../src/session/schema"
import { ReloadTool } from "../../src/tool/reload"
import { tmpdir } from "../fixture/fixture"

describe("project.reload", () => {
  afterEach(async () => {
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
            Bun.sleep(200).then(() => ({ type: "timeout" as const })),
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
})
