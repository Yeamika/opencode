import { Log } from "@/util/log"

export namespace State {
  interface Entry {
    state: any
    dispose?: (state: any) => Promise<void>
    keep?: boolean
  }

  const log = Log.create({ service: "state" })
  const recordsByKey = new Map<string, Map<any, Entry>>()

  export function create<S>(
    root: () => string,
    init: () => S,
    dispose?: (state: Awaited<S>) => Promise<void>,
    opts?: { keep?: boolean },
  ) {
    return () => {
      const key = root()
      let entries = recordsByKey.get(key)
      if (!entries) {
        entries = new Map<string, Entry>()
        recordsByKey.set(key, entries)
      }
      const exists = entries.get(init)
      if (exists) return exists.state as S
      const state = init()
      entries.set(init, {
        state,
        dispose,
        keep: opts?.keep,
      })
      return state
    }
  }

  export async function dispose(key: string, opts?: { soft?: boolean }) {
    const entries = recordsByKey.get(key)
    if (!entries) return

    log.info("waiting for state disposal to complete", { key })

    let disposalFinished = false
    const keep = new Map<any, Entry>()

    const timer = setTimeout(() => {
      if (!disposalFinished) {
        log.warn(
          "state disposal is taking an unusually long time - if it does not complete in a reasonable time, please report this as a bug",
          { key },
        )
      }
    }, 10000)
    ;(timer as { unref?: () => void }).unref?.()

    const tasks: Promise<void>[] = []
    for (const [init, entry] of Array.from(entries.entries())) {
      if (opts?.soft && entry.keep) {
        keep.set(init, entry)
        continue
      }

      if (!entry.dispose) continue

      const label = typeof init === "function" ? init.name : String(init)

      const task = Promise.resolve(entry.state)
        .then((state) => entry.dispose!(state))
        .catch((error) => {
          log.error("Error while disposing state:", { error, key, init: label })
        })

      tasks.push(task)
    }
    await Promise.all(tasks)

    if (keep.size > 0) {
      recordsByKey.set(key, keep)
    } else {
      recordsByKey.delete(key)
    }

    disposalFinished = true
    log.info("state disposal completed", { key })
  }
}
