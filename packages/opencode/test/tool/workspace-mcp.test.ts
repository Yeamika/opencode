import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { WorkspaceMcpTool } from "../../src/tool/workspace_mcp"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
  delete process.env.OPENCODE_TEST_HOME
})

describe("workspaceMcp", () => {
  test("allows local writes when the session directory is the user home", async () => {
    await using tmp = await tmpdir()
    process.env.OPENCODE_TEST_HOME = tmp.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await WorkspaceMcpTool.init()
        const result = await tool.execute(
          {
            mode: "write",
            scope: "local",
            name: "demo-home-entry",
            value: '{"type":"remote","url":"http://host.docker.internal:8811/mcp"}',
          },
          {
            sessionID: "ses_test_workspace_mcp" as any,
            messageID: "msg_test_workspace_mcp" as any,
            agent: "build",
            abort: AbortSignal.any([]),
            directory: tmp.path,
            worktree: tmp.path,
            messages: [],
            metadata() {},
            ask: async () => {},
          },
        )

        const file = path.join(Global.Path.home, ".opencode", "opencode.json")
        const json = JSON.parse(await fs.readFile(file, "utf-8"))

        expect(result.metadata.file).toBe(file)
        expect(json.mcp["demo-home-entry"]).toEqual({
          type: "remote",
          url: "http://host.docker.internal:8811/mcp",
        })
      },
    })
  })

  test("rejects invalid MCP entries before writing config", async () => {
    await using tmp = await tmpdir()
    process.env.OPENCODE_TEST_HOME = tmp.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await WorkspaceMcpTool.init()
        await expect(
          tool.execute(
            {
              mode: "write",
              scope: "local",
              name: "bad-entry",
              value: '{"type":"remote"}',
            },
            {
              sessionID: "ses_test_workspace_mcp" as any,
              messageID: "msg_test_workspace_mcp" as any,
              agent: "build",
              abort: AbortSignal.any([]),
              directory: tmp.path,
              worktree: tmp.path,
              messages: [],
              metadata() {},
              ask: async () => {},
            },
          ),
        ).rejects.toThrow("Invalid MCP configuration")

        const file = path.join(Global.Path.home, ".opencode", "opencode.json")
        await expect(fs.readFile(file, "utf-8")).rejects.toBeTruthy()
      },
    })
  })
})
