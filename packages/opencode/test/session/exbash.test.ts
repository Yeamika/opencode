import { afterEach, describe, expect, test } from "bun:test"
import { eq } from "../../src/storage/db"
import { Database } from "../../src/storage/db"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { ExBashTask } from "../../src/session/exbash"
import { ExBashTaskTable } from "../../src/session/session.sql"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("ExBashTask.ensure", () => {
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
