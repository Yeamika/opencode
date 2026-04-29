import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { getScrollAcceleration } from "../../util/scroll"
import { useDialog, type DialogContext } from "../../ui/dialog"

export function DialogToolOutput(props: {
  title: string
  message: string
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const cfg = useTuiConfig()
  const dim = useTerminalDimensions()
  const height = createMemo(() => {
    const max = Math.max(6, Math.floor(dim().height * 0.75) - 7)
    return Math.max(6, Math.min(Math.floor(dim().height * 0.5), max))
  })

  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") dialog.clear()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <scrollbox
        height={height()}
        scrollAcceleration={getScrollAcceleration(cfg)}
        verticalScrollbarOptions={{
          visible: true,
          trackOptions: {
            backgroundColor: theme.background,
            foregroundColor: theme.border,
          },
        }}
      >
        <text fg={theme.textMuted}>{props.message}</text>
      </scrollbox>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}

DialogToolOutput.show = (dialog: DialogContext, title: string, message: string) => {
  dialog.setSize("large")
  dialog.replace(() => <DialogToolOutput title={title} message={message} />)
}
