import { DateTime, Effect, Layer, Option, Semaphore, ServiceMap } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { AppFileSystem } from "@/filesystem"
import { Flag } from "@/flag/flag"
import type { SessionID } from "@/session/schema"
import { Filesystem } from "@/util/filesystem"
import { Log } from "../util/log"
import type { RemoteExecutor } from "../tool/remote_executor"

export namespace FileTime {
  const log = Log.create({ service: "file.time" })

  export type Stamp = {
    readonly read: Date
    readonly mtime: number | undefined
    readonly size: number | undefined
    readonly executor?: string
    readonly fileKey?: string
    readonly canonicalPath?: string
    readonly kind?: RemoteExecutor.FileStamp["kind"]
  }

  export type Input = {
    executor?: string
    file?: RemoteExecutor.FileStamp
  }

  function key(input: { executor?: string; file?: RemoteExecutor.FileStamp }) {
    if (!input.file) return
    return `${input.executor?.trim() || "local"}:${input.file.fileKey}`
  }

  const session = (reads: Map<SessionID, Map<string, Stamp>>, sessionID: SessionID) => {
    const value = reads.get(sessionID)
    if (value) return value

    const next = new Map<string, Stamp>()
    reads.set(sessionID, next)
    return next
  }

  interface State {
    reads: Map<SessionID, Map<string, Stamp>>
    locks: Map<string, Semaphore.Semaphore>
  }

  export interface Interface {
    readonly read: (sessionID: SessionID, file: string, input?: Input) => Effect.Effect<void>
    readonly get: (sessionID: SessionID, file: string) => Effect.Effect<Date | undefined>
    readonly assert: (sessionID: SessionID, filepath: string, input?: Input) => Effect.Effect<void>
    readonly withLock: <T>(filepath: string, fn: () => Promise<T>) => Effect.Effect<T>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/FileTime") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fsys = yield* AppFileSystem.Service
      const disableCheck = yield* Flag.OPENCODE_DISABLE_FILETIME_CHECK

      const stamp = Effect.fnUntraced(function* (file: string, input?: Input) {
        if (input?.file) {
          return {
            read: yield* DateTime.nowAsDate,
            mtime: input.file.mtimeMs,
            size: input.file.size,
            executor: input.executor?.trim() || "local",
            fileKey: input.file.fileKey,
            canonicalPath: input.file.canonicalPath,
            kind: input.file.kind,
          }
        }
        const info = yield* fsys.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        return {
          read: yield* DateTime.nowAsDate,
          mtime: info ? Option.getOrUndefined(info.mtime)?.getTime() : undefined,
          size: info ? Number(info.size) : undefined,
        }
      })
      const state = yield* InstanceState.make<State>(
        Effect.fn("FileTime.state")(() =>
          Effect.succeed({
            reads: new Map<SessionID, Map<string, Stamp>>(),
            locks: new Map<string, Semaphore.Semaphore>(),
          }),
        ),
      )

      const getLock = Effect.fn("FileTime.lock")(function* (filepath: string) {
        filepath = Filesystem.normalizePath(filepath)
        const locks = (yield* InstanceState.get(state)).locks
        const lock = locks.get(filepath)
        if (lock) return lock

        const next = Semaphore.makeUnsafe(1)
        locks.set(filepath, next)
        return next
      })

      const read = Effect.fn("FileTime.read")(function* (sessionID: SessionID, file: string, input?: Input) {
        file = Filesystem.normalizePath(file)
        const reads = (yield* InstanceState.get(state)).reads
        const item = yield* stamp(file, input)
        const map = session(reads, sessionID)
        log.info("read", { sessionID, file, key: key(input ?? {}) })
        map.set(file, item)
        const k = key(input ?? {})
        if (k) map.set(k, item)
      })

      const get = Effect.fn("FileTime.get")(function* (sessionID: SessionID, file: string) {
        file = Filesystem.normalizePath(file)
        const reads = (yield* InstanceState.get(state)).reads
        return reads.get(sessionID)?.get(file)?.read
      })

      const assert = Effect.fn("FileTime.assert")(function* (sessionID: SessionID, filepath: string, input?: Input) {
        if (disableCheck) return
        filepath = Filesystem.normalizePath(filepath)

        const reads = (yield* InstanceState.get(state)).reads
        const map = reads.get(sessionID)
        const time = (input ? map?.get(key(input) ?? "") : undefined) ?? map?.get(filepath)
        if (!time) throw new Error(`You must read file ${filepath} before overwriting it. Use the Read tool first`)

        const next = yield* stamp(filepath, input)
        const changed =
          input?.file && time.fileKey !== undefined
            ? next.fileKey !== time.fileKey ||
              next.kind !== time.kind ||
              next.mtime !== time.mtime ||
              next.size !== time.size
            : next.mtime !== time.mtime || next.size !== time.size
        if (!changed) return

        throw new Error(
          `File ${filepath} has been modified since it was last read.\nLast modification: ${new Date(next.mtime ?? next.read.getTime()).toISOString()}\nLast read: ${time.read.toISOString()}\n\nPlease read the file again before modifying it.`,
        )
      })

      const withLock = Effect.fn("FileTime.withLock")(function* <T>(filepath: string, fn: () => Promise<T>) {
        return yield* Effect.promise(fn).pipe((yield* getLock(filepath)).withPermits(1))
      })

      return Service.of({ read, get, assert, withLock })
    }),
  ).pipe(Layer.orDie)

  export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export function read(sessionID: SessionID, file: string, input?: Input) {
    return runPromise((s) => s.read(sessionID, file, input))
  }

  export function get(sessionID: SessionID, file: string) {
    return runPromise((s) => s.get(sessionID, file))
  }

  export async function assert(sessionID: SessionID, filepath: string, input?: Input) {
    return runPromise((s) => s.assert(sessionID, filepath, input))
  }

  export async function withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
    return runPromise((s) => s.withLock(filepath, fn))
  }
}
