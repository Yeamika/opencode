import { createMemo, createSignal, onMount } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { map, pipe, entries, sortBy } from "remeda"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useTheme } from "../context/theme"
import { Keybind } from "@/util/keybind"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"

type Checks = {
  global: Record<string, boolean>
  local: Record<string, "yes" | "no" | "follow">
}

function rec(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function on(value: unknown) {
  const item = rec(value)
  if (!Object.keys(item).length) return false
  if (typeof item.enabled === "boolean") return item.enabled
  return true
}

function patch(cfg: Record<string, unknown>, name: string, value: "yes" | "no" | "follow", drop = false) {
  const next = { ...cfg }
  const mcp = { ...rec(next.mcp) }
  if (drop) {
    delete mcp[name]
  } else {
    mcp[name] = { ...rec(mcp[name]), enabled: value === "yes" }
  }
  if (Object.keys(mcp).length) next.mcp = mcp
  else delete next.mcp
  return next
}

function Status(props: {
  enabled: boolean
  loading: boolean
  global?: boolean
  local?: "yes" | "no" | "follow"
}) {
  const { theme } = useTheme()
  if (props.loading) {
    return <span style={{ fg: theme.textMuted }}>⋯ Loading</span>
  }
  return (
    <span>
      <span style={{ fg: props.enabled ? theme.success : theme.textMuted, attributes: props.enabled ? TextAttributes.BOLD : undefined }}>
        {props.enabled ? "✓ on" : "○ off"}
      </span>
      <span style={{ fg: theme.textMuted }}> · g </span>
      <span style={{ fg: props.global ? theme.success : theme.error, attributes: props.global ? TextAttributes.BOLD : undefined }}>
        {props.global ? "yes" : "no"}
      </span>
      <span style={{ fg: theme.textMuted }}> · l </span>
      <span
        style={{
          fg: props.local === "follow" ? theme.textMuted : props.local === "yes" ? theme.success : theme.error,
          attributes: props.local === "yes" ? TextAttributes.BOLD : undefined,
        }}
      >
        {props.local ?? "follow"}
      </span>
    </span>
  )
}

export function DialogMcp() {
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)
  const [checks, setChecks] = createSignal<Checks>({ global: {}, local: {} })

  async function load() {
    const [mcp, localCfg, globalCfg] = await Promise.all([
      sdk.client.mcp.status(),
      sdk.client.config.get({ directory: sdk.directory, workspace: sdk.workspaceID }),
      sdk.client.global.config.get(),
    ])
    if (mcp.data) sync.set("mcp", mcp.data)
    if (localCfg.data) sync.set("config", localCfg.data)
    const localMcp = rec(rec(localCfg.data).mcp)
    const globalMcp = rec(rec(globalCfg.data).mcp)
    const names = [...new Set([...Object.keys(sync.data.mcp), ...Object.keys(localMcp), ...Object.keys(globalMcp)])].sort((a, b) => a.localeCompare(b))
    setChecks({
      global: Object.fromEntries(names.map((name) => [name, on(globalMcp[name])])),
      local: Object.fromEntries(names.map((name) => [name, name in localMcp ? (on(localMcp[name]) ? "yes" : "no") : "follow"])),
    })
  }

  function next(scope: "global" | "local", name: string) {
    const item = checks()
    if (scope === "global") return item.global[name] ? "no" : "yes"
    const current = item.local[name] ?? "follow"
    if (current === "follow") return "yes"
    if (current === "yes") return "no"
    return "follow"
  }

  function effective(name: string) {
    const item = checks()
    const local = item.local[name] ?? "follow"
    if (local === "yes") return true
    if (local === "no") return false
    return item.global[name] ?? false
  }

  async function set(scope: "global" | "local", name: string) {
    if (loading()) return
    setLoading(`${scope}:${name}`)
    try {
      const step = next(scope, name)
      if (scope === "global") {
        const current = rec((await sdk.client.global.config.get()).data)
        await sdk.client.global.config.update({ config: patch(current, name, step) })
      } else {
        const current = rec((await sdk.client.config.get({ directory: sdk.directory, workspace: sdk.workspaceID })).data)
        await sdk.client.config.update({
          directory: sdk.directory,
          workspace: sdk.workspaceID,
          config: patch(current, name, step, step === "follow"),
        })
      }
      await load()
      if (effective(name)) await sdk.client.mcp.connect({ name })
      else await sdk.client.mcp.disconnect({ name })
      const mcp = await sdk.client.mcp.status()
      if (mcp.data) sync.set("mcp", mcp.data)
    } catch (error) {
      toast.error(error)
    } finally {
      setLoading(null)
    }
  }

  onMount(() => {
    void load().catch(() => {})
  })

  const options = createMemo(() => {
    // Track sync data and loading state to trigger re-render when they change
    const mcpData = sync.data.mcp
    const loadingMcp = loading()

    return pipe(
      mcpData ?? {},
      entries(),
      sortBy(([name]) => name),
      map(([name, status]) => ({
        value: name,
        title: name,
        description: status.status === "failed" ? "failed" : status.status,
        footer: (
          <Status
            enabled={local.mcp.isEnabled(name)}
            global={checks().global[name]}
            local={checks().local[name]}
            loading={loadingMcp === name || loadingMcp === `global:${name}` || loadingMcp === `local:${name}`}
          />
        ),
        category: undefined,
      })),
    )
  })

  const keybinds = createMemo(() => [
    {
      keybind: Keybind.parse("space")[0],
      title: "toggle runtime",
      onTrigger: async (option: DialogSelectOption<string>) => {
        if (loading() !== null) return
        setLoading(option.value)
        try {
          await local.mcp.toggle(option.value)
          const status = await sdk.client.mcp.status()
          if (status.data) sync.set("mcp", status.data)
        } catch (error) {
          toast.error(error)
        } finally {
          setLoading(null)
        }
      },
    },
    {
      keybind: Keybind.parse("g")[0],
      title: "toggle global",
      onTrigger: (option: DialogSelectOption<string>) => void set("global", option.value),
    },
    {
      keybind: Keybind.parse("l")[0],
      title: "cycle local",
      onTrigger: (option: DialogSelectOption<string>) => void set("local", option.value),
    },
    {
      keybind: Keybind.parse("r")[0],
      title: "reload",
      onTrigger: () => void load().catch(toast.error),
    },
  ])

  return (
    <DialogSelect
      ref={setRef}
      title="MCPs"
      titleRight={<text fg={theme.textMuted}>space runtime · g global · l local · r reload</text>}
      options={options()}
      keybind={keybinds()}
      onSelect={(option) => {
        // Don't close on select, only on escape
      }}
    />
  )
}
