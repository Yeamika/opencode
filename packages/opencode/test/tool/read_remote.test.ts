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

test("resolves local read refs back to file paths", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const call = spyOn(RemoteExecutor, "call").mockImplementation(async (tool, args) => {
    calls.push({ tool, args })
    return {
      title: "Local read",
      output: "local",
      metadata: {
        file: {
          fileKey: "local-ref-key",
          canonicalPath: String(args.filePath),
          kind: "file",
        },
        hashCode: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    }
  })

  try {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const target = path.join(tmp.path, "local.txt")
        await fs.writeFile(target, "hello")
        const session = await Session.create({ title: "read local ref" })
        const read = await ReadTool.init()
        const first = await read.execute({ filePath: target }, { ...ctx, sessionID: session.id })
        const ref = first.metadata.fileRef as string
        await read.execute({ filePath: ref, executor: "box" }, { ...ctx, sessionID: session.id })

        expect(calls[1]).toMatchObject({ tool: "read", args: { filePath: target } })
        expect(calls[1]!.args).not.toHaveProperty("executor")
      },
    })
  } finally {
    call.mockRestore()
  }
})

test("resolves remote read refs back to executor and file path", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const stats: Array<{ filePath: string; executor?: string }> = []
  const stat = spyOn(RemoteExecutor, "stat").mockImplementation(async (filePath, executor) => {
    stats.push({ filePath, executor })
    return {
      fileKey: `remote:${filePath}`,
      canonicalPath: filePath,
      kind: "file",
    }
  })
  const call = spyOn(RemoteExecutor, "call").mockImplementation(async (tool, args) => {
    calls.push({ tool, args })
    return {
      title: "Remote read",
      output: "remote",
      metadata: {
        file: {
          fileKey: `remote:${args.filePath}`,
          canonicalPath: String(args.filePath),
          kind: "file",
        },
        hashCode: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      },
    }
  })

  try {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "read remote ref" })
        const read = await ReadTool.init()
        const first = await read.execute({ filePath: "/remote/project/a.txt", executor: "box" }, { ...ctx, sessionID: session.id })
        const ref = first.metadata.fileRef as string
        calls.length = 0
        stats.length = 0

        await read.execute({ filePath: ref, limit: 10 }, { ...ctx, sessionID: session.id })

        expect(stats[0]).toEqual({ filePath: "/remote/project/a.txt", executor: "box" })
        expect(calls[0]).toMatchObject({
          tool: "read",
          args: { filePath: "/remote/project/a.txt", executor: "box", hashCheckMode: true, limit: 10 },
        })
      },
    })
  } finally {
    stat.mockRestore()
    call.mockRestore()
  }
})
