import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { Spinner } from "@tui/component/spinner"
import { getScrollAcceleration } from "../../util/scroll"

const id = "internal:sidebar-bashlist"

type Job = ReturnType<TuiPluginApi["state"]["session"]["exbash"]>[number]

function status(job: Job) {
  if (job.state === "running") return "running"
  if (job.state === "unknown") return "unknown"
  return `exitcode: ${job.exitCode ?? -1}`
}

function subtitle(job: Job) {
  return `${job.asyncID} · ${job.cwd} [${job.scope}/${job.executor}]`
}

function time(job: Job) {
  const start = new Date(job.startedAt).toLocaleString()
  const end = job.endedAt ? new Date(job.endedAt).toLocaleString() : "-"
  return `${start} · ${end}`
}

function short(job: Job) {
  const text = job.description || job.command
  if (text.length <= 28) return text
  return `${text.slice(0, 27)}…`
}

function Detail(props: { api: TuiPluginApi; session_id: string; job: Job }) {
  const theme = () => props.api.theme.current
  const term = useTerminalDimensions()
  const [shot, setShot] = createSignal("")
  const [err, setErr] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const close = () => props.api.ui.dialog.clear()
  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") close()
  })
  onMount(() => {
    props.api.state.session
      .exbashSnapshot(props.session_id, props.job.asyncID, props.job.executor)
      .then((next) => setShot(next))
      .catch((error) => setErr(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme().text}>{`${props.job.description}[${status(props.job)}]`}</text>
        <text fg={theme().textMuted} onMouseUp={close}>
          esc/enter
        </text>
      </box>
      <text fg={theme().textMuted}>{subtitle(props.job)}</text>
      <scrollbox
        maxHeight={Math.floor(term().height * 0.45)}
        scrollAcceleration={getScrollAcceleration()}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: theme().background,
            foregroundColor: theme().borderActive,
          },
        }}
      >
        <box flexDirection="column" gap={1} paddingRight={1} paddingBottom={1}>
          <box flexDirection="column">
            <text fg={theme().textMuted}>Command</text>
            <text fg={theme().text}>{props.job.command}</text>
          </box>
          <Show when={props.job.pid}>
            <box flexDirection="column">
              <text fg={theme().textMuted}>pid</text>
              <text fg={theme().text}>{props.job.pid}</text>
            </box>
          </Show>
          <box flexDirection="column">
            <text fg={theme().textMuted}>time</text>
            <text fg={theme().text}>{time(props.job)}</text>
          </box>
          <Show when={props.job.error}>
            <box flexDirection="column">
              <text fg={theme().textMuted}>error</text>
              <text fg={theme().error}>{props.job.error}</text>
            </box>
          </Show>
          <box flexDirection="column">
            <text fg={theme().textMuted}>snapshot</text>
            <Show when={loading()}>
              <text fg={theme().textMuted}>loading snapshot...</text>
            </Show>
            <Show when={!loading() && err()}>
              <text fg={theme().error}>{err()}</text>
            </Show>
            <Show when={!loading() && !err()}>
              <text fg={shot() ? theme().text : theme().textMuted}>{shot() || "(empty)"}</text>
            </Show>
          </box>
        </box>
      </scrollbox>
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
  if (props.job.state === "running") return <Spinner color={theme().info} />
  if (props.job.state === "unknown") return <text fg={theme().warning}>[?]</text>
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
            <text fg={theme().text}>{open() ? "▾" : "▸"}</text>
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
                    props.api.ui.dialog.replace(() => <Detail api={props.api} session_id={props.session_id} job={job} />)
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
