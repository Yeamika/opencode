import { MessageV2 } from "./message-v2"

const LIMIT = 4096
const NOTE = "\n…[preview truncated; open details for full value]"

function clip(text: string) {
  if (Buffer.byteLength(text, "utf8") <= LIMIT) return text
  let end = Math.min(text.length, LIMIT)
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > LIMIT) end--
  return text.slice(0, end) + NOTE
}

function walk(value: unknown, key?: string): unknown {
  if (typeof value === "string") return key === "diff" ? value : clip(value)
  if (Array.isArray(value)) return value.map((item) => walk(item, key))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, key)]))
}

function file(part: MessageV2.FilePart): MessageV2.FilePart {
  return {
    ...part,
    url: clip(part.url),
    ...(part.source?.text
      ? {
          source: {
            ...part.source,
            text: {
              ...part.source.text,
              value: clip(part.source.text.value),
            },
          },
        }
      : {}),
  }
}

export namespace Preview {
  export function part<T extends MessageV2.Part>(part: T): T {
    if (part.type === "file") return file(part) as T
    if (part.type !== "tool") return part
    const state = part.state
    if (state.status === "pending") {
      return {
        ...part,
        state: {
          ...state,
          input: walk(state.input) as typeof state.input,
          raw: clip(state.raw),
        },
      } as T
    }
    if (state.status === "running") {
      return {
        ...part,
        state: {
          ...state,
          input: walk(state.input) as typeof state.input,
          metadata: state.metadata ? (walk(state.metadata) as typeof state.metadata) : state.metadata,
        },
      } as T
    }
    if (state.status === "completed") {
      return {
        ...part,
        state: {
          ...state,
          input: walk(state.input) as typeof state.input,
          output: clip(state.output),
          metadata: walk(state.metadata) as typeof state.metadata,
          attachments: state.attachments?.map(file),
        },
      } as T
    }
    return {
      ...part,
      state: {
        ...state,
        input: walk(state.input) as typeof state.input,
        error: clip(state.error),
        metadata: state.metadata ? (walk(state.metadata) as typeof state.metadata) : state.metadata,
      },
    } as T
  }

  export function message<T extends MessageV2.WithParts>(message: T): T {
    return {
      ...message,
      parts: message.parts.map(part),
    }
  }
}
