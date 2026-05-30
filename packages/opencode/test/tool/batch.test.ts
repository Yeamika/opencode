import { afterEach, describe, expect, test } from "bun:test"
import { BatchTool } from "../../src/tool/batch"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  messageID: MessageID.ascending(),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.batch", () => {
  test("aggregates per-call output and errors", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "batch aggregate" })
        const batch = await BatchTool.init()
        const result = await batch.execute(
          {
            tool_calls: [
              { tool: "invalid", parameters: { tool: "demo", error: "bad input" } },
              { tool: "missingTool", parameters: {} },
            ],
          },
          { ...ctx, sessionID: session.id },
        )
        expect(result.metadata.successful).toBe(1)
        expect(result.metadata.failed).toBe(1)
        expect(result.output).toContain("1. invalid: success")
        expect(result.output).toContain("The arguments provided to the tool are invalid: bad input")
        expect(result.output).toContain("2. missingTool: failed")
        expect(result.output).toContain("Tool 'missingTool' not in registry")
        expect(result.metadata.details).toEqual([
          { index: 0, tool: "invalid", success: true, title: "Invalid Tool", metadata: { truncated: false } },
          expect.objectContaining({ index: 1, tool: "missingTool", success: false }),
        ])
      },
    })
  })
})
