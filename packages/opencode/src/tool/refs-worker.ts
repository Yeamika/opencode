import { getHandle } from "./refs-bridge"

type Request = {
  id: number
  dbPath: string
  sessionID: string
  workdir: string
  tool: string
  args: string
}

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
    }

const subscribed = new Set<string>()

function subscribe(input: Request) {
  const key = `${input.dbPath}\n${input.workdir}`
  if (subscribed.has(key)) return
  const handle = getHandle({
    dbPath: input.dbPath,
    sessionID: input.sessionID,
    workdir: input.workdir,
  })
  handle.setExbashChangedCallback((eventJson) => {
    try {
      const event = JSON.parse(eventJson) as { sessionID?: string; workspace?: string }
      if (!event.sessionID || !event.workspace) return
      self.postMessage({
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
    const json = getHandle({
      dbPath: input.dbPath,
      sessionID: input.sessionID,
      workdir: input.workdir,
    }).callTool(input.tool, input.args)
    self.postMessage({ id: input.id, json } satisfies Response)
  } catch (error) {
    self.postMessage({
      id: input.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies Response)
  }
}
