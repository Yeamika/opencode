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

self.onmessage = (event: MessageEvent<Request>) => {
  const input = event.data
  try {
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
