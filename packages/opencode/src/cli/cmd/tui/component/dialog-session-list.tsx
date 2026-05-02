import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createEffect, createMemo, createSignal, createResource, onMount } from "solid-js"
import { createStore } from "solid-js/store"
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
  const [meta, setMeta] = createStore<Record<string, { agent: string | null }>>({})
  const pend = new Set<string>()

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
    const msg = [...list].reverse().find((item) => item.info.role === "user")
    const info = msg?.info as { model?: { providerID: string; modelID: string } } | undefined
    return {
      turns: list.length,
      model: info?.model ? `${info.model.providerID}/${info.model.modelID}` : undefined,
    }
  })

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  const sessions = createMemo(() => searchResults() ?? (all() ? recent() : sync.data.session) ?? [])
  const pick = (id?: string) => sessions().find((item) => item.id === id)

  function hdr(dir?: string) {
    const h = new Headers(sdk.headers as HeadersInit | undefined)
    if (dir) h.set("x-opencode-directory", encodeURIComponent(dir))
    return h
  }

  async function agent(id: string, dir: string) {
    const url = new URL(`/session/${id}/message`, sdk.url)
    url.searchParams.set("limit", "8")
    const res = await sdk.fetch(url, { headers: hdr(dir) })
    if (!res.ok) return null
    const list = (await res.json().catch(() => [])) as Array<{ info?: { role?: string; agent?: string } }>
    const msg = [...list].reverse().find((item) => item.info?.role === "user" && item.info?.agent)
    return msg?.info?.agent ?? null
  }

  const list = createMemo(() => {
    return sessions()
      .filter((x) => !x.time.archived)
      .filter((x) => (all() ? true : x.parentID === undefined))
      .toSorted((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
  })

  createEffect(() => {
    dialog.setSize(all() ? "xlarge" : "large")
  })

  createEffect(() => {
    if (!all()) return
    if (hover()) return
    if (currentSessionID()) setHover(currentSessionID())
  })

  createEffect(() => {
    const items = sessions()
    for (const item of items) {
      if (meta[item.id]) continue
      if (pend.has(item.id)) continue
      pend.add(item.id)
      void agent(item.id, item.directory)
        .then((value) => {
          setMeta(item.id, { agent: value })
        })
        .catch(() => {
          setMeta(item.id, { agent: null })
        })
        .finally(() => {
          pend.delete(item.id)
        })
    }
  })

  const toggle = () => {
    setAll((x) => !x)
    setToDelete(undefined)
    setHover(undefined)
  }

  const options = createMemo(() => {
    const today = new Date().toDateString()
    return list().map((x) => {
      const updated = x.time.updated ?? x.time.created
      const date = new Date(updated)
      let category = date.toDateString()
      if (category === today) {
        category = "Today"
      }
      const isDeleting = toDelete() === x.id
      const isWorking = sync.data.session_status?.[x.id]?.type !== undefined && sync.data.session_status?.[x.id].type !== "idle"
      const dir = all() ? getFilename(x.directory) : undefined
      const dot = x.parentID ? "● " : ""
      const room = Math.max(20, 61 - (dir ? dir.length + 1 : 0))
      const ag = meta[x.id]?.agent
      const desc = all() ? [ag, dir].filter(Boolean).join(" · ") || dir : ag ?? undefined
      return {
        title: isDeleting
          ? `Press ${keybind.print("session_delete")} again to confirm`
          : dot + Locale.truncate(x.title, room),
        bg: isDeleting ? theme.error : undefined,
        value: x.id,
        category,
        description: desc,
        footer: Locale.time(updated),
        gutter: isWorking ? <Spinner /> : undefined,
      }
    })
  })

  onMount(() => {
    dialog.setSize("large")
  })

  const top = createMemo(() => (
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
        <text fg={theme.text}>Agent: {meta[item.id]?.agent ?? "-"}</text>
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
      titleRight={top()}
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
          await sync.bootstrap({ reason: "directory", directory: item.directory })
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
