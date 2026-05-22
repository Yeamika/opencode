import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import { ExecutorManagerTool } from "../../src/tool/executor_manager"
import { tmpdir } from "../fixture/fixture"

type Out = {
  bridge: { running: boolean }
  workspaceFile: string
  user: Array<{ id: string; connected: boolean }>
  workspace: Array<{ id: string; connected: boolean }>
  executors: Array<{ id: string; connected: boolean }>
}

const base = {
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const prev = process.env.OPENCODE_TEST_HOME

afterEach(() => {
  if (prev === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = prev
})

async function ctx(title: string, dir: string) {
  const session = await Session.create({ title })
  return {
    ...base,
    sessionID: session.id,
    directory: dir,
  }
}

async function repo<T>(fn: (dir: string, home: string) => Promise<T>) {
  await using home = await tmpdir()
  await using tmp = await tmpdir({ git: true })
  process.env.OPENCODE_TEST_HOME = home.path
  const { project } = await Project.fromDirectory(tmp.path)
  await Instance.reload({ directory: tmp.path, project, worktree: tmp.path })
  return await Instance.provide({ directory: tmp.path, fn: () => fn(tmp.path, home.path) })
}

describe("tool.executorManager", () => {
  test.serial("manages workspace and user executor info files", async () => {
    await repo(async (dir, home) => {
      const tool = await ExecutorManagerTool.init()
      const c = await ctx("workspace executors", dir)

      let result = await tool.execute({ mode: "add", id: "box", url: "ws://box:9001" }, c)
      let list = JSON.parse(result.output) as Out
      expect(list.workspace.map((item) => item.id)).toEqual(["box"])
      expect(list.executors.map((item) => item.id)).toContain("local")
      expect(list.bridge.running).toBe(false)
      expect(list.executors.find((item) => item.id === "local")?.connected).toBe(false)
      expect(list.executors.find((item) => item.id === "box")?.connected).toBe(false)
      expect(path.basename(list.workspaceFile)).toBe("remote_executor_infos.json")
      expect(list.workspaceFile.startsWith(dir)).toBe(true)
      expect(await Bun.file(list.workspaceFile).json()).toMatchObject({
        executors: [{ id: "box", url: "ws://box:9001" }],
      })

      await expect(tool.execute({ mode: "remove", id: "local" }, c)).rejects.toThrow("local executor")
      await expect(tool.execute({ mode: "add", scope: "user", id: "shared", url: "ws://shared:9001" }, c)).rejects.toThrow("user scope")
      await expect(tool.execute({ mode: "reconnect" }, c)).rejects.toThrow("id is required for reconnect")
      await expect(tool.execute({ mode: "reconnect", id: "missing" }, c)).rejects.toThrow("executor not configured")

      await tool.execute({ mode: "add", scope: "user", id: "shared", url: "ws://shared:9001" }, await ctx("user executors", home))
      result = await tool.execute({ mode: "list" }, c)
      list = JSON.parse(result.output) as Out
      expect(list.user.map((item) => item.id)).toEqual(["shared"])
      expect(list.workspace.map((item) => item.id)).toEqual(["box"])
      expect(list.executors.map((item) => item.id)).toEqual(["local", "box", "shared"])

      await tool.execute({ mode: "remove", id: "box" }, c)
      result = await tool.execute({ mode: "list" }, c)
      list = JSON.parse(result.output) as Out
      expect(list.executors.map((item) => item.id)).toEqual(["local", "shared"])
    })
  })
})
