import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { Clipboard } from "@tui/util/clipboard"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"
import { useToast } from "@tui/ui/toast"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()
  const active = createMemo(() => message()?.role === "assistant")
  const user = createMemo(() => message()?.role === "user")

  async function mark() {
    const url = new URL(`/session/${props.sessionID}/message/${props.messageID}/mark_error`, sdk.url)
    if (sdk.workspaceID) url.searchParams.set("workspace", sdk.workspaceID)
    else if (sdk.directory) url.searchParams.set("directory", sdk.directory)

    const response = await sdk.fetch(url, {
      method: "POST",
      headers: {
        ...(sdk.headers ?? {}),
      },
    })
    if (!response.ok) throw new Error(`mark error failed (${response.status})`)
    return (await response.json()) as boolean
  }

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        ...(active()
          ? [
              {
                title: "MarkErrorAction",
                value: "message.mark_error",
                description: "finish this assistant turn as error_execute",
                onSelect: (dialog) => {
                  void mark()
                    .then((ok) => {
                      if (!ok) {
                        toast.show({ message: "Nothing to mark", variant: "info" })
                        return
                      }
                      dialog.clear()
                    })
                    .catch((error) => {
                      toast.show({
                        message: error instanceof Error ? error.message : "Failed to mark error",
                        variant: "error",
                      })
                    })
                },
              },
            ]
          : []),
        ...(user()
          ? [
              {
                title: "Revert",
                value: "session.revert",
                description: "undo messages and file changes",
                onSelect: (dialog) => {
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
            ]
          : []),
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
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
        ...(user()
          ? [
              {
                title: "Fork",
                value: "session.fork",
                description: "create a new session",
                onSelect: async (dialog) => {
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
          : []),
      ]}
    />
  )
}
