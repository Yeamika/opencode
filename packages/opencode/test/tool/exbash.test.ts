import { describe, expect, test } from "bun:test"
import path from "path"
import { Shell } from "../../src/shell/shell"
import { ExBashTool } from "../../src/tool/exbash"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util/filesystem"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

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

Shell.acceptable.reset()

const projectRoot = path.join(__dirname, "../..")
const bin = `"${process.execPath.replaceAll("\\", "/")}"`
const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? `"${text}"` : `'${text}'`)

const poll = async <T>(fn: () => Promise<T | undefined>, ms = 2_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await fn()
    if (value !== undefined) return value
    await Bun.sleep(25)
  }
  throw new Error("timed out waiting for exbash state")
}

const mkctx = (session: string, directory?: string) => ({
  ...ctx,
  sessionID: SessionID.make(session),
  directory,
})

describe("tool.exbash", () => {
  test("runs sync exec mode like bash", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const result = await exbash.execute(
          {
            mode: "exec",
            command: "echo test",
            description: "Echo test message",
          },
          ctx,
        )
        expect(result.metadata.exit).toBe(0)
        expect(result.output).toContain("test")
      },
    })
  })

  test("lists async runs and reports timeout stop state", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const started = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "exec",
                command: `${bin} -e ${evalarg('setInterval(() => console.log("tick"), 25)')}`,
                description: "Timed async run",
                async: true,
                timeout: 120,
              },
              ctx,
            )
          ).output,
        ) as {
          asyncID: string
          resultPath: string
        }

        expect(started.asyncID).toBeTruthy()
        expect(started.resultPath).toBeTruthy()

        const run = await poll(async () => {
          const listed = JSON.parse(
            (
              await exbash.execute(
                {
                  mode: "list",
                  asyncID: started.asyncID,
                },
                ctx,
              )
            ).output,
          ) as {
            runs: Array<{
              asyncID: string
              status: string
              linePointer: number
              resultPath: string
            }>
          }
          const item = listed.runs[0]
          if (!item || !item.status.includes("timeout")) return
          return item
        })

        expect(run.asyncID).toBe(started.asyncID)
        expect(run.linePointer).toBeGreaterThan(0)
        expect(run.resultPath).toBe(started.resultPath)
        expect(await Filesystem.readText(run.resultPath)).toContain("tick")
      },
    })
  })

  test("stops and removes async runs", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const started = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "exec",
                command: `${bin} -e ${evalarg('setInterval(() => console.log("alive"), 25)')}`,
                description: "Manual async run",
                async: true,
              },
              ctx,
            )
          ).output,
        ) as {
          asyncID: string
        }

        const stopped = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "control",
                asyncID: started.asyncID,
                action: "stop",
              },
              ctx,
            )
          ).output,
        ) as {
          asyncID: string
          status: string
        }

        expect(stopped.asyncID).toBe(started.asyncID)
        expect(stopped.status).toContain("killed")

        const removed = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "control",
                asyncID: started.asyncID,
                action: "remove",
              },
              ctx,
            )
          ).output,
        ) as {
          asyncID: string
          removed: boolean
        }

        expect(removed.asyncID).toBe(started.asyncID)
        expect(removed.removed).toBe(true)

        const listed = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "list",
                asyncID: started.asyncID,
              },
              ctx,
            )
          ).output,
        ) as {
          runs: Array<unknown>
        }

        expect(listed.runs).toHaveLength(0)
      },
    })
  })

  test("limits local tasks to one session and workspace tasks to one workspace", async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()

    const ids = await Instance.provide({
      directory: a.path,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const one = mkctx("ses_scope_1", a.path)
        const two = mkctx("ses_scope_2", a.path)

        const local = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "exec",
                command: `${bin} -e ${evalarg('setInterval(() => console.log("local"), 25)')}`,
                description: "Local scoped run",
                async: true,
                scope: "local",
              },
              one,
            )
          ).output,
        ) as {
          asyncID: string
          scope: string
        }

        expect(local.scope).toBe("local")

        const own = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "list",
                asyncID: local.asyncID,
              },
              one,
            )
          ).output,
        ) as {
          runs: Array<{ asyncID: string }>
        }

        const other = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "list",
                asyncID: local.asyncID,
              },
              two,
            )
          ).output,
        ) as {
          runs: Array<{ asyncID: string }>
        }

        expect(own.runs.map((item) => item.asyncID)).toContain(local.asyncID)
        expect(other.runs).toHaveLength(0)

        const shared = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "exec",
                command: `${bin} -e ${evalarg('setInterval(() => console.log("workspace"), 25)')}`,
                description: "Workspace scoped run",
                async: true,
                scope: "workspace",
              },
              one,
            )
          ).output,
        ) as {
          asyncID: string
          scope: string
        }

        expect(shared.scope).toBe("workspace")

        const same = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "list",
                asyncID: shared.asyncID,
              },
              two,
            )
          ).output,
        ) as {
          runs: Array<{ asyncID: string }>
        }

        expect(same.runs.map((item) => item.asyncID)).toContain(shared.asyncID)
        return { local: local.asyncID, shared: shared.asyncID }
      },
    })

    await Instance.provide({
      directory: b.path,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const three = mkctx("ses_scope_3", b.path)
        const listed = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "list",
                asyncID: ids.shared,
              },
              three,
            )
          ).output,
        ) as {
          runs: Array<unknown>
        }

        expect(listed.runs).toHaveLength(0)
      },
    })

    await Instance.provide({
      directory: a.path,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const one = mkctx("ses_scope_1", a.path)
        await exbash.execute({ mode: "control", asyncID: ids.local, action: "stop" }, one)
        await exbash.execute({ mode: "control", asyncID: ids.local, action: "remove" }, one)
        await exbash.execute({ mode: "control", asyncID: ids.shared, action: "stop" }, one)
        await exbash.execute({ mode: "control", asyncID: ids.shared, action: "remove" }, one)
      },
    })
  })
})
