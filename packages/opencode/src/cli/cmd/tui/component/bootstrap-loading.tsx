import { RGBA } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, createMemo, createSignal, onCleanup } from "solid-js"
import { useTheme } from "../context/theme"

const LARGE_SPINNER_POINTS = [
  [0, 0],
  [1, 0],
  [2, 0],
  [3, 0],
  [4, 0],
  [5, 0],
  [6, 0],
  [6, 1],
  [6, 2],
  [6, 3],
  [6, 4],
  [6, 5],
  [6, 6],
  [5, 6],
  [4, 6],
  [3, 6],
  [2, 6],
  [1, 6],
  [0, 6],
  [0, 5],
  [0, 4],
  [0, 3],
  [0, 2],
  [0, 1],
] as const

export function BootstrapLoading(props: { title: string; detail?: string }) {
  const { theme } = useTheme()
  const dim = useTerminalDimensions()
  const [frame, setFrame] = createSignal(0)

  const timer = setInterval(() => {
    setFrame((value) => (value + 1) % LARGE_SPINNER_POINTS.length)
  }, 100)
  onCleanup(() => clearInterval(timer))

  const rows = createMemo(() => {
    const active = frame()
    const trail = (active - 1 + LARGE_SPINNER_POINTS.length) % LARGE_SPINNER_POINTS.length
    const trail2 = (active - 2 + LARGE_SPINNER_POINTS.length) % LARGE_SPINNER_POINTS.length
    return Array.from({ length: 7 }, (_, y) =>
      Array.from({ length: 7 }, (_, x) => {
        const index = LARGE_SPINNER_POINTS.findIndex(([px, py]) => px === x && py === y)
        if (index === -1) return { char: " ", color: theme.textMuted }
        if (index === active) return { char: "█", color: theme.primary }
        if (index === trail) return { char: "▓", color: theme.text }
        if (index === trail2) return { char: "▒", color: theme.textMuted }
        return { char: "░", color: theme.textMuted }
      }),
    )
  })

  useKeyboard((evt) => {
    evt.preventDefault()
    evt.stopPropagation()
  })

  return (
    <box
      position="absolute"
      zIndex={4500}
      left={0}
      top={0}
      width={dim().width}
      height={dim().height}
      alignItems="center"
      justifyContent="center"
      backgroundColor={RGBA.fromInts(0, 0, 0, 210)}
      onMouseDown={(evt) => {
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={(evt) => {
        evt.preventDefault()
        evt.stopPropagation()
      }}
    >
      <box width={72} maxWidth={dim().width - 4} alignItems="center" flexDirection="column" gap={1} paddingTop={2} paddingBottom={2} backgroundColor={theme.backgroundPanel}>
        <box flexDirection="column" paddingBottom={1}>
          <For each={rows()}>
            {(row) => (
              <text>
                <For each={row}>{(cell) => <span style={{ fg: cell.color }}>{cell.char}</span>}</For>
              </text>
            )}
          </For>
        </box>
        <text fg={theme.text}>
          <b>{props.title}</b>
        </text>
        <text fg={theme.primary}>Bootstrapping workspace...</text>
        <text fg={theme.textMuted}>Please wait until the directory switch completes</text>
        <text fg={theme.textMuted}>{props.detail ?? "Loading sessions, providers, paths, and workspace state"}</text>
      </box>
    </box>
  )
}
