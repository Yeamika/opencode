import { afterEach, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { RemoteExecutor } from "../../src/tool/remote_executor"
import { ReadTool } from "../../src/tool/read"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

test("passes remote file paths through unchanged", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const call = spyOn(RemoteExecutor, "call").mockImplementation(async (tool, args) => {
    calls.push({ tool, args })
    return {
      title: "Remote read",
      output: "remote",
      metadata: {
        file: {
          fileKey: "remote:/etc/os-release",
          canonicalPath: "/etc/os-release",
          kind: "file",
        },
      },
    }
  })

  try {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        await read.execute({ filePath: "/etc/os-release", executor: "box", offset: 1, limit: 5 }, ctx)
      },
    })

    expect(calls[0]).toMatchObject({
      tool: "read",
      args: {
        filePath: "/etc/os-release",
        executor: "box",
        offset: 1,
        limit: 5,
      },
    })
  } finally {
    call.mockRestore()
  }
})
