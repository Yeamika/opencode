import { createMemo } from "solid-js"
import type { DialogContext } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { DialogToolOutput } from "./dialog-tool-output"

function safe(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "rawPretty"))
}

export function DialogTool(props: {
  tool: string
  sessionID?: string
  messageID?: string
  partID?: string
  input?: unknown
  output?: string
  metadata?: unknown
  attachments?: unknown
  error?: string
}) {
  const sdk = useSDK()
  const load = async () => {
    if (!props.sessionID || !props.messageID || !props.partID) return undefined
    const result = await sdk.client.session.message({ sessionID: props.sessionID, messageID: props.messageID })
    const part = result.data?.parts.find((item) => item.id === props.partID)
    if (!part || part.type !== "tool") return undefined
    return part
  }

  const options = createMemo(() => {
    const out = props.output?.trim()
    const err = props.error?.trim()
    const input = JSON.stringify(props.input ?? {}, null, 2)
    const metadata = JSON.stringify(safe(props.metadata) ?? {}, null, 2)
    const attachments = JSON.stringify(props.attachments ?? [], null, 2)
    return [
      {
        title: "Input details",
        value: "tool.input",
        description: "show full tool input parameters",
        onSelect: async (dialog: DialogContext) => {
          const part = await load()
          const full = JSON.stringify(part?.state.input ?? props.input ?? {}, null, 2)
          DialogToolOutput.show(dialog, `${props.tool} Input`, full, { filetype: "json" })
        },
      },
      ...(out
        ? [
            {
              title: "Output details",
              value: "tool.output",
              description: "show full tool output",
              onSelect: async (dialog: DialogContext) => {
                const part = await load()
                const full = part?.state.status === "completed" ? part.state.output : (props.output ?? "")
                DialogToolOutput.show(dialog, `${props.tool} Output`, String(full), { ansi: true })
              },
            },
          ]
        : []),
      ...(props.metadata
        ? [
            {
              title: "Metadata details",
              value: "tool.metadata",
              description: "show full tool metadata",
              onSelect: async (dialog: DialogContext) => {
                const part = await load()
                const full =
                  part?.state.status === "running" ||
                  part?.state.status === "completed" ||
                  part?.state.status === "error"
                    ? JSON.stringify(safe(part.state.metadata) ?? {}, null, 2)
                    : metadata
                DialogToolOutput.show(dialog, `${props.tool} Metadata`, full, { filetype: "json" })
              },
            },
          ]
        : []),
      ...(props.attachments
        ? [
            {
              title: "Attachments details",
              value: "tool.attachments",
              description: "show full tool attachments",
              onSelect: async (dialog: DialogContext) => {
                const part = await load()
                const full =
                  part?.state.status === "completed"
                    ? JSON.stringify(part.state.attachments ?? [], null, 2)
                    : attachments
                DialogToolOutput.show(dialog, `${props.tool} Attachments`, full, { filetype: "json" })
              },
            },
          ]
        : []),
      ...(err
        ? [
            {
              title: "Error details",
              value: "tool.error",
              description: "show full tool error",
              onSelect: async (dialog: DialogContext) => {
                const part = await load()
                const full = part?.state.status === "error" ? part.state.error : err
                DialogToolOutput.show(dialog, `${props.tool} Error`, String(full), { ansi: true })
              },
            },
          ]
        : []),
    ]
  })

  return <DialogSelect title={`${props.tool} Actions`} options={options()} />
}
