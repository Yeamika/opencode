import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createEffect, createMemo, createSignal, createResource, onMount } from "solid-js"
import { Locale } from "@/util/locale"
import { useKeybind } from "../context/keybind"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { DialogSessionRename } from "./dialog-session-rename"
import { useKV } from "../context/kv"
import { createDebouncedSignal } from "../util/signal"
import { Spinner } from "./spinner"
import { getFilename } from "@opencode-ai/util/path"
import { TextAttributes } from "@opentui/core"

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const keybind = useKeybind()
  const { theme } = useTheme()
  const sdk = useSDK()
  const kv = useKV()

  const [toDelete, setToDelete] = createSignal<string>()
  const [search, setSearch] = createDebouncedSignal("", 150)
  const [all, setAll] = kv.signal("session_list_all_recent", false)
  const [hover, setHover] = createSignal<string>()

  async function globalList(input?: { search?: string; limit?: number }) {
    const url = new URL("/experimental/session", sdk.url)
    if (input?.search) url.searchParams.set("search", input.search)
    url.searchParams.set("limit", String(input?.limit ?? 100))
    const res = await sdk.fetch(url, { headers: sdk.headers })
    if (!res.ok) return []
    const json = await res.json().catch(() => [])
    return Array.isArray(json) ? json : []
  }

  const [searchResults] = createResource(search, async (query) => {
    if (!query) return undefined
    if (all()) return globalList({ search: query, limit: 100 })
    const result = await sdk.client.session.list({ search: query, limit: 30 })
    return result.data ?? []
  })

  const [recent] = createResource(all, async (value) => {
    if (!value) return undefined
    return globalList({ limit: 100 })
  })

  const [extra] = createResource(hover, async (id) => {
    if (!id) return undefined
    const result = await sdk.client.session.messages({ sessionID: id })
    const list = result.data ?? []
    const msg = [...list].reverse().find((item) => item.info.role === "user" && item.info.model)
    return {
      turns: list.length,
      model: msg ? `${msg.info.model.providerID}/${msg.info.model.modelID}` : undefined,
    }
  })

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  const sessions = createMemo(() => searchResults() ?? (all() ? recent() : sync.data.session) ?? [])
  const pick = (id?: string) => sessions().find((item) => item.id === id)

  createEffect(() => {
    dialog.setSize(all() ? "xlarge" : "large")
  })

  createEffect(() => {
    if (!all()) return
    if (hover()) return
    if (currentSessionID()) setHover(currentSessionID())
  })

  const toggle = () => {
    setAll((x) => !x)
    setToDelete(undefined)
    setHover(undefined)
  }

  const options = createMemo(() => {
    const today = new Date().toDateString()
    return sessions()
      .filter((x) => !x.time.archived)
      .filter((x) => (all() ? true : x.parentID === undefined))
      .toSorted((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .map((x) => {
        const updated = x.time.updated ?? x.time.created
        const date = new Date(updated)
        let category = date.toDateString()
        if (category === today) {
          category = "Today"
        }
        const isDeleting = toDelete() === x.id
        const status = sync.data.session_status?.[x.id]
        const isWorking = status?.type === "busy"
        return {
          title: isDeleting ? `Press ${keybind.print("session_delete")} again to confirm` : x.title,
          bg: isDeleting ? theme.error : undefined,
          value: x.id,
          category,
          description: all() ? getFilename(x.directory) : undefined,
          footer: Locale.time(updated),
          gutter: isWorking ? <Spinner /> : undefined,
        }
      })
  })

  onMount(() => {
    dialog.setSize("large")
  })

  const head = createMemo(() => (
    <box
      flexDirection="row"
      gap={1}
      onMouseUp={toggle}
    >
      <text fg={theme.text}>{all() ? "☑" : "☐"}</text>
      <text fg={theme.textMuted}>All recent</text>
    </box>
  ))

  const detail = (option?: { value: string }) => {
    const item = pick(option?.value)
    if (!item) return <text fg={theme.textMuted}>Select a session</text>
    const updated = item.time.updated ?? item.time.created
    return (
      <box flexDirection="column" gap={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>Dir: {getFilename(item.directory)}</text>
        <text fg={theme.text}>UpdatedAt: {Locale.time(updated)}</text>
        <text fg={theme.text}>Model: {extra()?.model ?? "-"}</text>
        <text fg={theme.text}>Turns: {extra()?.turns ?? "-"}</text>
        <text fg={theme.textMuted} wrapMode="word">{item.directory}</text>
      </box>
    )
  }

  return (
    <DialogSelect
      title="Sessions"
      titleRight={head()}
      options={options()}
      skipFilter={true}
      current={currentSessionID()}
      onFilter={setSearch}
      detail={all() ? detail : undefined}
      detailWidth={34}
      onMove={(option) => {
        setToDelete(undefined)
        setHover(option.value)
      }}
      onSelect={async (option) => {
        const item = pick(option.value)
        dialog.clear()
        if (item?.directory && item.directory !== sdk.directory) {
          sdk.setDirectory(item.directory)
          await sync.bootstrap()
        }
        route.navigate({
          type: "session",
          sessionID: option.value,
        })
      }}
      keybind={[
        {
          keybind: keybind.all.session_delete?.[0],
          title: "delete",
          onTrigger: async (option) => {
            if (toDelete() === option.value) {
              sdk.client.session.delete({
                sessionID: option.value,
              })
              setToDelete(undefined)
              return
            }
            setToDelete(option.value)
          },
        },
        {
          keybind: keybind.all.session_rename?.[0],
          title: "rename",
          onTrigger: async (option) => {
            dialog.replace(() => <DialogSessionRename session={option.value} />)
          },
        },
      ]}
    />
  )
}
