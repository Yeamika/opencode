import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { For, Match, Switch, Show, createMemo, createSignal } from "solid-js"

export type DialogStatusProps = {}

export function DialogStatus() {
  const sync = useSync()
  const sdk = useSDK()
  const { theme } = useTheme()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))
  const plugins = createMemo(() => sync.data.plugin)

  async function reload() {
    if (busy()) return
    setBusy(true)
    try {
      const [mcp, lsp, formatter, plugins] = await Promise.all([
        sdk.client.mcp.status(),
        sdk.client.lsp.status(),
        sdk.client.formatter.status(),
        sdk.client.config.plugins(),
      ])
      if (mcp.data) sync.set("mcp", mcp.data)
      if (lsp.data) sync.set("lsp", lsp.data)
      if (formatter.data) sync.set("formatter", formatter.data)
      sync.set("plugin", plugins.data ?? [])
    } finally {
      setBusy(false)
    }
  }
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
