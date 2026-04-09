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

  function mark(key: string, sessionID: string) {
    const entry = pending.get(key)
    if (!entry) return
    entry.sessions.delete(sessionID)
    if (entry.sessions.size === 0) {
      void run(key, entry)
    }
    return entry
  }

  async function run(key: string, entry: Entry) {
    if (entry.running) return entry.running
    void publish(key, "running")
    entry.running = Promise.all([State.dispose(key, { soft: true }), disposeInstance(key, { soft: true })])
      .catch((error) => {
        entry.reject(error)
        throw error
      })
      .then(() => {
        Instance.forget(key)
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
    entry.sessions.delete(sessionID)
    if (entry.sessions.size === 0) {
      void run(key, entry)
    }
  }

  export function request(directory: string) {
    const key = dir(directory)
    const existing = pending.get(key)
    if (existing) return existing.promise

    let resolve = () => {}
    let reject = (_error?: unknown) => {}
    const promise = new Promise<void>((next, fail) => {
      resolve = next
      reject = fail
    })
    const entry: Entry = {
      sessions: new Set(active.get(key) ?? []),
      promise,
      resolve,
      reject,
    }
    pending.set(key, entry)
    log.info("requested", { directory: key, sessions: Array.from(entry.sessions) })
    void publish(key, "pending")
    if (entry.sessions.size === 0) {
      void run(key, entry)
    }
    return promise
  }

  export function arrive(directory: string, sessionID: string) {
    mark(dir(directory), sessionID)
  }

  export function wait(directory: string, sessionID: string) {
    const entry = mark(dir(directory), sessionID)
    if (!entry) return
    return entry.promise.catch(() => {})
  }
}
