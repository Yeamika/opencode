import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { For, Match, Switch, Show, createMemo, createSignal, onMount } from "solid-js"

export type DialogStatusProps = {}

type Checks = {
  global: Record<string, boolean>
  local: Record<string, "yes" | "no" | "follow">
}

function Check(props: { value?: "yes" | "no" | "follow" | boolean; wait?: boolean }) {
  const { theme } = useTheme()
  if (props.wait) {
    return <text fg={theme.textMuted}>…</text>
  }
  if (props.value === true || props.value === "yes") {
    return <text fg={theme.success} attributes={TextAttributes.BOLD}>✓ yes</text>
  }
  if (props.value === false || props.value === "no") {
    return <text fg={theme.error}>× no</text>
  }
  if (props.value === "follow") {
    return <text fg={theme.textMuted}>↳ follow</text>
  }
  return <text fg={theme.textMuted}>…</text>
}

export function DialogStatus() {
  const sync = useSync()
  const sdk = useSDK()
  const { theme } = useTheme()
  const dialog = useDialog()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)
  const [wait, setWait] = createSignal<string>()
  const [checks, setChecks] = createSignal<Checks>({ global: {}, local: {} })

  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))
  const plugins = createMemo(() => sync.data.plugin)

  async function loadChecks() {
    const url = new URL("/config/mcp/checks", sdk.url)
    if (sdk.directory) url.searchParams.set("directory", sdk.directory)
    if (sdk.workspaceID) url.searchParams.set("workspace", sdk.workspaceID)
    const response = await sdk.fetch(url, {
      headers: sdk.headers,
    })
    if (!response.ok) throw new Error(`mcp checks failed (${response.status})`)
    setChecks(await response.json())
  }

  async function reload() {
    if (busy()) return
    setBusy(true)
    try {
      const [mcp, lsp, formatter, plugins] = await Promise.all([
        sdk.client.mcp.status(),
        sdk.client.lsp.status(),
        sdk.client.formatter.status(),
        sdk.client.config.plugins(),
        loadChecks(),
      ])
      if (mcp.data) sync.set("mcp", mcp.data)
      if (lsp.data) sync.set("lsp", lsp.data)
      if (formatter.data) sync.set("formatter", formatter.data)
      sync.set("plugin", plugins.data ?? [])
    } finally {
      setBusy(false)
    }
  }

  function value(name: string) {
    const item = checks()
    const local = item.local[name] ?? "follow"
    if (local === "yes") return true
    if (local === "no") return false
    return item.global[name] ?? false
  }

  function next(scope: "global" | "local", name: string) {
    const item = checks()
    if (scope === "global") return item.global[name] ? "no" : "yes"
    const current = item.local[name] ?? "follow"
    if (current === "follow") return "yes"
    if (current === "yes") return "no"
    return "follow"
  }

  async function set(scope: "global" | "local", name: string) {
    if (busy() || wait()) return
    const step = next(scope, name)
    setWait(`${scope}:${name}`)
    try {
      const url = new URL("/config/mcp/checks", sdk.url)
      if (sdk.directory) url.searchParams.set("directory", sdk.directory)
      if (sdk.workspaceID) url.searchParams.set("workspace", sdk.workspaceID)
      const response = await sdk.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(sdk.headers ?? {}),
        },
        body: JSON.stringify({ scope, name, value: step }),
      })
      if (!response.ok) throw new Error(`mcp check update failed (${response.status})`)
      const data = await response.json() as Checks
      setChecks(data)
      if (data.local[name] === "yes" || (data.local[name] === "follow" && data.global[name])) {
        await sdk.client.mcp.connect({ name })
      } else {
        await sdk.client.mcp.disconnect({ name })
      }
      const mcp = await sdk.client.mcp.status()
      if (mcp.data) sync.set("mcp", mcp.data)
    } catch (error) {
      toast.error(error)
    } finally {
      setWait(undefined)
    }
  }

  onMount(() => {
    void loadChecks().catch(() => {})
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Status
        </text>
        <box flexDirection="row" gap={2}>
          <text fg={busy() ? theme.textMuted : theme.primary} onMouseUp={() => void reload()}>
            {busy() ? "reloading" : "reload"}
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
      </box>
      <Show when={Object.keys(sync.data.mcp).length > 0} fallback={<text fg={theme.text}>No MCP Servers</text>}>
        <box>
          <text fg={theme.text}>{Object.keys(sync.data.mcp).length} MCP Servers</text>
          <For each={Object.entries(sync.data.mcp)}>
            {([key, item]) => (
              <box gap={1} flexDirection="column">
                <box flexDirection="row" gap={1}>
                  <text
                    flexShrink={0}
                    style={{
                      fg: (
                        {
                          connected: theme.success,
                          failed: theme.error,
                          disabled: theme.textMuted,
                          needs_auth: theme.warning,
                          needs_client_registration: theme.error,
                        } as Record<string, typeof theme.success>
                      )[item.status],
                    }}
                  >
                    •
                  </text>
                  <text fg={theme.text} wrapMode="word">
                    <b>{key}</b>{" "}
                    <span style={{ fg: theme.textMuted }}>
                      <Switch fallback={item.status}>
                        <Match when={item.status === "connected"}>Connected</Match>
                        <Match when={item.status === "failed" && item}>{(val) => val().error}</Match>
                        <Match when={item.status === "disabled"}>Disabled in configuration</Match>
                        <Match when={(item.status as string) === "needs_auth"}>
                          Needs authentication (run: opencode mcp auth {key})
                        </Match>
                        <Match when={(item.status as string) === "needs_client_registration" && item}>
                          {(val) => (val() as { error: string }).error}
                        </Match>
                      </Switch>
                    </span>
                  </text>
                </box>
                <box flexDirection="row" gap={2} paddingLeft={2}>
                  <box flexDirection="row" gap={1} onMouseUp={() => void set("global", key)}>
                    <text fg={theme.textMuted}>global</text>
                    <Check value={checks().global[key]} wait={wait() === `global:${key}`} />
                  </box>
                  <box flexDirection="row" gap={1} onMouseUp={() => void set("local", key)}>
                    <text fg={theme.textMuted}>local</text>
                    <Check value={checks().local[key]} wait={wait() === `local:${key}`} />
                  </box>
                  <text fg={value(key) ? theme.success : theme.textMuted}>{value(key) ? "effective on" : "effective off"}</text>
                </box>
              </box>
            )}
          </For>
        </box>
      </Show>
      {sync.data.lsp.length > 0 && (
        <box>
          <text fg={theme.text}>{sync.data.lsp.length} LSP Servers</text>
          <For each={sync.data.lsp}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: {
                      connected: theme.success,
                      error: theme.error,
                    }[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{item.id}</b> <span style={{ fg: theme.textMuted }}>{item.root}</span>
                </text>
              </box>
            )}
          </For>
        </box>
      )}
      <Show when={enabledFormatters().length > 0} fallback={<text fg={theme.text}>No Formatters</text>}>
        <box>
          <text fg={theme.text}>{enabledFormatters().length} Formatters</text>
          <For each={enabledFormatters()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={plugins().length > 0} fallback={<text fg={theme.text}>No Plugins</text>}>
        <box>
          <text fg={theme.text}>{plugins().length} Plugins</text>
          <For each={plugins()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                  {item.version && <span style={{ fg: theme.textMuted }}> @{item.version}</span>}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
