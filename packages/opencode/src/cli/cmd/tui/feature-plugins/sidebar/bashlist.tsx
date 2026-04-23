import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"

const id = "internal:sidebar-bashlist"

type Job = {
  asyncID: string
  command?: string
  description?: string
  workdir?: string
  scope?: string
  status?: string
  state?: string
  resultPath?: string
  statusPath?: string
  linePointer?: number
  startedAt?: number
  endedAt?: number
  raw?: string
  error?: string
}

function obj(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as Record<string, unknown>
}

function text(input: unknown) {
  if (typeof input !== "string") return
  const next = input.trim()
  if (!next) return
  return next
}

function num(input: unknown) {
  if (typeof input !== "number") return
  return input
}

function put(map: Map<string, Job>, asyncID: string, next: Partial<Job>) {
  const prev = map.get(asyncID) ?? { asyncID }
  map.set(asyncID, {
    ...prev,
    ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
  })
}

function tone(api: TuiPluginApi, job: Job) {
  if (job.state === "running" || job.status === "running") return api.theme.current.info
  if (job.status?.includes("exit 0")) return api.theme.current.success
  if (job.status?.includes("timeout") || job.status?.includes("killed")) return api.theme.current.warning
  return api.theme.current.textMuted
}

function line(job: Job) {
  return job.description ?? job.command ?? job.asyncID
}

function short(job: Job) {
  const next = line(job)
  if (next.length <= 26) return next
  return `${next.slice(0, 25)}…`
}

function stamp(input?: number) {
  if (!input) return
  return new Date(input).toLocaleString()
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
        <text attributes={TextAttributes.BOLD} fg={theme().text}>
          Bash Task
        </text>
        <text fg={theme().textMuted} onMouseUp={close}>
          esc/enter
        </text>
      </box>
      <box flexDirection="column" gap={1} paddingBottom={1}>
        {row("Status", props.job.status ?? props.job.state)}
        {row("AsyncID", props.job.asyncID)}
        {row("Description", props.job.description)}
        {row("Command", props.job.command)}
        {row("Workdir", props.job.workdir)}
        {row("Scope", props.job.scope)}
        {row("Result Path", props.job.resultPath)}
        {row("Status Path", props.job.statusPath)}
        {row("Line Pointer", props.job.linePointer)}
        {row("Started", stamp(props.job.startedAt))}
        {row("Ended", stamp(props.job.endedAt))}
        <Show when={props.job.error}>
          <box flexDirection="column">
            <text fg={theme().textMuted}>Error</text>
            <text fg={theme().error}>{props.job.error}</text>
          </box>
        </Show>
        <Show when={props.job.raw}>
          <box flexDirection="column">
            <text fg={theme().textMuted}>Latest Record</text>
            <text fg={theme().text}>{props.job.raw}</text>
          </box>
        </Show>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme().primary} onMouseUp={close}>
          <text fg={theme().selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}

function jobs(api: TuiPluginApi, sessionID: string) {
  const map = new Map<string, Job>()
  for (const msg of api.state.session.messages(sessionID)) {
    const list = api.state.part(msg.id).filter((part): part is ToolPart => part.type === "tool" && part.tool === "exbash")
    for (const part of list) {
      const input = obj(part.state.input)
      const mode = text(input?.mode)
      const meta = part.state.status === "pending" ? undefined : obj(part.state.metadata)

      if (mode === "exec-async") {
        const args = obj(input?.async)
        const asyncID = text(meta?.asyncID)
        if (!asyncID) continue
        put(map, asyncID, {
          command: text(args?.command),
          description: text(args?.description),
          workdir: text(args?.workdir),
          scope: text(args?.scope),
          status: text(meta?.status) ?? (part.state.status === "running" ? "running" : undefined),
          state: part.state.status,
          resultPath: text(meta?.resultPath),
          statusPath: text(meta?.statusPath),
          linePointer: num(meta?.linePointer),
          startedAt: num(meta?.startedAt),
          endedAt: num(meta?.endedAt),
          raw: part.state.status === "completed" ? part.state.output : undefined,
          error: part.state.status === "error" ? part.state.error : undefined,
        })
        continue
      }

      if (mode === "list") {
        const runs = Array.isArray(meta?.runs) ? meta.runs : []
        for (const item of runs) {
          const run = obj(item)
          const asyncID = text(run?.asyncID)
          if (!asyncID) continue
          put(map, asyncID, {
            status: text(run?.status),
            state: text(run?.state),
            resultPath: text(run?.resultPath),
            statusPath: text(run?.statusPath),
            linePointer: num(run?.linePointer),
            startedAt: num(run?.startedAt),
            endedAt: num(run?.endedAt),
            error: text(run?.error),
            raw: part.state.status === "completed" ? part.state.output : undefined,
          })
        }
        continue
      }

      if (mode === "control") {
        const asyncID = text(meta?.asyncID)
        if (!asyncID) continue
        if (meta?.removed === true) {
          map.delete(asyncID)
          continue
        }
        put(map, asyncID, {
          status: text(meta?.status),
          state: text(meta?.state),
          resultPath: text(meta?.resultPath),
          statusPath: text(meta?.statusPath),
          linePointer: num(meta?.linePointer),
          startedAt: num(meta?.startedAt),
          endedAt: num(meta?.endedAt),
          raw: part.state.status === "completed" ? part.state.output : undefined,
          error: part.state.status === "error" ? part.state.error : undefined,
        })
        continue
      }

      if (mode === "input") {
        const args = obj(input?.input)
        const asyncID = text(args?.asyncID)
        if (!asyncID) continue
        put(map, asyncID, {
          raw: part.state.status === "completed" ? part.state.output : undefined,
          error: part.state.status === "error" ? part.state.error : undefined,
        })
      }
    }
  }

  return [...map.values()].sort((a, b) => {
    const x = a.state === "running" || a.status === "running" ? 0 : 1
    const y = b.state === "running" || b.status === "running" ? 0 : 1
    if (x !== y) return x - y
    return (b.startedAt ?? 0) - (a.startedAt ?? 0)
  })
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => jobs(props.api, props.session_id))

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
              <box
                flexDirection="row"
                gap={1}
                justifyContent="space-between"
                onMouseUp={() => {
                  props.api.ui.dialog.setSize("large")
                  props.api.ui.dialog.replace(() => <Detail api={props.api} job={job} />)
                }}
              >
                <text fg={theme().textMuted} wrapMode="none">
                  {short(job)}
                </text>
                <text fg={tone(props.api, job)} flexShrink={0}>
                  {job.status ?? job.state ?? "unknown"}
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
