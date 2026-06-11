import { afterEach, describe, expect, test } from "bun:test"
import { eq } from "../../src/storage/db"
import { Database } from "../../src/storage/db"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { ExBashTask } from "../../src/session/exbash"
import { ExBashTaskTable } from "../../src/session/session.sql"
import * as RefsBridge from "../../src/tool/refs-bridge"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("ExBashTask.ensure", () => {
  test("sorts tmp running tasks after described tasks", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const now = Date.now()

        Database.use((db) =>
          db
            .insert(ExBashTaskTable)
            .values([
              {
                async_id: "tmp-running",
                session_id: session.id,
                workspace: session.directory,
                scope: "local",
                executor: "exec_1",
                description: "Tmp Running",
                command: "sleep 1",
                cwd: session.directory,
                time_start: now + 3,
              },
              {
                async_id: "described-stopped",
                session_id: session.id,
                workspace: session.directory,
                scope: "local",
                executor: "exec_1",
                description: "build done",
                command: "true",
                cwd: session.directory,
                time_start: now + 2,
                time_end: now + 2,
                exit_code: 0,
              },
              {
                async_id: "described-running",
                session_id: session.id,
                workspace: session.directory,
                scope: "local",
                executor: "exec_1",
                description: "build running",
                command: "sleep 1",
                cwd: session.directory,
                time_start: now + 1,
              },
            ])
            .run(),
        )

        const tasks = await ExBashTask.get({ sessionID: session.id, workspace: session.directory })
        expect(tasks.map((task) => task.asyncID)).toEqual(["described-running", "described-stopped", "tmp-running"])
      },
    })
  })

  test("cleans persisted local running tasks and preserves remote running tasks", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const now = Date.now()

        Database.use((db) =>
          db
            .insert(ExBashTaskTable)
            .values([
              {
                async_id: "local-session-running",
                session_id: session.id,
                workspace: session.directory,
                scope: "local",
                executor: "local",
                description: "local session",
                command: "sleep 1",
                cwd: session.directory,
                time_start: now,
              },
              {
                async_id: "remote-session-running",
                session_id: session.id,
                workspace: session.directory,
                scope: "local",
                executor: "exec_1",
                description: "remote session",
                command: "sleep 1",
                cwd: session.directory,
                time_start: now + 1,
              },
              {
                async_id: "local-workspace-running",
                session_id: session.id,
                workspace: session.directory,
                scope: "workspace",
                executor: "local",
                description: "local workspace",
                command: "sleep 1",
                cwd: session.directory,
                time_start: now + 2,
              },
              {
                async_id: "remote-workspace-running",
                session_id: session.id,
                workspace: session.directory,
                scope: "workspace",
                executor: "exec_1",
                description: "remote workspace",
                command: "sleep 1",
                cwd: session.directory,
                time_start: now + 3,
              },
            ])
            .run(),
        )

        const tasks = await ExBashTask.get({ sessionID: session.id, workspace: session.directory })
        expect(tasks.map((task) => task.asyncID).sort()).toEqual(["remote-session-running", "remote-workspace-running"])
        expect(tasks.every((task) => task.executor === "exec_1" && task.state === "running")).toBe(true)

        const rows = Database.use((db) =>
          db.select().from(ExBashTaskTable).where(eq(ExBashTaskTable.session_id, session.id)).all(),
        )
        expect(rows.map((row) => row.async_id).sort()).toEqual(["remote-session-running", "remote-workspace-running"])
      },
    })
  })
})

describe("ExBashTask.sync", () => {
  test("upserts native task events and replaces workspace ownership", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const next = await Session.create({})
        const now = Date.now()

        await ExBashTask.sync({
          asyncID: "rex-sync",
          sessionID: session.id,
          workspace: session.directory,
          scope: "workspace",
          executor: "local",
          description: "Tmp Running",
          command: "sleep 1",
          cwd: session.directory,
          startedAt: now,
          state: "running",
        })
        await ExBashTask.sync({
          asyncID: "rex-sync",
          sessionID: session.id,
          workspace: session.directory,
          scope: "workspace",
          executor: "local",
          description: "Tmp Running",
          command: "sleep 1",
          cwd: session.directory,
          startedAt: now,
          endedAt: now + 1,
          exitCode: 0,
          state: "exit:0",
        })

        const finished = await ExBashTask.get({ sessionID: session.id, workspace: session.directory })
        expect(finished).toMatchObject([
          {
            asyncID: "rex-sync",
            state: "exit:0",
            endedAt: now + 1,
          },
        ])

        await ExBashTask.sync({
          asyncID: "rex-sync",
          sessionID: next.id,
          workspace: next.directory,
          scope: "workspace",
          executor: "local",
          description: "Tmp Running",
          command: "sleep 2",
          cwd: next.directory,
          startedAt: now + 2,
          state: "running",
        })

        const rows = Database.use((db) => db.select().from(ExBashTaskTable).all()).filter(
          (row) => row.async_id === "rex-sync",
        )
        expect(rows).toHaveLength(1)
        expect(rows[0]?.session_id).toBe(next.id)
        expect(rows[0]?.time_end).toBeNull()
      },
    })
  })
})

describe("exbash snapshot", () => {
  test("attaches to the worker-owned running task", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const opts = { sessionID: session.id, workdir: session.directory }
        const start = JSON.parse(
          await RefsBridge.callToolAsync({
            ...opts,
            tool: "exbash",
            argsJson: JSON.stringify({
              ExecutorSessionID: session.id,
              includeStructuredContent: true,
              mode: "shell",
              command: "printf sidebar-snapshot; sleep 30",
              read_timeout: 200,
            }),
          }),
        ) as {
          result?: { structuredContent?: { metadata?: { asyncID?: string } } }
        }
        const id = start.result?.structuredContent?.metadata?.asyncID
        expect(typeof id).toBe("string")

        try {
          const raw = JSON.parse(
            await RefsBridge.handleRawAsync({
              ...opts,
              request: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                  name: "exbash",
                  arguments: {
                    ExecutorSessionID: session.id,
                    mode: "attach",
                    asyncID: id,
                    read_timeout: 0,
                  },
                },
              }),
            }),
          ) as { result?: { content?: Array<{ text?: string }> } }
          expect(raw.result?.content?.[0]?.text ?? "").toContain("sidebar-snapshot")

          const shot = await RefsBridge.call("exbash", { mode: "attach", asyncID: id, read_timeout: 0 }, opts)
          expect(shot.output).toContain("sidebar-snapshot")
        } finally {
          await RefsBridge.call("exbash", { mode: "remove", asyncID: id }, opts).catch(() => undefined)
        }
      },
    })
  })
})
