import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { ReadTool } from "../../src/tool/read"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { mockRemoteExecutor } from "./remote_executor_mock"

let restoreRemote: (() => void) | undefined

beforeEach(() => {
  restoreRemote = mockRemoteExecutor()
})

afterEach(async () => {
  restoreRemote?.()
  restoreRemote = undefined
  await Instance.disposeAll()
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

describe("tool.apply_patch REC line patch", () => {
  test("requires patchText", async () => {
    await using fixture = await tmpdir({ git: true })
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await Session.create({ title: "apply patch requires patch" })
        const tool = await ApplyPatchTool.init()
        await expect(
          tool.execute({ filePath: "missing #A1B2", patchText: "" }, { ...baseCtx, sessionID: session.id }),
        ).rejects.toThrow("patchText is required")
      },
    })
  })

  test("requires a read file reference", async () => {
    await using fixture = await tmpdir({ git: true })
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await Session.create({ title: "apply patch requires ref" })
        const tool = await ApplyPatchTool.init()
        await expect(
          tool.execute({ patchText: "replace 1 1\n+next" }, { ...baseCtx, sessionID: session.id }),
        ).rejects.toThrow('filePath is required and must be a read reference like "App.ts #A1B2"')
      },
    })
  })

  test("applies a line patch to a recently read file", async () => {
    await using fixture = await tmpdir({ git: true })
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "target.txt")
        await fs.writeFile(target, "line1\nline2\n", "utf-8")
        const session = await Session.create({ title: "apply patch line" })
        const ctx = { ...baseCtx, sessionID: session.id }
        const read = await ReadTool.init()
        const readResult = await read.execute({ filePath: target }, ctx)
        const fileRef = readResult.metadata.fileRef as string

        const tool = await ApplyPatchTool.init()
        const result = await tool.execute({ filePath: fileRef, patchText: "replace 2 2\n+changed" }, ctx)

        expect(await fs.readFile(target, "utf-8")).toBe("line1\nchanged\n")
        expect(result.output).toContain("<fileRef>target.txt #")
        expect(result.metadata.fileRef).toMatch(/^target\.txt #[0-9A-F]{4}$/)
        expect(result.metadata.files[0].before).toBe("")
        expect(result.metadata.files[0].after).toBe("")
      },
    })
  })

  test("applies a binary patch to a recently read binary file", async () => {
    await using fixture = await tmpdir({ git: true })
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "target.bin")
        await fs.writeFile(target, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]))
        const session = await Session.create({ title: "apply patch binary" })
        const ctx = { ...baseCtx, sessionID: session.id }
        const read = await ReadTool.init()
        const readResult = await read.execute({ filePath: target, mode: "binary", offset: 0 }, ctx)
        const fileRef = readResult.metadata.fileRef as string

        const tool = await ApplyPatchTool.init()
        const result = await tool.execute(
          {
            filePath: fileRef,
            patchMode: "binary",
            patchText: "insert 0\n+FE\nreplace 1 2\n+AA BB\ndelete 4 1\ninsert -1\n+CC\n+DD",
          },
          ctx,
        )

        expect(Array.from(await fs.readFile(target))).toEqual([0xfe, 0x00, 0xaa, 0xbb, 0x03, 0xcc, 0xdd])
        expect(result.output).toContain("<fileRef>target.bin #")
        expect(result.metadata.fileRef).toMatch(/^target\.bin #[0-9A-F]{4}$/)
        expect(result.metadata.files[0].type).toBe("binary-update")
        expect(result.metadata.files[0].diff).toContain("--- target.bin")
        expect(result.metadata.files[0].diff).toContain("+++ target.bin")
        expect(result.metadata.files[0].diff).toContain("-Binary before: 00 01 02 03 04")
        expect(result.metadata.files[0].diff).toContain("+Binary after:  FE 00 AA BB 03 CC DD")
        expect(result.metadata.files[0].before).toBe("")
        expect(result.metadata.files[0].after).toBe("")
      },
    })
  })

  test("rejects stale hashes", async () => {
    await using fixture = await tmpdir({ git: true })
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "stale.txt")
        await fs.writeFile(target, "before\n", "utf-8")
        const session = await Session.create({ title: "apply patch stale" })
        const ctx = { ...baseCtx, sessionID: session.id }
        const read = await ReadTool.init()
        const readResult = await read.execute({ filePath: target }, ctx)
        await fs.writeFile(target, "external\n", "utf-8")

        const tool = await ApplyPatchTool.init()
        await expect(
          tool.execute({ filePath: readResult.metadata.fileRef as string, patchText: "replace 1 1\n+after" }, ctx),
        ).rejects.toThrow("hash mismatch")
      },
    })
  })

  test("passes old envelope rejection through REC", async () => {
    await using fixture = await tmpdir({ git: true })
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const target = path.join(fixture.path, "old.txt")
        await fs.writeFile(target, "before\n", "utf-8")
        const session = await Session.create({ title: "apply patch old envelope" })
        const ctx = { ...baseCtx, sessionID: session.id }
        const read = await ReadTool.init()
        const readResult = await read.execute({ filePath: target }, ctx)

        const tool = await ApplyPatchTool.init()
        await expect(
          tool.execute(
            { filePath: readResult.metadata.fileRef as string, patchText: "*** Begin Patch\n*** End Patch" },
            ctx,
          ),
        ).rejects.toThrow("old apply_patch envelope format is not supported")
      },
    })
  })
})
