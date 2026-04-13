import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { disposeInstance } from "@/effect/instance-registry"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/util/log"
import { State } from "./state"

type Entry = {
  sessions: Set<string>
  totalSessions: number
  requestedAt: number
  promise: Promise<void>
  resolve: () => void
  reject: (error?: unknown) => void
  running?: Promise<void>
}

export namespace Reload {
  const log = Log.create({ service: "reload" })
  const active = new Map<string, Set<string>>()
  const pending = new Map<string, Entry>()

  export const Updated = BusEvent.define(
    "project.reload.updated",
    z.object({
      directory: z.string(),
      status: z.enum(["idle", "pending", "running"]),
    }),
  )

  function publish(directory: string, status: "idle" | "pending" | "running") {
    const payload = {
      type: Updated.type,
      properties: {
        directory,
        status,
      },
    }

    try {
      if (Instance.directory === directory) {
        return Bus.publish(Updated, payload.properties)
      }
    } catch {}

    GlobalBus.emit("event", { directory, payload })
  }

  function dir(input: string) {
    return Filesystem.resolve(input)
  }

  function progress(entry: Entry) {
    const waitingSessionIDs = Array.from(entry.sessions)
    return {
      totalSessions: entry.totalSessions,
      readySessions: entry.totalSessions - waitingSessionIDs.length,
      waitingSessions: waitingSessionIDs.length,
      waitingSessionIDs,
    }
  }

  function mark(key: string, sessionID: string, source: "arrive" | "wait" | "leave") {
    const entry = pending.get(key)
    if (!entry) return

    const wasWaiting = entry.sessions.delete(sessionID)
    const state = progress(entry)

    if (wasWaiting) {
      log.info("reload session reached waitpoint", {
        directory: key,
        sessionID,
        source,
        ...state,
      })
    }

    if (entry.sessions.size === 0) {
      log.info("reload wait complete", {
        directory: key,
        source,
        ...state,
      })
      void run(key, entry)
    } else if (wasWaiting) {
      log.info("reload waiting for sessions", {
        directory: key,
        source,
        ...state,
      })
    }

    return entry
  }

  async function run(key: string, entry: Entry) {
    if (entry.running) return entry.running

    const startedAt = Date.now()
    log.info("reload instance reloading", {
      directory: key,
      waitDuration: startedAt - entry.requestedAt,
      ...progress(entry),
    })

    void publish(key, "running")
    entry.running = Promise.all([State.dispose(key, { soft: true }), disposeInstance(key, { soft: true })])
      .catch((error) => {
        log.error("reload failed", {
          directory: key,
          duration: Date.now() - startedAt,
          totalDuration: Date.now() - entry.requestedAt,
          error,
        })
        entry.reject(error)
        throw error
      })
      .then(() => {
        Instance.forget(key)
        log.info("reload completed", {
          directory: key,
          duration: Date.now() - startedAt,
          totalDuration: Date.now() - entry.requestedAt,
        })
        entry.resolve()
      })
      .finally(() => {
        if (pending.get(key) === entry) pending.delete(key)
        void publish(key, "idle")
      })
    return entry.running
  }

  export function status(directory: string) {
    const entry = pending.get(dir(directory))
    if (!entry) return "idle" as const
    if (entry.running) return "running" as const
    return "pending" as const
  }

  export function enter(directory: string, sessionID: string) {
    const key = dir(directory)
    const sessions = active.get(key) ?? new Set<string>()
    sessions.add(sessionID)
    active.set(key, sessions)
  }

  export function leave(directory: string, sessionID: string) {
    const key = dir(directory)
    const sessions = active.get(key)
    sessions?.delete(sessionID)
    if (sessions && sessions.size === 0) active.delete(key)

    const entry = pending.get(key)
    if (!entry) return

    if (!entry.sessions.has(sessionID)) return

    log.info("reload session left before waitpoint", {
      directory: key,
      sessionID,
      ...progress(entry),
    })
    mark(key, sessionID, "leave")
  }

  export function request(directory: string) {
    const key = dir(directory)
    const existing = pending.get(key)
    if (existing) {
      log.info("reload request joined existing cycle", {
        directory: key,
        status: existing.running ? "running" : "pending",
        ...progress(existing),
      })
      return existing.promise
    }

    let resolve = () => {}
    let reject = (_error?: unknown) => {}
    const promise = new Promise<void>((next, fail) => {
      resolve = next
      reject = fail
    })
    const sessions = new Set(active.get(key) ?? [])
    const entry: Entry = {
      sessions,
      totalSessions: sessions.size,
      requestedAt: Date.now(),
      promise,
      resolve,
      reject,
    }
    pending.set(key, entry)
    log.info("reload requested", {
      directory: key,
      ...progress(entry),
    })
    void publish(key, "pending")
    if (entry.sessions.size === 0) {
      void run(key, entry)
    }
    return promise
  }

  export function arrive(directory: string, sessionID: string) {
    mark(dir(directory), sessionID, "arrive")
  }

  export function wait(directory: string, sessionID: string) {
    const key = dir(directory)
    const entry = mark(key, sessionID, "wait")
    if (!entry) return

    log.info("reload session waiting for completion", {
      directory: key,
      sessionID,
      status: entry.running ? "running" : "pending",
      ...progress(entry),
    })

    return entry.promise
      .then(() => {
        log.info("reload session resumed", {
          directory: key,
          sessionID,
          totalDuration: Date.now() - entry.requestedAt,
        })
      })
      .catch((error) => {
        log.warn("reload session resumed after failure", {
          directory: key,
          sessionID,
          totalDuration: Date.now() - entry.requestedAt,
          error,
        })
      })
  }
}
