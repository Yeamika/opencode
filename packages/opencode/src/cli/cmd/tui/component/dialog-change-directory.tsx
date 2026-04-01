import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createMemo, createSignal, onMount } from "solid-js"
import { useSDK } from "../context/sdk"

export function DialogChangeDirectory() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const [list, setList] = createSignal<string[]>([])
  const [query, setQuery] = createSignal("")

  const open = (value: string) => {
    const dir = value.trim().replace(/\/+$/g, "") || "/"
    dialog.clear()
    sdk.setDirectory(dir)
    route.navigate({ type: "home" })
    void sync.bootstrap()
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

  const options = createMemo(() => {
    const result = list().map((item) => ({
      title: item,
      value: item,
      category: "Loaded",
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
