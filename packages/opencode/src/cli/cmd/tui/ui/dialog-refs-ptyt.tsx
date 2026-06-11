import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { useToast } from "./toast"
import { useDialog } from "./dialog"
import { Clipboard } from "../util/clipboard"

export function DialogRefsPtyt(props: { command: string; error?: string }) {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const close = () => dialog.clear()
  const copy = () => {
    Clipboard.copy(props.command)
      .then(() => toast.show({ message: "refs-ptyt command copied", variant: "info" }))
      .catch((error) => toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" }))
  }

  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") close()
    if (evt.name === "c" && !evt.ctrl && !evt.meta) copy()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          refs-ptyt
        </text>
        <text fg={theme.textMuted} onMouseUp={close}>
          esc/enter
        </text>
      </box>
      <box flexDirection="column">
        <text fg={theme.textMuted}>Command</text>
        <text fg={theme.text} wrapMode="word">
          {props.command}
        </text>
      </box>
      <box flexDirection="column">
        <text fg={props.error ? theme.error : theme.textMuted}>{props.error ?? "Opening refs-ptyt in a terminal window"}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.backgroundPanel} onMouseUp={copy}>
          <text fg={theme.text}>copy</text>
        </box>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={close}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}
