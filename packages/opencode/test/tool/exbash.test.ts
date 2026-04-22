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
                mode: "exec-async",
                command: `${bin} -e ${evalarg('setInterval(() => console.log("tick"), 25)')}`,
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
                mode: "exec-async",
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

  test("writes text into async task stdin", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const exbash = await ExBashTool.init()
        const started = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "exec-async",
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
        const local = mkctx("ses_input_file", tmp.path)
        const file = path.join(tmp.path, "stdin.bin")
        const started = JSON.parse(
          (
            await exbash.execute(
              {
                mode: "exec-async",
                command: `${bin} -e ${evalarg('process.stdin.on("data", (chunk) => { process.stdout.write(chunk.toString("hex")); process.exit(0) })')}`,
                description: "File input run",
              },
              local,
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
              local,
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
                local,
              )
            ).output,
          ) as {
            runs: Array<{ status: string }>
          }
          if (!listed.runs[0]?.status.includes("exit 0")) return
          return listed.runs[0]
        })

        expect(await Filesystem.readText(started.resultPath)).toContain("0001ff")
        await exbash.execute({ mode: "control", asyncID: started.asyncID, action: "remove" }, local)
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
                mode: "exec-async",
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
                mode: "exec-async",
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
