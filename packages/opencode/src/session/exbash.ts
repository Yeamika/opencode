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
  export const State = z.union([z.enum(["running", "stop", "timeout", "unknown"]), z.string().regex(/^exit:-?\d+$/)])
  export type State = z.infer<typeof State>
  export const ExitCode = z.union([z.number(), z.enum(["stop", "stopped", "timeout"])])
  export type ExitCode = z.infer<typeof ExitCode>

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
      exitCode: ExitCode.optional(),
      state: State,
      memory: z.boolean().optional(),
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
    readonly one: (input: {
      sessionID: SessionID
      workspace: string
      executor: string
      asyncID: string
    }) => Effect.Effect<Info | undefined>
    readonly start: (input: Omit<Entry, "state" | "exitCode" | "endedAt">) => Effect.Effect<Info>
    readonly finish: (input: {
      executor: string
      asyncID: string
      exitCode: ExitCode
      endedAt: number
      totalOutput?: number
      error?: string
    }) => Effect.Effect<Info | undefined>
    readonly lost: (input: { executor: string; asyncID: string }) => Effect.Effect<Info | undefined>
    readonly remove: (input: {
      sessionID: SessionID
      workspace: string
      executor: string
      asyncID: string
    }) => Effect.Effect<void>
    readonly refresh: (input: { sessionID: SessionID; workspace: string }) => Effect.Effect<void>
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
        idx.set(key(task), {
          sessionID: task.sessionID,
          workspace: task.workspace,
          executor: task.executor,
          scope: task.scope,
        })
        const map =
          task.scope === "workspace"
            ? (ws.get(task.workspace) ?? new Map<string, Entry>())
            : (ses.get(task.sessionID) ?? new Map<string, Entry>())
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

      const exit = (value: unknown) => {
        if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value)
        if (value === "stopped") return "stop"
        const result = ExitCode.safeParse(value)
        return result.success ? result.data : undefined
      }

      const state = (r: typeof ExBashTaskTable.$inferSelect): State => {
        if (r.time_end === null) return "running"
        const code = exit(r.exit_code)
        if (typeof code === "number") return `exit:${code}`
        if (code === "timeout") return "timeout"
        if (code === "stop" || code === "stopped") return "stop"
        return "unknown"
      }

      const stateFromExit = (code: ExitCode): State => {
        if (typeof code === "number") return `exit:${code}`
        if (code === "timeout") return "timeout"
        return "stop"
      }

      const exitStorage = (code: ExitCode) => (code === "stopped" ? "stop" : code)

      const isLocalStaleRunning = (r: typeof ExBashTaskTable.$inferSelect) =>
        r.executor === "local" && r.time_end === null

      const removeRow = (r: typeof ExBashTaskTable.$inferSelect) =>
        Database.use((db) =>
          db
            .delete(ExBashTaskTable)
            .where(
              and(
                eq(ExBashTaskTable.session_id, r.session_id),
                eq(ExBashTaskTable.workspace, r.workspace),
                eq(ExBashTaskTable.executor, r.executor),
                eq(ExBashTaskTable.async_id, r.async_id),
              ),
            )
            .run(),
        )

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
        exitCode: exit(r.exit_code),
        state: state(r),
      })

      const sort = (list: Entry[]) =>
        list.toSorted((a, b) => {
          const ax = a.description.trim() === "Tmp Running" ? 1 : 0
          const bx = b.description.trim() === "Tmp Running" ? 1 : 0
          if (ax !== bx) return ax - bx
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
        ...(task.error === undefined ? {} : { error: task.error }),
      })

      const merge = (sessionID: string, workspace: string) => {
        const out = [...(ws.get(workspace)?.values() ?? []), ...(ses.get(sessionID)?.values() ?? [])]
        return sort(out).map(view)
      }

      const reload = Effect.fn("ExBashTask.reload")(function* (input: { sessionID: SessionID; workspace: string }) {
        const cleanSessionStale = !sid.has(input.sessionID)
        const cleanWorkspaceStale = !wid.has(input.workspace)
        const localRows = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(ExBashTaskTable)
              .where(and(eq(ExBashTaskTable.session_id, input.sessionID), eq(ExBashTaskTable.scope, "local")))
              .orderBy(asc(ExBashTaskTable.time_start))
              .all(),
          ),
        )
        const workspaceRows = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(ExBashTaskTable)
              .where(and(eq(ExBashTaskTable.workspace, input.workspace), eq(ExBashTaskTable.scope, "workspace")))
              .orderBy(asc(ExBashTaskTable.time_start))
              .all(),
          ),
        )

        for (const task of ses.get(input.sessionID)?.values() ?? []) idx.delete(key(task))
        for (const task of ws.get(input.workspace)?.values() ?? []) idx.delete(key(task))
        ses.set(input.sessionID, new Map())
        ws.set(input.workspace, new Map())

        let cleaned = false
        localRows.forEach((r) => {
          if (cleanSessionStale && isLocalStaleRunning(r)) {
            removeRow(r)
            cleaned = true
            return
          }
          mark(row(r))
        })
        workspaceRows.forEach((r) => {
          if (cleanWorkspaceStale && isLocalStaleRunning(r)) {
            removeRow(r)
            cleaned = true
            return
          }
          mark(row(r))
        })
        sid.add(input.sessionID)
        wid.add(input.workspace)
        return cleaned
      })

      const ensure = Effect.fn("ExBashTask.ensure")(function* (input: { sessionID: SessionID; workspace: string }) {
        const cleaned = yield* reload(input)
        if (cleaned) yield* note(input.sessionID, input.workspace)
      })

      const get = Effect.fn("ExBashTask.get")(function* (input: { sessionID: SessionID; workspace: string }) {
        yield* ensure(input)
        return merge(input.sessionID, input.workspace)
      })

      const one = Effect.fn("ExBashTask.one")(function* (input: {
        sessionID: SessionID
        workspace: string
        executor: string
        asyncID: string
      }) {
        yield* ensure(input)
        return merge(input.sessionID, input.workspace).find(
          (item) => item.executor === input.executor && item.asyncID === input.asyncID,
        )
      })

      const start = Effect.fn("ExBashTask.start")(function* (input: Omit<Entry, "state" | "exitCode" | "endedAt">) {
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
            db
              .insert(ExBashTaskTable)
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
      })

      const finish = Effect.fn("ExBashTask.finish")(function* (input: {
        executor: string
        asyncID: string
        exitCode: ExitCode
        endedAt: number
        totalOutput?: number
        error?: string
      }) {
        const ref = idx.get(key(input))
        if (!ref) return undefined
        const map = ref.scope === "workspace" ? ws.get(ref.workspace) : ses.get(ref.sessionID)
        const prev = map?.get(key(input))
        if (!prev) return undefined
        const task = {
          ...prev,
          state: stateFromExit(input.exitCode),
          exitCode: exit(input.exitCode),
          endedAt: prev.endedAt ?? input.endedAt,
          ...(input.totalOutput === undefined ? {} : { totalOutput: input.totalOutput }),
          ...(input.error ? { error: input.error } : {}),
        }
        mark(task)
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(ExBashTaskTable)
              .set({ time_end: task.endedAt, exit_code: exitStorage(input.exitCode) as never })
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
      })

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

      const remove = Effect.fn("ExBashTask.remove")(function* (input: {
        sessionID: SessionID
        workspace: string
        executor: string
        asyncID: string
      }) {
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

      const refresh = Effect.fn("ExBashTask.refresh")(function* (input: { sessionID: SessionID; workspace: string }) {
        yield* reload(input)
        yield* note(input.sessionID, input.workspace)
      })

      return Service.of({ ensure, get, one, start, finish, lost, remove, refresh })
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

  export async function finish(input: {
    executor: string
    asyncID: string
    exitCode: ExitCode
    endedAt: number
    totalOutput?: number
    error?: string
  }) {
    return runPromise((svc) => svc.finish(input))
  }

  export async function lost(input: { executor: string; asyncID: string }) {
    return runPromise((svc) => svc.lost(input))
  }

  export async function remove(input: { sessionID: SessionID; workspace: string; executor: string; asyncID: string }) {
    return runPromise((svc) => svc.remove(input))
  }

  export async function refresh(input: { sessionID: SessionID; workspace: string }) {
    return runPromise((svc) => svc.refresh(input))
  }
}
