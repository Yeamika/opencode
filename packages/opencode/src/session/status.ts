import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { SessionID } from "./schema"
import { Effect, Layer, ServiceMap } from "effect"
import z from "zod"

export namespace SessionStatus {
  const Idle = z.object({
    type: z.literal("idle"),
    updatedAt: z.number().optional(),
    action: z.string().optional(),
  })

  const Busy = z.object({
    type: z.literal("busy"),
    startedAt: z.number(),
    updatedAt: z.number(),
    action: z.string().optional(),
    attempt: z.number().optional(),
    message: z.string().optional(),
  })

  const Retry = z.object({
    type: z.literal("retry"),
    attempt: z.number(),
    message: z.string(),
    next: z.number(),
    waitingAt: z.number(),
    updatedAt: z.number(),
    action: z.string().optional(),
  })

  export const Info = z.union([Idle, Retry, Busy]).meta({
    ref: "SessionStatus",
  })
  export type Info = z.infer<typeof Info>

  export function idle(input?: { action?: string; updatedAt?: number }): Extract<Info, { type: "idle" }> {
    return {
      type: "idle",
      ...(input?.updatedAt ? { updatedAt: input.updatedAt } : {}),
      ...(input?.action ? { action: input.action } : {}),
    }
  }

  export function busy(input?: {
    action?: string
    attempt?: number
    message?: string
    startedAt?: number
    updatedAt?: number
  }): Extract<Info, { type: "busy" }> {
    const now = input?.updatedAt ?? Date.now()
    return {
      type: "busy",
      startedAt: input?.startedAt ?? now,
      updatedAt: now,
      ...(input?.action ? { action: input.action } : {}),
      ...(input?.attempt ? { attempt: input.attempt } : {}),
      ...(input?.message ? { message: input.message } : {}),
    }
  }

  export function retry(input: {
    attempt: number
    message: string
    next: number
    waitingAt?: number
    updatedAt?: number
    action?: string
  }): Extract<Info, { type: "retry" }> {
    const now = input.updatedAt ?? Date.now()
    return {
      type: "retry",
      attempt: input.attempt,
      message: input.message,
      next: input.next,
      waitingAt: input.waitingAt ?? now,
      updatedAt: now,
      ...(input.action ? { action: input.action } : {}),
    }
  }

  export const Event = {
    Status: BusEvent.define(
      "session.status",
      z.object({
        sessionID: SessionID.zod,
        status: Info,
      }),
    ),
    // deprecated
    Idle: BusEvent.define(
      "session.idle",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  export interface Interface {
    readonly get: (sessionID: SessionID) => Effect.Effect<Info>
    readonly list: () => Effect.Effect<Map<SessionID, Info>>
    readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionStatus") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service

      const state = yield* InstanceState.make(
        Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
      )

      const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
        const data = yield* InstanceState.get(state)
        return data.get(sessionID) ?? idle()
      })

      const list = Effect.fn("SessionStatus.list")(function* () {
        return new Map(yield* InstanceState.get(state))
      })

      const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
        const data = yield* InstanceState.get(state)
        yield* bus.publish(Event.Status, { sessionID, status })
        if (status.type === "idle") {
          yield* bus.publish(Event.Idle, { sessionID })
          data.delete(sessionID)
          return
        }
        data.set(sessionID, status)
      })

      return Service.of({ get, list, set })
    }),
  )

  const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function get(sessionID: SessionID) {
    return runPromise((svc) => svc.get(sessionID))
  }

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function set(sessionID: SessionID, status: Info) {
    return runPromise((svc) => svc.set(sessionID, status))
  }
}
