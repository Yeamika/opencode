import { getHandle } from "./refs-bridge"

type BaseRequest = {
  id: number
  dbPath: string
  sessionID: string
  workdir: string
}

type Request =
  | (BaseRequest & {
      kind: "tool"
      tool: string
      args: string
    })
  | (BaseRequest & {
      kind: "raw"
      request: string
    })
  | (BaseRequest & {
      kind: "list-executors"
    })

type Response =
  | {
      id: number
      json: string
    }
  | {
      id: number
      error: string
    }
  | {
      event: "exbash.changed"
      sessionID: string
      workspace: string
      type?: string
      scope?: string
      cwd?: string
      task?: unknown
      asyncID?: string
      executor?: string
    }

const subscribed = new Set<string>()

function subscribe(input: Request) {
  const key = `${input.dbPath}\n${input.sessionID}\n${input.workdir}`
  if (subscribed.has(key)) return
  const handle = getHandle({
    dbPath: input.dbPath,
    sessionID: input.sessionID,
    workdir: input.workdir,
  })
  handle.setExbashChangedCallback((eventJson) => {
    try {
      const event = JSON.parse(eventJson) as Record<string, unknown>
      if (typeof event.sessionID !== "string" || typeof event.workspace !== "string") return
      self.postMessage({
        ...event,
        event: "exbash.changed",
        sessionID: event.sessionID,
        workspace: event.workspace,
      } satisfies Response)
    } catch {
      // Ignore malformed native event payloads; tool results still report real errors.
    }
  })
  subscribed.add(key)
}

self.onmessage = (event: MessageEvent<Request>) => {
  const input = event.data
  try {
    subscribe(input)
    const handle = getHandle({
      dbPath: input.dbPath,
      sessionID: input.sessionID,
      workdir: input.workdir,
    })
    const json =
      input.kind === "raw"
        ? handle.handleRaw(input.request)
        : input.kind === "list-executors"
          ? handle.listExecutorsJson()
          : handle.callTool(input.tool, input.args)
    self.postMessage({ id: input.id, json } satisfies Response)
  } catch (error) {
    self.postMessage({
      id: input.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies Response)
  }
}
