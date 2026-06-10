import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { FileActionTool } from "../../src/tool/refs-tools"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: SessionID.make("ses_fileaction"),
  messageID: MessageID.make("msg_fileaction"),
  callID: "call_fileaction",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.FileAction", () => {
  test("returns diff metadata for direct binary patch mode", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await FileActionTool.init()
        const file = path.join(tmp.path, "sample.bin")
        await tool.execute({ mode: "create", fileKey: file, patchMode: "binary", content: "41424344" }, ctx)

        const result = await tool.execute(
          {
            mode: "patch",
            fileKey: file,
            patchMode: "binary",
            patchText: "***APPEND***-1-1:45",
          },
          ctx,
        )

        expect(Buffer.from(await Bun.file(file).arrayBuffer())).toEqual(Buffer.from("ABCDE"))
        expect(result.metadata.diff).toContain("---")
        expect(result.metadata.diff).toContain("00000000: 41 42 43 44")
        expect(result.metadata.diff).toContain("00000000: 41 42 43 44 45")
        expect(result.metadata.file).toMatchObject({ kind: "file" })
      },
    })
  })
})
