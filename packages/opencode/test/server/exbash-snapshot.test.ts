import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { ExBashTask } from "../../src/session/exbash"
import { RemoteExecutor } from "../../src/tool/remote_executor"
import { tmpdir } from "../fixture/fixture"

const calls: Array<{ tool: string; args: Record<string, unknown> }> = []

afterEach(async () => {
  calls.length = 0
  await Instance.disposeAll()
})

function mock() {
  return spyOn(RemoteExecutor, "call").mockImplementation(async (tool, args) => {
    calls.push({ tool, args })
    if (tool === "exbash_attach") return { title: "snapshot", metadata: { asyncID: args.asyncID }, output: "ok" }
    if (tool === "list_executor") {
      return { title: "executors", metadata: { executors: [{ id: "box", url: "ws://box" }] }, output: "" }
    }
    return { title: tool, metadata: {}, output: "" }
  })
}

describe("session exbash snapshot", () => {
  test.serial("does not pass local session directory to remote attach", async () => {
    const call = mock()
    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await ExBashTask.start({
            asyncID: "rex-snap",
            sessionID: session.id,
            workspace: session.directory,
            scope: "local",
            executor: "box",
            description: "remote",
            command: "sleep 1",
            cwd: "/remote/project",
            startedAt: Date.now(),
          })

          const response = await Server.Default().request(`/session/${session.id}/exbash/rex-snap/snapshot?executor=box`)

          expect(response.status).toBe(200)
          expect(calls[0]).toMatchObject({
            tool: "exbash_attach",
            args: { asyncID: "rex-snap", executor: "box", read_timeout: 0 },
          })
          expect(calls[0]!.args).not.toHaveProperty("directory")
        },
      })
    } finally {
      call.mockRestore()
    }
  })
})
