import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import type { DialogContext } from "@tui/ui/dialog"
import { Clipboard } from "@tui/util/clipboard"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"
import { DialogToolOutput } from "./dialog-tool-output"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()
  const detail = createMemo(() => {
    const msg = message()
    if (!msg || msg.role !== "assistant" || !msg.error) return ""
    const data = msg.error.data
    if (typeof data === "string") return data
    if (data && typeof data === "object") {
      const text = Reflect.get(data, "message")
      const body = JSON.stringify(data, null, 2)
      if (typeof text === "string" && text.trim() && body && body !== JSON.stringify(text)) {
        return [text, body].join("\n\n")
      }
      if (typeof text === "string" && text.trim()) return text
      if (body) return body
    }
    const text = Reflect.get(msg.error, "message")
    return typeof text === "string" ? text : ""
  })

  const options = createMemo(() => {
    const msg = message()
    return [
      ...(msg?.role === "assistant" && msg.error
        ? [
            {
              title: "Message details",
              value: "message.details",
              description: "show full error message",
              onSelect: (dialog: DialogContext) => {
                DialogToolOutput.show(dialog, "Message Details", detail())
              },
            },
            {
              title: "Delete",
              value: "message.delete",
              description: "remove this message",
              onSelect: async (dialog: DialogContext) => {
                await sdk.client.session.deleteMessage({
                  sessionID: props.sessionID,
                  messageID: props.messageID,
                })
                dialog.clear()
              },
            },
          ]
        : []),
      {
        title: "Revert",
        value: "session.revert",
        description: "undo messages and file changes",
        onSelect: (dialog: DialogContext) => {
          const msg = message()
          if (!msg) return

          sdk.client.session.revert({
            sessionID: props.sessionID,
            messageID: msg.id,
          })

          if (props.setPrompt) {
            const parts = sync.data.part[msg.id]
            const promptInfo = parts.reduce(
              (agg, part) => {
                if (part.type === "text") {
                  if (!part.synthetic) agg.input += part.text
                }
                if (part.type === "file") agg.parts.push(strip(part))
                return agg
              },
              { input: "", parts: [] as PromptInfo["parts"] },
            )
            props.setPrompt(promptInfo)
          }

          dialog.clear()
        },
      },
      {
        title: "Copy",
        value: "message.copy",
        description: "message text to clipboard",
        onSelect: async (dialog: DialogContext) => {
          const msg = message()
          if (!msg) return

          const parts = sync.data.part[msg.id]
          const text = parts.reduce((agg, part) => {
            if (part.type === "text" && !part.synthetic) {
              agg += part.text
            }
            return agg
          }, "")

          await Clipboard.copy(text)
          dialog.clear()
        },
      },
      {
        title: "Fork",
        value: "session.fork",
        description: "create a new session",
        onSelect: async (dialog: DialogContext) => {
          const result = await sdk.client.session.fork({
            sessionID: props.sessionID,
            messageID: props.messageID,
          })
          const initialPrompt = (() => {
            const msg = message()
            if (!msg) return undefined
            const parts = sync.data.part[msg.id]
            return parts.reduce(
              (agg, part) => {
                if (part.type === "text") {
                  if (!part.synthetic) agg.input += part.text
                }
                if (part.type === "file") agg.parts.push(part)
                return agg
              },
              { input: "", parts: [] as PromptInfo["parts"] },
            )
          })()
          route.navigate({
            sessionID: result.data!.id,
            type: "session",
            initialPrompt,
          })
          dialog.clear()
        },
      },
    ]
  })

  return <DialogSelect title="Message Actions" options={options()} />
}
