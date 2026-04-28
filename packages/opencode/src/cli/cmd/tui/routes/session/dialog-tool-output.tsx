import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
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

  useKeyboard((evt) => {
    if (evt.name === "return") dialog.clear()
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
        height={Math.max(8, Math.floor(dim().height * 0.6))}
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
    </box>
  )
}

DialogToolOutput.show = (dialog: DialogContext, title: string, message: string) => {
  dialog.replace(() => <DialogToolOutput title={title} message={message} />)
}
