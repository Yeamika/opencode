import path from "path"
import z from "zod"
import { Effect, Layer, ServiceMap } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { makeRuntime } from "@/effect/run-service"
import { Global } from "@/global"
import { Database, and, asc, eq } from "@/storage/db"
import { ExBashTaskTable } from "./session.sql"
import { SessionID } from "./schema"

const ROOT = path.join(Global.Path.data, "exbash")

export namespace ExBashTask {
  export const Scope = z.enum(["local", "workspace"])
  export type Scope = z.infer<typeof Scope>

  export const Info = z
    .object({
      asyncID: z.string(),
      sessionID: SessionID.zod,
      workspace: z.string(),
      scope: Scope,
      description: z.string(),
      command: z.string(),
      cwd: z.string(),
      timeout: z.number().optional(),
      linePointer: z.number(),
      resultPath: z.string(),
      startedAt: z.number(),
      endedAt: z.number().optional(),
      exitCode: z.number().optional(),
      status: z.enum(["running", "stopped"]),
      error: z.string().optional(),
    })
    .meta({ ref: "ExBashTask" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "exbash.updated",
      z.object({
        sessionID: SessionID.zod,
        workspace: z.string(),
      }),
    ),
  }

  export interface Interface {
    readonly ensure: (input: { sessionID: SessionID; workspace: string }) => Effect.Effect<void>
    readonly get: (input: { sessionID: SessionID; workspace: string }) => Effect.Effect<Info[]>
    readonly one: (input: { sessionID: SessionID; workspace: string; asyncID: string }) => Effect.Effect<Info | undefined>
    readonly start: (input: Omit<Info, "linePointer" | "resultPath" | "status" | "exitCode" | "endedAt">) => Effect.Effect<Info>
    readonly line: (input: { asyncID: string; linePointer: number; error?: string }) => Effect.Effect<Info | undefined>
    readonly finish: (input: { asyncID: string; exitCode: number; endedAt: number; error?: string }) => Effect.Effect<Info | undefined>
    readonly remove: (asyncID: string) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionExBashTask") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const sid = new Set<string>()
      const wid = new Set<string>()
      const ses = new Map<string, Map<string, Info>>()
      const ws = new Map<string, Map<string, Info>>()
      const idx = new Map<string, { sessionID: SessionID; workspace: string; scope: Scope }>()

      const file = (asyncID: string) => path.join(ROOT, `${asyncID}.log`)

      const mark = (task: Info) => {
        idx.set(task.asyncID, { sessionID: task.sessionID, workspace: task.workspace, scope: task.scope })
        const map = task.scope === "workspace" ? (ws.get(task.workspace) ?? new Map<string, Info>()) : (ses.get(task.sessionID) ?? new Map<string, Info>())
        map.set(task.asyncID, task)
        if (task.scope === "workspace") ws.set(task.workspace, map)
        else ses.set(task.sessionID, map)
      }

      const drop = (asyncID: string) => {
        const ref = idx.get(asyncID)
        if (!ref) return
        const map = ref.scope === "workspace" ? ws.get(ref.workspace) : ses.get(ref.sessionID)
        map?.delete(asyncID)
        idx.delete(asyncID)
      }

      const note = (sessionID: SessionID, workspace: string) => bus.publish(Event.Updated, { sessionID, workspace })

      const row = (r: typeof ExBashTaskTable.$inferSelect): Info => ({
        asyncID: r.async_id,
        sessionID: r.session_id,
        workspace: r.workspace,
        scope: Scope.parse(r.scope),
        description: r.description,
        command: r.command,
        cwd: r.cwd,
        timeout: r.timeout ?? undefined,
        linePointer: 0,
        resultPath: file(r.async_id),
        startedAt: r.time_start,
        endedAt: r.time_end ?? r.time_updated,
        exitCode: r.exit_code ?? -1,
        status: "stopped",
      })

      const sort = (list: Info[]) =>
        list.toSorted((a, b) => {
          const x = a.status === "running" ? 0 : 1
          const y = b.status === "running" ? 0 : 1
          if (x !== y) return x - y
          return b.startedAt - a.startedAt
        })

      const merge = (sessionID: string, workspace: string) => {
        const out = [...(ws.get(workspace)?.values() ?? []), ...(ses.get(sessionID)?.values() ?? [])]
        return sort(out)
      }

      const ensure = Effect.fn("ExBashTask.ensure")(function* (input: { sessionID: SessionID; workspace: string }) {
        if (!sid.has(input.sessionID)) {
          const rows = yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select()
                .from(ExBashTaskTable)
                .where(and(eq(ExBashTaskTable.session_id, input.sessionID), eq(ExBashTaskTable.scope, "local")))
                .orderBy(asc(ExBashTaskTable.time_start))
                .all(),
            ),
          )
          rows.map(row).forEach(mark)
          sid.add(input.sessionID)
        }
        if (!wid.has(input.workspace)) {
          const rows = yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select()
                .from(ExBashTaskTable)
                .where(and(eq(ExBashTaskTable.workspace, input.workspace), eq(ExBashTaskTable.scope, "workspace")))
                .orderBy(asc(ExBashTaskTable.time_start))
                .all(),
            ),
          )
          rows.map(row).forEach(mark)
          wid.add(input.workspace)
        }
      })

      const get = Effect.fn("ExBashTask.get")(function* (input: { sessionID: SessionID; workspace: string }) {
        yield* ensure(input)
        return merge(input.sessionID, input.workspace)
      })

      const one = Effect.fn("ExBashTask.one")(function* (input: { sessionID: SessionID; workspace: string; asyncID: string }) {
        yield* ensure(input)
        return merge(input.sessionID, input.workspace).find((item) => item.asyncID === input.asyncID)
      })

      const start = Effect.fn("ExBashTask.start")(
        function* (input: Omit<Info, "linePointer" | "resultPath" | "status" | "exitCode" | "endedAt">) {
          yield* ensure({ sessionID: input.sessionID, workspace: input.workspace })
          const task: Info = {
            ...input,
            linePointer: 0,
            resultPath: file(input.asyncID),
            status: "running",
          }
          mark(task)
          yield* Effect.sync(() =>
            Database.use((db) =>
              db.insert(ExBashTaskTable)
                .values({
                  async_id: task.asyncID,
                  session_id: task.sessionID,
                  workspace: task.workspace,
                  scope: task.scope,
                  description: task.description,
                  command: task.command,
                  cwd: task.cwd,
                  timeout: task.timeout,
                  time_start: task.startedAt,
                })
                .run(),
            ),
          )
          yield* note(task.sessionID, task.workspace)
          return task
        },
      )

      const line = Effect.fn("ExBashTask.line")(function* (input: { asyncID: string; linePointer: number; error?: string }) {
        const ref = idx.get(input.asyncID)
        if (!ref) return undefined
        const map = ref.scope === "workspace" ? ws.get(ref.workspace) : ses.get(ref.sessionID)
        const prev = map?.get(input.asyncID)
        if (!prev) return undefined
        const task = { ...prev, linePointer: input.linePointer, ...(input.error ? { error: input.error } : {}) }
        mark(task)
        yield* note(task.sessionID, task.workspace)
        return task
      })

      const finish = Effect.fn("ExBashTask.finish")(
        function* (input: { asyncID: string; exitCode: number; endedAt: number; error?: string }) {
          const ref = idx.get(input.asyncID)
          if (!ref) return undefined
          const map = ref.scope === "workspace" ? ws.get(ref.workspace) : ses.get(ref.sessionID)
          const prev = map?.get(input.asyncID)
          if (!prev) return undefined
          const task = {
            ...prev,
            status: "stopped" as const,
            exitCode: input.exitCode,
            endedAt: input.endedAt,
            ...(input.error ? { error: input.error } : {}),
          }
          mark(task)
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .update(ExBashTaskTable)
                .set({ time_end: input.endedAt, exit_code: input.exitCode })
                .where(eq(ExBashTaskTable.async_id, input.asyncID))
                .run(),
            ),
          )
          yield* note(task.sessionID, task.workspace)
          return task
        },
      )

      const remove = Effect.fn("ExBashTask.remove")(function* (asyncID: string) {
        const ref = idx.get(asyncID)
        if (!ref) return
        drop(asyncID)
        yield* Effect.sync(() =>
          Database.use((db) => db.delete(ExBashTaskTable).where(eq(ExBashTaskTable.async_id, asyncID)).run()),
        )
        yield* note(ref.sessionID, ref.workspace)
      })

      return Service.of({ ensure, get, one, start, line, finish, remove })
    }),
  )

  const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function ensure(input: { sessionID: SessionID; workspace: string }) {
    return runPromise((svc) => svc.ensure(input))
  }

  export async function get(input: { sessionID: SessionID; workspace: string }) {
    return runPromise((svc) => svc.get(input))
  }

  export async function one(input: { sessionID: SessionID; workspace: string; asyncID: string }) {
    return runPromise((svc) => svc.one(input))
  }

  export async function start(input: Omit<Info, "linePointer" | "resultPath" | "status" | "exitCode" | "endedAt">) {
    return runPromise((svc) => svc.start(input))
  }

  export async function line(input: { asyncID: string; linePointer: number; error?: string }) {
    return runPromise((svc) => svc.line(input))
  }

  export async function finish(input: { asyncID: string; exitCode: number; endedAt: number; error?: string }) {
    return runPromise((svc) => svc.finish(input))
  }

  export async function remove(asyncID: string) {
    return runPromise((svc) => svc.remove(asyncID))
  }
}
