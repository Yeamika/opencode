import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createEffect, createMemo, createSignal, onMount } from "solid-js"
import { useSDK } from "../context/sdk"

export function DialogChangeDirectory() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const [list, setList] = createSignal<string[]>([])
  const [stats, setStats] = createSignal<Record<string, number | null | undefined>>({})
  const [query, setQuery] = createSignal("")

  const open = (value: string) => {
    const dir = value.trim().replace(/\/+$/g, "") || "/"
    dialog.clear()
    sdk.setDirectory(dir)
    route.navigate({ type: "home" })
    void sync.bootstrap({ reason: "directory", directory: dir })
  }

  onMount(() => {
    const url = new URL("/experimental/instance", sdk.url)
    void sdk
      .fetch(url, {
        headers: sdk.headers,
      })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (!Array.isArray(data)) return
        setList(data.filter((item): item is string => typeof item === "string" && item.trim().length > 0))
      })
      .catch(() => {})
  })

  let run = 0
  createEffect(() => {
    const dirs = list()
    const next = ++run
    if (!dirs.length) {
      setStats({})
      return
    }
    setStats(Object.fromEntries(dirs.map((dir) => [dir, undefined])))
    void Promise.all(
      dirs.map(async (dir) => {
        const [listed, status] = await Promise.all([
          sdk.client.session.list({ directory: dir, roots: true }).catch(() => undefined),
          sdk.client.session.status({ directory: dir }).catch(() => undefined),
        ])
        if (!listed?.data) return [dir, null] as const
        if (!status?.data) return [dir, null] as const
        const ids = new Set(listed.data.map((session) => session.id))
        return [dir, Object.entries(status.data).filter(([id, item]) => ids.has(id) && item.type !== "idle").length] as const
      }),
    ).then((entries) => {
      if (run !== next) return
      setStats(Object.fromEntries(entries))
    })
  })

  const options = createMemo(() => {
    const result = list().map((item) => ({
      title: item,
      value: item,
      category: "Loaded",
      footer:
        stats()[item] === undefined
          ? "Loading loops..."
          : stats()[item] === null
            ? "Loops unavailable"
            : `${stats()[item]} Looping`,
    }))
    const value = query().trim().replace(/\/+$/g, "")
    if (!value) return result
    if (result.some((item) => item.value === value)) return result
    return [
      {
        title: value,
        value,
        category: "Path",
        description: "Open this directory",
      },
      ...result,
    ]
  })

  return (
    <DialogSelect
      title="Change Directory"
      placeholder="/path/to/project"
      options={options()}
      current={sync.data.path.directory || sdk.directory || "/"}
      onFilter={setQuery}
      onSelect={(option) => open(option.value)}
    />
  )
}
