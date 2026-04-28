import { createMemo } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogToolOutput } from "./dialog-tool-output"

export function DialogTool(props: {
  tool: string
  output?: string
  error?: string
}) {
  const options = createMemo(() => {
    const out = props.output?.trim()
    const err = props.error?.trim()
    return [
      ...(out
        ? [
            {
              title: "Output details",
              value: "tool.output",
              description: "show full tool output",
              onSelect: (dialog) => {
                DialogToolOutput.show(dialog, `${props.tool} Output`, out)
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
              onSelect: (dialog) => {
                DialogToolOutput.show(dialog, `${props.tool} Error`, err)
              },
            },
          ]
        : []),
    ]
  })

  return <DialogSelect title={`${props.tool} Actions`} options={options()} />
}
