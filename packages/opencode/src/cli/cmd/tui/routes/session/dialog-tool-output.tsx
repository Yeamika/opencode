import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Show, createMemo } from "solid-js"
import { useTheme } from "@tui/context/theme"
import stripAnsi from "strip-ansi"
import { useTuiConfig } from "../../context/tui-config"
import { useTheme as useThemeFull } from "../../context/theme"
import { getScrollAcceleration } from "../../util/scroll"
import { useDialog, type DialogContext } from "../../ui/dialog"

export function DialogToolOutput(props: { title: string; message: string; ansi?: boolean; filetype?: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const { syntax } = useThemeFull()
  const cfg = useTuiConfig()
  const dim = useTerminalDimensions()
  const text = createMemo(() => (props.ansi ? stripAnsi(props.message) : props.message))
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
        <Show when={props.filetype} fallback={<text fg={theme.textMuted}>{text()}</text>}>
          <code fg={theme.text} filetype={props.filetype!} syntaxStyle={syntax()} content={text()} />
        </Show>
      </scrollbox>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}

DialogToolOutput.show = (
  dialog: DialogContext,
  title: string,
  message: string,
  options?: { ansi?: boolean; filetype?: string },
) => {
  dialog.setSize("large")
  dialog.replace(() => (
    <DialogToolOutput title={title} message={message} ansi={options?.ansi} filetype={options?.filetype} />
  ))
}
