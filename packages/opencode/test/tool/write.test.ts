import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { WriteTool } from "../../src/tool/write"
import { ReadTool } from "../../src/tool/refs-tools"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { mockRemoteExecutor } from "./remote_executor_mock"

let restoreRemote: (() => void) | undefined

beforeEach(() => {
  restoreRemote = mockRemoteExecutor()
})

const baseCtx = {
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

afterEach(async () => {
  restoreRemote?.()
  restoreRemote = undefined
  await Instance.disposeAll()
})

async function readRef(filePath: string, ctx: typeof baseCtx & { sessionID: Session.Info["id"] }) {
  const read = await ReadTool.init()
  const result = await read.execute({ filePath }, ctx)
  return result.metadata.fileRef as string
}

describe("tool.write", () => {
  test("writes a new local text file and returns a file reference", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "write create" })
        const ctx = { ...baseCtx, sessionID: session.id }
        const filepath = path.join(tmp.path, "newfile.txt")

        const write = await WriteTool.init()
        const result = await write.execute({ filePath: filepath, content: "Hello, World!" }, ctx)

        expect(await fs.readFile(filepath, "utf-8")).toBe("Hello, World!")
        expect(result.metadata.exists).toBe(false)
        expect(result.metadata.fileRef).toMatch(/^newfile\.txt #[0-9A-F]{4}$/)
      },
    })
  })

  test("overwrites an existing file using a read reference", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "write existing" })
        const ctx = { ...baseCtx, sessionID: session.id }
        const filepath = path.join(tmp.path, "existing.txt")
        await fs.writeFile(filepath, "old content\n", "utf-8")
        const fileRef = await readRef(filepath, ctx)

        const write = await WriteTool.init()
        const result = await write.execute({ filePath: fileRef, content: "new content\n" }, ctx)

        expect(await fs.readFile(filepath, "utf-8")).toBe("new content\n")
        expect(result.metadata.exists).toBe(true)
        expect(result.output).toContain("<fileRef>existing.txt #")
      },
    })
  })

  test("rejects overwriting existing files without a read reference", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "write requires ref" })
        const ctx = { ...baseCtx, sessionID: session.id }
        const filepath = path.join(tmp.path, "file.txt")
        await fs.writeFile(filepath, "content", "utf-8")

        const write = await WriteTool.init()
        await expect(write.execute({ filePath: filepath, content: "next" }, ctx)).rejects.toThrow(
          "Existing files must be written using a read reference",
        )
      },
    })
  })

  test("rejects binary writes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "write binary" })
        const ctx = { ...baseCtx, sessionID: session.id }
        const filepath = path.join(tmp.path, "binary.bin")

        const write = await WriteTool.init()
        await expect(write.execute({ filePath: filepath, content: "00", mode: "binary" }, ctx)).rejects.toThrow(
          "Binary write is not supported",
        )
      },
    })
  })
})
