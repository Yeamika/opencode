import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { RgTool } from "../../src/tool/refs-tools"
import { RemoteExecutor } from "../../src/tool/remote_executor"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const calls: Array<{ tool: string; args: Record<string, unknown> }> = []

afterEach(async () => {
  calls.length = 0
  await Instance.disposeAll()
})

function mock() {
  return spyOn(RemoteExecutor, "call").mockImplementation(async (tool, args) => {
    calls.push({ tool, args })
    return { title: tool, metadata: {}, output: "" }
  })
}

async function repo(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn })
}

describe("remote executor path handling", () => {
  test.serial("search tools omit local cwd for remote defaults", async () => {
    const call = mock()
    try {
      await repo(async () => {
        await (await GrepTool.init()).execute({ pattern: "needle", executor: "box" }, ctx)
        await (await GlobTool.init()).execute({ pattern: "**/*.ts", executor: "box" }, ctx)
        await (await RgTool.init()).execute({ pattern: "needle", executor: "box" }, ctx)

        expect(calls[0]).toMatchObject({ tool: "grep", args: { pattern: "needle", executor: "box" } })
        expect(calls[0]!.args).not.toHaveProperty("path")
        expect(calls[1]).toMatchObject({ tool: "glob", args: { pattern: "**/*.ts", executor: "box" } })
        expect(calls[1]!.args).not.toHaveProperty("path")
        expect(calls[2]).toMatchObject({ tool: "rg", args: { pattern: "needle", executor: "box" } })
        expect(calls[2]!.args).not.toHaveProperty("root")
        expect(calls[2]!.args).not.toHaveProperty("path")
      })
    } finally {
      call.mockRestore()
    }
  })

  test.serial("search tools pass remote paths through as opaque strings", async () => {
    const call = mock()
    try {
      await repo(async () => {
        await (await GrepTool.init()).execute({ pattern: "needle", path: "/remote/project", executor: "box" }, ctx)
        await (await GlobTool.init()).execute({ pattern: "**/*.ts", path: "/remote/project", executor: "box" }, ctx)
        await (await RgTool.init()).execute(
          { pattern: "needle", root: "/remote/project", path: "src", executor: "box" },
          ctx,
        )

        expect(calls[0]).toMatchObject({ tool: "grep", args: { path: "/remote/project" } })
        expect(calls[1]).toMatchObject({ tool: "glob", args: { path: "/remote/project" } })
        expect(calls[2]).toMatchObject({ tool: "rg", args: { root: "/remote/project", path: "src" } })
      })
    } finally {
      call.mockRestore()
    }
  })
})
