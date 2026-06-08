import "@/util/ai-sdk-warning"
import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { GlobalBus } from "@/bus/global"
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { Flag } from "@/flag/flag"
import { setTimeout as sleep } from "node:timers/promises"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

Heap.start()

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

const eventStream = {
  abort: undefined as AbortController | undefined,
}

const state = {
  directory: process.cwd(),
  workspaceID: undefined as string | undefined,
  displayID: process.env.OPENCODE_DISPLAY_ID,
}

function forward(event: { directory?: string; payload?: { type?: unknown } }) {
  Rpc.emit("global.event", event)
  const type = typeof event.payload?.type === "string" ? event.payload.type : ""
  if (!type) return
  if (type.startsWith("tui.")) {
    if (!state.workspaceID) Rpc.emit("event", event.payload)
    return
  }
  if (state.workspaceID) return
  if (event.directory === undefined || event.directory === "global" || event.directory === state.directory) {
    Rpc.emit("event", event.payload)
  }
}

GlobalBus.on("event", forward)

const startEventStream = (input: { directory: string; workspaceID?: string }) => {
  const restarting = Boolean(eventStream.abort)
  if (eventStream.abort) eventStream.abort.abort()
  const abort = new AbortController()
  eventStream.abort = abort
  const signal = abort.signal
  let notifyReconnect = restarting

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const auth = getAuthorizationHeader()
    if (auth) request.headers.set("Authorization", auth)
    return Server.Default().fetch(request)
  }) as typeof globalThis.fetch

  const sdk = createOpencodeClient({
    baseUrl: "http://opencode.internal",
    directory: input.directory,
    experimental_workspaceID: input.workspaceID,
    experimental_displayID: state.displayID,
    fetch: fetchFn,
    signal,
  })

  ;(async () => {
    while (!signal.aborted) {
      const events = await Promise.resolve(sdk.event.subscribe({}, { signal })).catch(() => undefined)

      if (!events) {
        await sleep(250)
        continue
      }

      if (notifyReconnect && !signal.aborted) {
        notifyReconnect = false
        Rpc.emit("event", {
          type: "tui.sse.reconnected",
          properties: {
            directory: input.directory,
            workspaceID: input.workspaceID,
          },
        })
      }

      for await (const event of events.stream) {
        Rpc.emit("event", event as Event)
      }

      if (!signal.aborted) {
        notifyReconnect = true
        await sleep(250)
      }
    }
  })().catch((error) => {
    Log.Default.error("event stream error", {
      error: error instanceof Error ? error.message : error,
    })
  })
}

function stopEventStream() {
  eventStream.abort?.abort()
  eventStream.abort = undefined
}

async function requestReload(directory: string) {
  const url = new URL("/project/reload", "http://opencode.internal")
  url.searchParams.set("directory", directory)
  const headers: Record<string, string> = {}
  const auth = getAuthorizationHeader()
  if (auth) headers.Authorization = auth
  const response = await Server.Default().fetch(
    new Request(url, {
      method: "POST",
      headers,
    }),
  )
  if (!response.ok) {
    throw new Error(`reload failed (${response.status})`)
  }
}

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = getAuthorizationHeader()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await Instance.provide({
      directory: input.directory,
      init: InstanceBootstrap,
      fn: async () => {
        await upgrade().catch(() => {})
      },
    })
  },
  async reload(input: { directory: string }) {
    const restart = state.directory !== input.directory || state.workspaceID !== undefined
    state.directory = input.directory
    state.workspaceID = undefined
    if (restart) stopEventStream()
    await requestReload(state.directory)
  },
  async setDirectory(input: { directory: string }) {
    state.directory = input.directory
    state.workspaceID = undefined
    stopEventStream()
  },
  async setWorkspace(input: { workspaceID?: string }) {
    state.workspaceID = input.workspaceID
    if (state.workspaceID) startEventStream({ directory: state.directory, workspaceID: state.workspaceID })
    else stopEventStream()
  },
  async shutdown() {
    Log.Default.info("worker shutting down")
    GlobalBus.off("event", forward)
    stopEventStream()
    await Instance.disposeAll()
    if (server) await server.stop(true)
  },
}

Rpc.listen(rpc)

function getAuthorizationHeader(): string | undefined {
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${btoa(`${username}:${password}`)}`
}
