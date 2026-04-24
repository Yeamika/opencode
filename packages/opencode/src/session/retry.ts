import type { NamedError } from "@opencode-ai/util/error"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Log } from "@/util/log"
import { Cause, Clock, Deferred, Duration, Effect, Layer, Schedule, ServiceMap } from "effect"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { iife } from "@/util/iife"

export namespace SessionRetry {
  export type Err = ReturnType<NamedError["toObject"]>
  const log = Log.create({ service: "session.retry" })

  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

  interface WaitState {
    deferred: Deferred.Deferred<void>
    startedAt: number
    next: number
  }

  export interface Interface {
    readonly wait: (sessionID: SessionID, delayMs: number) => Effect.Effect<void>
    readonly triggerNow: (sessionID: SessionID) => Effect.Effect<boolean>
    readonly cancel: (sessionID: SessionID) => Effect.Effect<boolean>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionRetry") {}

  function cap(ms: number) {
    return Math.min(ms, RETRY_MAX_DELAY)
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return cap(parsedMs)
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return cap(Math.ceil(parsedSeconds * 1000))
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return cap(Math.ceil(parsed))
          }
        }

        return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
      }
    }

    return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
  }

  export function retryable(error: Err) {
    // context overflow errors should not be retried
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return undefined
      if (error.data.responseBody?.includes("FreeUsageLimitError"))
        return `Free usage exceeded, subscribe to Go https://opencode.ai/go`
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    const json = iife(() => {
      try {
        if (typeof error.data?.message === "string") {
          const parsed = JSON.parse(error.data.message)
          return parsed
        }

        return JSON.parse(error.data.message)
      } catch {
        return undefined
      }
    })
    if (!json || typeof json !== "object") return undefined
    const code = typeof json.code === "string" ? json.code : ""

    if (json.type === "error" && json.error?.type === "too_many_requests") {
      return "Too Many Requests"
    }
    if (code.includes("exhausted") || code.includes("unavailable")) {
      return "Provider is overloaded"
    }
    if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
      return "Rate Limited"
    }
    return undefined
  }

  export function policy(opts: {
    parse: (error: unknown) => Err
    set: (input: { attempt: number; message: string; next: number }) => Effect.Effect<void>
  }) {
    return Schedule.fromStepWithMetadata(
      Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
        const error = opts.parse(meta.input)
        const message = retryable(error)
        if (!message) return Cause.done(meta.attempt)
        return Effect.gen(function* () {
          const wait = delay(meta.attempt, MessageV2.APIError.isInstance(error) ? error : undefined)
          const now = yield* Clock.currentTimeMillis
          yield* opts.set({ attempt: meta.attempt, message, next: now + wait })
          return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
        })
        }),
      )
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make(
        Effect.fn("SessionRetry.state")(() => Effect.succeed(new Map<SessionID, WaitState>())),
        { preserveOnSoft: true },
      )

      const wait = Effect.fn("SessionRetry.wait")(function* (sessionID: SessionID, delayMs: number) {
        const waits = yield* InstanceState.get(state)
        const deferred = yield* Deferred.make<void>()
        const startedAt = Date.now()
        const next = startedAt + delayMs
        waits.set(sessionID, { deferred, startedAt, next })
        log.info("waiting", { sessionID, delayMs, next })

        yield* Effect.raceFirst(Deferred.await(deferred), Effect.sleep(Duration.millis(delayMs))).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (waits.get(sessionID)?.deferred === deferred) waits.delete(sessionID)
            }),
          ),
        )
      })

      const triggerNow = Effect.fn("SessionRetry.triggerNow")(function* (sessionID: SessionID) {
        const waits = yield* InstanceState.get(state)
        const current = waits.get(sessionID)
        if (!current) return false

        waits.delete(sessionID)
        log.info("triggered immediately", {
          sessionID,
          waitingMs: Date.now() - current.startedAt,
          next: current.next,
        })
        yield* Deferred.succeed(current.deferred, undefined).pipe(Effect.ignore)
        return true
      })

      const cancel = Effect.fn("SessionRetry.cancel")(function* (sessionID: SessionID) {
        const waits = yield* InstanceState.get(state)
        const current = waits.get(sessionID)
        if (!current) return false
        waits.delete(sessionID)
        log.info("cancelled", {
          sessionID,
          waitingMs: Date.now() - current.startedAt,
          next: current.next,
        })
        return true
      })

      return Service.of({ wait, triggerNow, cancel })
    }),
  )

  const { runPromise } = makeRuntime(Service, layer)

  export async function wait(sessionID: SessionID, delayMs: number) {
    return runPromise((svc) => svc.wait(SessionID.zod.parse(sessionID), delayMs))
  }

  export async function triggerNow(sessionID: SessionID) {
    return runPromise((svc) => svc.triggerNow(SessionID.zod.parse(sessionID)))
  }

  export async function cancel(sessionID: SessionID) {
    return runPromise((svc) => svc.cancel(SessionID.zod.parse(sessionID)))
  }
}
