import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { EditTool } from "../../src/tool/edit"
import { ReadTool } from "../../src/tool/read"
import { MultiEditTool } from "../../src/tool/multiedit"
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

describe("tool.edit", () => {
  test("creates a new local text file and returns a file reference", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "edit create" })
        const ctx = { ...baseCtx, sessionID: session.id }
        const filepath = path.join(tmp.path, "newfile.txt")

        const edit = await EditTool.init()
        const result = await edit.execute({ filePath: filepath, oldString: "", newString: "new content" }, ctx)

        expect(await fs.readFile(filepath, "utf-8")).toBe("new content")
        expect(result.metadata.fileRef).toMatch(/^newfile\.txt #[0-9A-F]{4}$/)
      },
    })
  })

  test("edits an existing file using a read reference", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "edit existing" })
        const ctx = { ...baseCtx, sessionID: session.id }
        const filepath = path.join(tmp.path, "existing.txt")
        await fs.writeFile(filepath, "old content here\n", "utf-8")
        const fileRef = await readRef(filepath, ctx)

        const edit = await EditTool.init()
        const result = await edit.execute({ filePath: fileRef, oldString: "old content", newString: "new content" }, ctx)

        expect(await fs.readFile(filepath, "utf-8")).toBe("new content here\n")
        expect(result.output).toContain("<fileRef>existing.txt #")
      },
    })
  })

  test("rejects existing file edits without a read reference", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "edit requires ref" })
        const ctx = { ...baseCtx, sessionID: session.id }
        const filepath = path.join(tmp.path, "file.txt")
        await fs.writeFile(filepath, "content", "utf-8")

        const edit = await EditTool.init()
        await expect(
          edit.execute({ filePath: filepath, oldString: "content", newString: "next" }, ctx),
        ).rejects.toThrow("Existing files must be edited using a read reference")
      },
    })
  })

  test("multi-edit carries forward the refreshed file reference", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "multiedit refs" })
        const ctx = { ...baseCtx, sessionID: session.id }
        const filepath = path.join(tmp.path, "multi.txt")
        await fs.writeFile(filepath, "one\ntwo\nthree\n", "utf-8")
        const fileRef = await readRef(filepath, ctx)

        const multi = await MultiEditTool.init()
        const result = await multi.execute(
          {
            filePath: fileRef,
            edits: [
              { oldString: "one", newString: "1" },
              { oldString: "three", newString: "3" },
            ],
          },
          ctx,
        )

        expect(await fs.readFile(filepath, "utf-8")).toBe("1\ntwo\n3\n")
        expect(result.metadata.fileRef).toMatch(/^multi\.txt #[0-9A-F]{4}$/)
      },
    })
  })
})
