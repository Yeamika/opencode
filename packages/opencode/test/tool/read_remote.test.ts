import { afterEach, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { RemoteExecutor } from "../../src/tool/remote_executor"
import { ReadTool } from "../../src/tool/read"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import * as fs from "fs/promises"

afterEach(async () => {
  await Instance.disposeAll()
})

test("allows binary reads from byte offset zero", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const call = spyOn(RemoteExecutor, "call").mockImplementation(async (tool, args) => {
    calls.push({ tool, args })
    return {
      title: "Binary read",
      output: "binary",
      metadata: {
        file: {
          fileKey: "local-binary-key",
          canonicalPath: String(args.filePath),
          kind: "file",
        },
        hashCode: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    }
  })

  try {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const target = path.join(tmp.path, "binary.dat")
        await fs.writeFile(target, Buffer.from([0x00, 0x01]))
        const session = await Session.create({ title: "read binary zero" })
        const read = await ReadTool.init()
        await read.execute({ filePath: target, mode: "binary", offset: 0, limit: 1 }, { ...ctx, sessionID: session.id })
      },
    })

    expect(calls[0]).toMatchObject({
      tool: "read",
      args: {
        mode: "binary",
        offset: 0,
        limit: 1,
      },
    })
  } finally {
    call.mockRestore()
  }
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
  const stat = spyOn(RemoteExecutor, "stat").mockImplementation(async () => ({
    fileKey: "remote:/etc/os-release",
    canonicalPath: "/etc/os-release",
    kind: "file",
  }))
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
        hashCode: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    }
  })

  try {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "read remote" })
        const read = await ReadTool.init()
        await read.execute({ filePath: "/etc/os-release", executor: "box", offset: 1, limit: 5 }, { ...ctx, sessionID: session.id })
      },
    })

    expect(calls[0]).toMatchObject({
      tool: "read",
      args: {
        filePath: "/etc/os-release",
        executor: "box",
        hashCheckMode: true,
        offset: 1,
        limit: 5,
      },
    })
  } finally {
    stat.mockRestore()
    call.mockRestore()
  }
})
