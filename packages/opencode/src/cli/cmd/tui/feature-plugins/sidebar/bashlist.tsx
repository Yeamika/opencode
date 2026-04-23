import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { Spinner } from "@tui/component/spinner"

const id = "internal:sidebar-bashlist"

type Job = ReturnType<TuiPluginApi["state"]["session"]["exbash"]>[number]

function status(job: Job) {
  if (job.status === "running") return "running"
  return `exitcode:${job.exitCode ?? -1}`
}

function subtitle(job: Job) {
  return `${job.asyncID} AT ${job.cwd}[${job.scope}]`
}

function time(job: Job) {
  const start = new Date(job.startedAt).toLocaleString()
  const end = job.endedAt ? new Date(job.endedAt).toLocaleString() : "-"
  return `${start} - ${end}`
}

function short(job: Job) {
  const text = job.description || job.command
  if (text.length <= 28) return text
  return `${text.slice(0, 27)}…`
}

function Detail(props: { api: TuiPluginApi; job: Job }) {
  const theme = () => props.api.theme.current
  const close = () => props.api.ui.dialog.clear()
  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") close()
  })

  const row = (label: string, value?: string | number) => {
    if (value === undefined || value === "") return undefined
    return (
      <box flexDirection="column">
        <text fg={theme().textMuted}>{label}</text>
        <text fg={theme().text}>{String(value)}</text>
      </box>
    )
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme().text}>{`${props.job.description}【${status(props.job)}】`}</text>
        <text fg={theme().textMuted} onMouseUp={close}>
          esc/enter
        </text>
      </box>
      <text fg={theme().textMuted}>{subtitle(props.job)}</text>
      <box flexDirection="column" gap={1} paddingBottom={1}>
        {row("Command", props.job.command)}
        {row("timeout", props.job.timeout)}
        {row("Line Pointer", props.job.linePointer)}
        {row("Result Path", props.job.resultPath)}
        {row("time", time(props.job))}
        <Show when={props.job.error}>{row("error", props.job.error)}</Show>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme().primary} onMouseUp={close}>
          <text fg={theme().selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}

function icon(props: { api: TuiPluginApi; job: Job }) {
  const theme = () => props.api.theme.current
  if (props.job.status === "running") return <Spinner color={theme().info} />
  if ((props.job.exitCode ?? -1) === 0) return <text fg={theme().success}>[✓]</text>
  return <text fg={theme().error}>[E]</text>
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.exbash(props.session_id))

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Bash</b>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(job) => (
              <box flexDirection="row" gap={1}>
                {icon({ api: props.api, job })}
                <text
                  fg={theme().textMuted}
                  wrapMode="none"
                  onMouseUp={() => {
                    props.api.ui.dialog.setSize("large")
                    props.api.ui.dialog.replace(() => <Detail api={props.api} job={job} />)
                  }}
                >
                  {short(job)}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 450,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
