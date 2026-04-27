import { describe, expect, test } from "bun:test"
import path from "path"
import z from "zod"
import "../../src/server/projectors"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { Shell } from "../../src/shell/shell"
import { ExBashTool } from "../../src/tool/exbash"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

const base = {
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

Shell.acceptable.reset()

const root = path.join(__dirname, "../..")
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

const mkctx = async (title: string, directory = root) => {
  const session = await Session.create({ title })
  return {
    ...base,
    sessionID: session.id,
    directory,
  }
}

describe("tool.exbash", () => {
  test("exports an object json schema", async () => {
    const exbash = await ExBashTool.init()
    expect(z.toJSONSchema(exbash.parameters).type).toBe("object")
  })

  test("runs sync exec mode like bash", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const ctx = await mkctx("sync exec")
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
      directory: root,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const ctx = await mkctx("timeout run")
        const started = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "exec_async",
                command: `${bin} -e ${evalarg('console.log("tick"); setInterval(() => {}, 25)')}`,
                description: "Timed async run",
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
              state: string
              exitCode?: number
              linePointer: number
              resultPath: string
            }>
          }
          const item = listed.runs[0]
          if (!item || item.state !== "stopped" || item.exitCode !== 124) return
          return item
        })

        expect(run.asyncID).toBe(started.asyncID)
        expect(run.status).toContain("exit 124")
        expect(run.resultPath).toBe(started.resultPath)
      },
    })
  })

  test("stops and removes async runs", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const ctx = await mkctx("manual run")
        const started = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "exec_async",
                command: `${bin} -e ${evalarg('setInterval(() => console.log("alive"), 25)')}`,
                description: "Manual async run",
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
          state: string
          exitCode?: number
        }

        expect(stopped.asyncID).toBe(started.asyncID)
        expect(stopped.state).toBe("stopped")
        expect(stopped.status).toContain("exit 130")

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

  test("writes text into async task stdin", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const ctx = await mkctx("text input run")
        const started = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "exec_async",
                command: `${bin} -e ${evalarg('process.stdin.on("data", (chunk) => { process.stdout.write("TEXT:" + chunk.toString()); process.exit(0) })')}`,
                description: "Text input run",
              },
              ctx,
            )
          ).output,
        ) as {
          asyncID: string
          resultPath: string
        }

        const wrote = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "input",
                asyncID: started.asyncID,
                wait: "attach",
                text: "ping",
              },
              ctx,
            )
          ).output,
        ) as {
          asyncID: string
          wait: string
          wrote: number
          source: string
          output: string
          bytes: number
          overflow: boolean
          timedOut: boolean
        }

        expect(wrote.asyncID).toBe(started.asyncID)
        expect(wrote.wait).toBe("attach")
        expect(wrote.wrote).toBe(4)
        expect(wrote.source).toBe("text")
        expect(wrote.output).toContain("TEXT:ping")
        expect(wrote.bytes).toBeGreaterThan(0)
        expect(wrote.overflow).toBe(false)
        expect(wrote.timedOut).toBe(false)

        await poll(async () => {
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
            runs: Array<{ status: string }>
          }
          if (!listed.runs[0]?.status.includes("exit 0")) return
          return listed.runs[0]
        })

        expect(await Filesystem.readText(started.resultPath)).toContain("TEXT:ping")
        await exbash.execute({ mode: "control", asyncID: started.asyncID, action: "remove" }, ctx)
      },
    })
  })

  test("writes file bytes into async task stdin", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "stdin.bin"), Buffer.from([0x00, 0x01, 0xff]))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const ctx = await mkctx("file input run", tmp.path)
        const file = path.join(tmp.path, "stdin.bin")
        const started = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "exec_async",
                command: `${bin} -e ${evalarg('process.stdin.on("data", (chunk) => { process.stdout.write(chunk.toString("hex")); process.exit(0) })')}`,
                description: "File input run",
              },
              ctx,
            )
          ).output,
        ) as {
          asyncID: string
          resultPath: string
        }

        const wrote = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "input",
                asyncID: started.asyncID,
                filePath: file,
              },
              ctx,
            )
          ).output,
        ) as {
          asyncID: string
          wrote: number
          source: string
        }

        expect(wrote.asyncID).toBe(started.asyncID)
        expect(wrote.wrote).toBe(3)
        expect(wrote.source).toBe("file")

        await poll(async () => {
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
            runs: Array<{ status: string }>
          }
          if (!listed.runs[0]?.status.includes("exit 0")) return
          return listed.runs[0]
        })

        expect(await Filesystem.readText(started.resultPath)).toContain("0001ff")
        await exbash.execute({ mode: "control", asyncID: started.asyncID, action: "remove" }, ctx)
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
        const one = await mkctx("scope one", a.path)
        const two = await mkctx("scope two", a.path)

        const local = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "exec_async",
                command: `${bin} -e ${evalarg('setInterval(() => console.log("local"), 25)')}`,
                description: "Local scoped run",
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
                mode: "exec_async",
                command: `${bin} -e ${evalarg('setInterval(() => console.log("workspace"), 25)')}`,
                description: "Workspace scoped run",
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
        return { local: local.asyncID, shared: shared.asyncID, sessionID: one.sessionID }
      },
    })

    await Instance.provide({
      directory: b.path,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const three = await mkctx("scope three", b.path)
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
        const one = { ...base, sessionID: ids.sessionID, directory: a.path }
        await exbash.execute({ mode: "control", asyncID: ids.local, action: "stop" }, one)
        await exbash.execute({ mode: "control", asyncID: ids.local, action: "remove" }, one)
        await exbash.execute({ mode: "control", asyncID: ids.shared, action: "stop" }, one)
        await exbash.execute({ mode: "control", asyncID: ids.shared, action: "remove" }, one)
      },
    })
  })
})
