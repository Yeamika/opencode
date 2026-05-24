import z from "zod"
import { Effect, Layer, ServiceMap } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { makeRuntime } from "@/effect/run-service"
import { Database, and, asc, eq } from "@/storage/db"
import { ExBashTaskTable } from "./session.sql"
import { SessionID } from "./schema"

export namespace ExBashTask {
  export const Scope = z.enum(["local", "workspace"])
  export type Scope = z.infer<typeof Scope>
  export const State = z.enum(["running", "stopped", "unknown"])
  export type State = z.infer<typeof State>

  export const Info = z
    .object({
      asyncID: z.string(),
      scope: Scope,
      executor: z.string(),
      description: z.string(),
      command: z.string(),
      cwd: z.string(),
      pid: z.number().optional(),
      totalOutput: z.number().optional(),
      startedAt: z.number(),
      endedAt: z.number().optional(),
      exitCode: z.number().optional(),
      state: State,
      memory: z.boolean().optional(),
      stoppedByUser: z.boolean().optional(),
      error: z.string().optional(),
    })
    .meta({ ref: "ExBashTask" })
  export type Info = z.infer<typeof Info>
  type Entry = Info & { sessionID: SessionID; workspace: string }

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
    readonly one: (input: { sessionID: SessionID; workspace: string; executor: string; asyncID: string }) => Effect.Effect<Info | undefined>
    readonly start: (input: Omit<Entry, "state" | "exitCode" | "endedAt">) => Effect.Effect<Info>
    readonly finish: (input: { executor: string; asyncID: string; exitCode: number; endedAt: number; totalOutput?: number; stoppedByUser?: boolean; error?: string }) => Effect.Effect<Info | undefined>
    readonly lost: (input: { executor: string; asyncID: string }) => Effect.Effect<Info | undefined>
    readonly remove: (input: { sessionID: SessionID; workspace: string; executor: string; asyncID: string }) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionExBashTask") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const sid = new Set<string>()
      const wid = new Set<string>()
      const ses = new Map<string, Map<string, Entry>>()
      const ws = new Map<string, Map<string, Entry>>()
      const idx = new Map<string, { sessionID: SessionID; workspace: string; executor: string; scope: Scope }>()

      const key = (input: { executor: string; asyncID: string }) => `${input.executor}\0${input.asyncID}`

      const mark = (task: Entry) => {
        idx.set(key(task), { sessionID: task.sessionID, workspace: task.workspace, executor: task.executor, scope: task.scope })
        const map = task.scope === "workspace" ? (ws.get(task.workspace) ?? new Map<string, Entry>()) : (ses.get(task.sessionID) ?? new Map<string, Entry>())
        map.set(key(task), task)
        if (task.scope === "workspace") ws.set(task.workspace, map)
        else ses.set(task.sessionID, map)
      }

      const drop = (input: { executor: string; asyncID: string }) => {
        const k = key(input)
        const ref = idx.get(k)
        if (!ref) return
        const map = ref.scope === "workspace" ? ws.get(ref.workspace) : ses.get(ref.sessionID)
        map?.delete(k)
        idx.delete(k)
      }

      const note = (sessionID: SessionID, workspace: string) => bus.publish(Event.Updated, { sessionID, workspace })

      const state = (r: typeof ExBashTaskTable.$inferSelect) => (r.time_end === null ? "unknown" : "stopped") as State

      const row = (r: typeof ExBashTaskTable.$inferSelect): Entry => ({
        asyncID: r.async_id,
        sessionID: r.session_id,
        workspace: r.workspace,
        scope: Scope.parse(r.scope),
        executor: r.executor,
        description: r.description,
        command: r.command,
        cwd: r.cwd,
        startedAt: r.time_start,
        endedAt: r.time_end ?? undefined,
        exitCode: r.exit_code ?? undefined,
        state: state(r),
      })

      const sort = (list: Entry[]) =>
        list.toSorted((a, b) => {
          const x = a.state === "running" ? 0 : 1
          const y = b.state === "running" ? 0 : 1
          if (x !== y) return x - y
          return b.startedAt - a.startedAt
        })

      const view = (task: Entry): Info => ({
        asyncID: task.asyncID,
        scope: task.scope,
        executor: task.executor,
        description: task.description,
        command: task.command,
        cwd: task.cwd,
        ...(task.pid === undefined ? {} : { pid: task.pid }),
        ...(task.totalOutput === undefined ? {} : { totalOutput: task.totalOutput }),
        startedAt: task.startedAt,
        ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
        ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
        state: task.state,
        ...(task.memory === undefined ? {} : { memory: task.memory }),
        ...(task.stoppedByUser === undefined ? {} : { stoppedByUser: task.stoppedByUser }),
        ...(task.error === undefined ? {} : { error: task.error }),
      })

      const merge = (sessionID: string, workspace: string) => {
        const out = [...(ws.get(workspace)?.values() ?? []), ...(ses.get(sessionID)?.values() ?? [])]
        return sort(out).map(view)
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

      const one = Effect.fn("ExBashTask.one")(function* (input: { sessionID: SessionID; workspace: string; executor: string; asyncID: string }) {
        yield* ensure(input)
        return merge(input.sessionID, input.workspace).find((item) => item.executor === input.executor && item.asyncID === input.asyncID)
      })

      const start = Effect.fn("ExBashTask.start")(
        function* (input: Omit<Entry, "state" | "exitCode" | "endedAt">) {
          yield* ensure({ sessionID: input.sessionID, workspace: input.workspace })
          const task: Entry = {
            ...input,
            executor: input.executor ?? "local",
            state: "running",
            memory: true,
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
                  executor: task.executor,
                  description: task.description,
                  command: task.command,
                  cwd: task.cwd,
                  time_start: task.startedAt,
                })
                .run(),
            ),
          )
          yield* note(task.sessionID, task.workspace)
          return view(task)
        },
      )

      const finish = Effect.fn("ExBashTask.finish")(
        function* (input: { executor: string; asyncID: string; exitCode: number; endedAt: number; totalOutput?: number; stoppedByUser?: boolean; error?: string }) {
          const ref = idx.get(key(input))
          if (!ref) return undefined
          const map = ref.scope === "workspace" ? ws.get(ref.workspace) : ses.get(ref.sessionID)
          const prev = map?.get(key(input))
          if (!prev) return undefined
          const task = {
            ...prev,
            state: "stopped" as const,
            exitCode: input.exitCode,
            endedAt: prev.endedAt ?? input.endedAt,
            ...(input.totalOutput === undefined ? {} : { totalOutput: input.totalOutput }),
            ...(input.stoppedByUser === undefined ? {} : { stoppedByUser: input.stoppedByUser }),
            ...(input.error ? { error: input.error } : {}),
          }
          mark(task)
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .update(ExBashTaskTable)
                .set({ time_end: task.endedAt, exit_code: input.exitCode })
                .where(
                  and(
                    eq(ExBashTaskTable.async_id, input.asyncID),
                    eq(ExBashTaskTable.executor, input.executor),
                    eq(ExBashTaskTable.scope, ref.scope),
                    ref.scope === "workspace"
                      ? eq(ExBashTaskTable.workspace, ref.workspace)
                      : eq(ExBashTaskTable.session_id, ref.sessionID),
                  ),
                )
                .run(),
            ),
          )
          yield* note(task.sessionID, task.workspace)
          return view(task)
        },
      )

      const lost = Effect.fn("ExBashTask.lost")(function* (input: { executor: string; asyncID: string }) {
        const ref = idx.get(key(input))
        if (!ref) return undefined
        const map = ref.scope === "workspace" ? ws.get(ref.workspace) : ses.get(ref.sessionID)
        const prev = map?.get(key(input))
        if (!prev) return undefined
        if (prev.state !== "running") return view(prev)
        const task = { ...prev, state: "unknown" as const }
        mark(task)
        yield* note(task.sessionID, task.workspace)
        return view(task)
      })

      const remove = Effect.fn("ExBashTask.remove")(function* (input: { sessionID: SessionID; workspace: string; executor: string; asyncID: string }) {
        yield* ensure(input)
        const ref = idx.get(key(input))
        if (!ref) return
        if (ref.executor !== input.executor) return
        if (ref.scope === "workspace" && ref.workspace !== input.workspace) return
        if (ref.scope === "local" && ref.sessionID !== input.sessionID) return
        const task = (ref.scope === "workspace" ? ws.get(ref.workspace) : ses.get(ref.sessionID))?.get(key(input))
        if (!task) return
        drop(input)
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .delete(ExBashTaskTable)
              .where(
                and(
                  eq(ExBashTaskTable.async_id, input.asyncID),
                  eq(ExBashTaskTable.executor, input.executor),
                  eq(ExBashTaskTable.scope, task.scope),
                  task.scope === "workspace"
                    ? eq(ExBashTaskTable.workspace, task.workspace)
                    : eq(ExBashTaskTable.session_id, task.sessionID),
                ),
              )
              .run(),
          ),
        )
        yield* note(task.sessionID, task.workspace)
      })

      return Service.of({ ensure, get, one, start, finish, lost, remove })
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

  export async function one(input: { sessionID: SessionID; workspace: string; executor: string; asyncID: string }) {
    return runPromise((svc) => svc.one(input))
  }

  export async function start(input: Omit<Entry, "state" | "exitCode" | "endedAt">) {
    return runPromise((svc) => svc.start(input))
  }

  export async function finish(input: { executor: string; asyncID: string; exitCode: number; endedAt: number; totalOutput?: number; stoppedByUser?: boolean; error?: string }) {
    return runPromise((svc) => svc.finish(input))
  }

  export async function lost(input: { executor: string; asyncID: string }) {
    return runPromise((svc) => svc.lost(input))
  }

  export async function remove(input: { sessionID: SessionID; workspace: string; executor: string; asyncID: string }) {
    return runPromise((svc) => svc.remove(input))
  }
}
