import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup, onMount } from "solid-js"

type BaseEvent = Exclude<
  Event,
  {
    type: "project.reload.updated" | "tui.attach-to-running-session" | "tui.display.report" | "tui.session.select"
  }
>

export type EventSource = {
  on: (handler: (event: TuiSdkEvent) => void) => () => void
  setDirectory?: (directory: string) => void
  reload?: (directory: string) => Promise<void>
  setWorkspace?: (workspaceID?: string) => void
}

type DisplayReportEvent = {
  type: "tui.display.report"
  properties: {
    displayID: string
    directory?: string
    sessionID?: string
  }
}

type SseReconnectedEvent = {
  type: "tui.sse.reconnected"
  properties: {
    directory?: string
    workspaceID?: string
  }
}

type ProjectReloadUpdatedEvent = {
  type: "project.reload.updated"
  properties: {
    directory: string
    status: "idle" | "pending" | "running"
    totalSessions: number
    readySessions: number
    waitingSessions: number
  }
}

type SessionSelectEvent = {
  type: "tui.session.select"
  properties: {
    sessionID: string
    displayID: string
    directory?: string
    requestID?: string
  }
}

type AttachToRunningSessionEvent = {
  type: "tui.attach-to-running-session"
  properties: {
    sessionID: string
    displayID: string
    directory?: string
    workspaceID?: string
    requestID?: string
  }
}

export type TuiSdkEvent =
  | BaseEvent
  | DisplayReportEvent
  | SseReconnectedEvent
  | ProjectReloadUpdatedEvent
  | SessionSelectEvent
  | AttachToRunningSessionEvent

type Props = {
  url: string
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
  displayID?: string
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: Props) => {
    const abort = new AbortController()
    let directory = props.directory
    let workspaceID: string | undefined
    let sse: AbortController | undefined

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory,
        fetch: props.fetch,
        headers: props.headers,
        experimental_workspaceID: workspaceID,
        experimental_displayID: props.displayID,
      })
    }

    async function reload(next: string) {
      const url = new URL("/project/reload", props.url)
      url.searchParams.set("directory", next)
      const response = await (props.fetch ?? fetch)(url, {
        method: "POST",
        headers: props.headers,
      })
      if (!response.ok) {
        throw new Error(`reload failed (${response.status})`)
      }
    }

    let sdk = createSDK()

    const emitter = createGlobalEmitter<{
      [key in TuiSdkEvent["type"]]: Extract<TuiSdkEvent, { type: key }>
    }>()

    let queue: TuiSdkEvent[] = []
    let timer: Timer | undefined
    let last = 0

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit(event.type, event)
        }
      })
    }

    const handleEvent = (event: TuiSdkEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      const restarting = Boolean(sse)
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      let notifyReconnect = restarting
      ;(async () => {
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break
          const events = await sdk.event.subscribe({}, { signal: ctrl.signal })

          if (notifyReconnect && !ctrl.signal.aborted) {
            notifyReconnect = false
            handleEvent({
              type: "tui.sse.reconnected",
              properties: {
                directory,
                workspaceID,
              },
            })
          }

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event as TuiSdkEvent)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          notifyReconnect = true
        }
      })().catch(() => {})
    }

    onMount(() => {
      if (props.events) {
        const unsub = props.events.on(handleEvent)
        onCleanup(unsub)
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
    })

    return {
      get client() {
        return sdk
      },
      get directory() {
        return directory
      },
      get displayID() {
        return props.displayID
      },
      get workspaceID() {
        return workspaceID
      },
      event: emitter,
      fetch: props.fetch ?? fetch,
      headers: props.headers,
      setDirectory(next: string) {
        if (directory === next) return
        directory = next
        workspaceID = undefined
        sdk = createSDK()
        props.events?.setDirectory?.(next)
        if (!props.events) startSSE()
      },
      async reload(next: string) {
        const restart = directory !== next || workspaceID !== undefined
        directory = next
        workspaceID = undefined
        sdk = createSDK()
        if (props.events) {
          await props.events.reload?.(next)
        } else {
          await reload(next)
        }
        if (!props.events && restart) startSSE()
      },
      setWorkspace(next?: string) {
        if (workspaceID === next) return
        workspaceID = next
        sdk = createSDK()
        props.events?.setWorkspace?.(next)
        if (!props.events) startSSE()
      },
      url: props.url,
    }
  },
})
