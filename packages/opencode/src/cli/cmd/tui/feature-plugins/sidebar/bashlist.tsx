import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { Spinner } from "@tui/component/spinner"
import { getScrollAcceleration } from "../../util/scroll"
import { DialogRefsPtyt } from "../../ui/dialog-refs-ptyt"

const id = "internal:sidebar-bashlist"

type Job = ReturnType<TuiPluginApi["state"]["session"]["exbash"]>[number]

function status(job: Job) {
  if (job.state === "running") return "running"
  if (job.state === "unknown") return "unknown"
  if (job.state === "timeout") return "timeout"
  if (job.state === "stop") return "stop"
  if (job.state.startsWith("exit:")) return job.state.replace("exit:", "exit ")
  if (job.exitCode === undefined) return "stop"
  return typeof job.exitCode === "number" ? `exit ${job.exitCode}` : job.exitCode === "stopped" ? "stop" : job.exitCode
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

function scope(scope: string) {
  if (scope === "workspace") return "Workspace"
  if (scope === "local") return "Local"
  return scope
}

function sections(jobs: readonly Job[]) {
  const order = ["local", "workspace"]
  const keys = Array.from(new Set([...order, ...jobs.map((job) => job.scope)]))
  return keys
    .map((key) => ({
      scope: key,
      jobs: jobs.filter((job) => job.scope === key),
    }))
    .filter((group) => group.jobs.length > 0)
}

function Detail(props: { api: TuiPluginApi; session_id: string; job: Job }) {
  const theme = () => props.api.theme.current
  const term = useTerminalDimensions()
  const [shot, setShot] = createSignal("")
  const [err, setErr] = createSignal("")
  const [ptyt, setPtyt] = createSignal("")
  const [ptytErr, setPtytErr] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const close = () => props.api.ui.dialog.clear()
  const openPtyt = () => {
    props.api.display
      .openRefsPtyt({ sessionID: props.session_id })
      .then((result) => {
        props.api.ui.dialog.setSize("large")
        props.api.ui.dialog.replace(() => <DialogRefsPtyt command={result.command} error={result.error} />)
        props.api.ui.toast({
          message: result.error ?? "refs-ptyt attach opened",
          variant: result.error ? "error" : "info",
        })
      })
      .catch((error) => {
        props.api.ui.toast({
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        })
      })
  }
  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") close()
  })
  onMount(() => {
    props.api.display
      .refsPtytCommand({ sessionID: props.session_id })
      .then((result) => setPtyt(result.command))
      .catch((error) => setPtytErr(error instanceof Error ? error.message : String(error)))

    if (!props.job.memory || props.job.state === "unknown") {
      setLoading(false)
      return
    }
    props.api.state.session
      .exbashSnapshot(props.session_id, props.job.asyncID, props.job.executor)
      .then((next) => {
        setShot(next.snapshot)
      })
      .catch((error) => setErr(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text
          attributes={TextAttributes.BOLD}
          fg={theme().text}
        >{`${props.job.description}[${status(props.job)}]`}</text>
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
          <box flexDirection="column">
            <text fg={theme().textMuted}>status</text>
            <text fg={theme().text}>{status(props.job)}</text>
          </box>
          <Show when={props.job.exitCode !== undefined}>
            <box flexDirection="column">
              <text fg={theme().textMuted}>exit code</text>
              <text
                fg={
                  props.job.exitCode === 0
                    ? theme().success
                    : props.job.exitCode === "stopped" || props.job.exitCode === "stop"
                      ? theme().warning
                      : theme().error
                }
              >
                {props.job.exitCode}
              </text>
            </box>
          </Show>
          <Show when={props.job.totalOutput !== undefined}>
            <box flexDirection="column">
              <text fg={theme().textMuted}>output bytes</text>
              <text fg={theme().text}>{props.job.totalOutput}</text>
            </box>
          </Show>
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
            <Show when={!props.job.memory}>
              <text fg={theme().textMuted}>unavailable for stored tasks</text>
            </Show>
            <Show when={props.job.memory && loading()}>
              <text fg={theme().textMuted}>loading snapshot...</text>
            </Show>
            <Show when={props.job.memory && !loading() && err()}>
              <text fg={theme().error}>{err()}</text>
            </Show>
            <Show when={props.job.memory && !loading() && !err()}>
              <text fg={shot() ? theme().text : theme().textMuted}>{shot() || "(empty)"}</text>
            </Show>
          </box>
          <box flexDirection="column">
            <text fg={theme().textMuted}>refs-ptyt</text>
            <text fg={ptytErr() ? theme().error : ptyt() ? theme().text : theme().textMuted} wrapMode="word">
              {ptytErr() || ptyt() || "loading command..."}
            </text>
            <box flexDirection="row">
              <box paddingLeft={2} paddingRight={2} backgroundColor={theme().backgroundPanel} onMouseUp={openPtyt}>
                <text fg={theme().text}>attach</text>
              </box>
            </box>
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
  if (props.job.state === "unknown") return <text fg={theme().warning}>?</text>
  if (props.job.state === "timeout" || props.job.exitCode === "timeout") return <text fg={theme().warning}>■</text>
  if (props.job.state === "exit:0" || props.job.exitCode === 0) return <text fg={theme().success}>✓</text>
  if (
    props.job.state === "stop" ||
    props.job.exitCode === undefined ||
    props.job.exitCode === "stopped" ||
    props.job.exitCode === "stop"
  )
    return <text fg={theme().warning}>□</text>
  return <text fg={theme().error}>E</text>
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.exbash(props.session_id))
  const groups = createMemo(() => sections(list()))

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▾" : "▸"}</text>
          </Show>
          <text fg={theme().text}>
            <b>ExBash</b>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={groups()}>
            {(group) => (
              <box flexDirection="column">
                <text fg={theme().textMuted}>─ {scope(group.scope)}</text>
                <For each={group.jobs}>
                  {(job) => (
                    <box flexDirection="row" gap={1}>
                      {icon({ api: props.api, job })}
                      <text
                        fg={theme().textMuted}
                        wrapMode="none"
                        overflow="hidden"
                        onMouseUp={() => {
                          props.api.ui.dialog.setSize("large")
                          props.api.ui.dialog.replace(() => (
                            <Detail api={props.api} session_id={props.session_id} job={job} />
                          ))
                        }}
                      >
                        {short(job)}
                      </text>
                    </box>
                  )}
                </For>
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
