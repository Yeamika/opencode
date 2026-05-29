import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@opencode-ai/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import { Log } from "@/util/log"
import { MessageV2 } from "@/session/message-v2"
import type { Path } from "@opencode-ai/sdk"
import type { Workspace } from "@opencode-ai/sdk/v2"

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      bootstrap: {
        count: number
        modal?: {
          reason: "directory"
          directory?: string
        }
      }
      reload: {
        [directory: string]: {
          directory: string
          status: "idle" | "pending" | "running"
          totalSessions: number
          readySessions: number
          waitingSessions: number
        }
      }
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      plugin: {
        name: string
        version?: string
        specifier: string
      }[]
      skill: {
        name: string
        description: string
        location: string
        content: string
      }[]
      tool: string[]
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      exbash: {
        [sessionID: string]: {
          asyncID: string
          scope: "local" | "workspace"
          executor: string
          description: string
          command: string
          cwd: string
          pid?: number
          totalOutput?: number
          startedAt: number
          endedAt?: number
          exitCode?: number | "stopped" | "timeout"
          state: "running" | "stopped" | "unknown"
          memory?: boolean
          error?: string
        }[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
      path: Path
      workspaceList: Workspace[]
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      provider_auth: {},
      plugin: [],
      skill: [],
      tool: [],
      config: {},
      status: "loading",
      bootstrap: {
        count: 0,
      },
      reload: {},
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      exbash: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
      path: { state: "", config: "", worktree: "", directory: "" },
      workspaceList: [],
    })

    const sdk = useSDK()
    const fullSyncedSessions = new Set<string>()

    async function syncWorkspaces() {
      const result = await sdk.client.experimental.workspace.list().catch(() => undefined)
      if (!result?.data) return
      setStore("workspaceList", reconcile(result.data))
    }

    async function syncExbash(sessionID: string) {
      const url = new URL(`/session/${sessionID}/exbash`, sdk.url)
      const response = await sdk.fetch(url, { headers: sdk.headers })
      if (!response.ok) return []
      const data = await response.json()
      setStore("exbash", sessionID, reconcile(data ?? []))
      return data
    }

    async function syncMessages(sessionID: string) {
      const url = new URL(`/session/${sessionID}/message`, sdk.url)
      url.searchParams.set("limit", "100")
      url.searchParams.set("preview", "true")
      const response = await sdk.fetch(url, { headers: sdk.headers })
      if (!response.ok) throw new Error(`session messages failed (${response.status})`)
      return MessageV2.WithParts.array().parse(await response.json())
    }

    async function syncSession(sessionID: string, options?: { force?: boolean }) {
      if (!options?.force && fullSyncedSessions.has(sessionID)) return

      const [session, messages, todo, diff, exbash] = await Promise.all([
        sdk.client.session.get({ sessionID }, { throwOnError: true }),
        syncMessages(sessionID),
        sdk.client.session.todo({ sessionID }),
        sdk.client.session.diff({ sessionID }),
        syncExbash(sessionID),
      ])

      setStore(
        produce((draft) => {
          const match = Binary.search(draft.session, sessionID, (s) => s.id)
          if (match.found) draft.session[match.index] = session.data!
          if (!match.found) draft.session.splice(match.index, 0, session.data!)
          draft.todo[sessionID] = todo.data ?? []
          draft.exbash[sessionID] = exbash ?? []
          draft.message[sessionID] = messages.map((x) => x.info)
          for (const message of messages) {
            draft.part[message.info.id] = message.parts
          }
          draft.session_diff[sessionID] = diff.data ?? []
        }),
      )

      fullSyncedSessions.add(sessionID)
    }

    async function resyncLoadedSessions() {
      const sessionIDs = Array.from(fullSyncedSessions)
      if (sessionIDs.length === 0) return

      await Promise.all(
        sessionIDs.map((sessionID) =>
          syncSession(sessionID, { force: true }).catch((error) => {
            Log.Default.warn("tui session resync failed", {
              sessionID,
              error: error instanceof Error ? error.message : String(error),
            })
          }),
        ),
      )
    }

    sdk.event.listen((e) => {
      const event = e.details
      switch (event.type) {
        case "server.instance.disposed":
          void resyncLoadedSessions()
          break
        case "project.reload.updated":
          setStore("reload", event.properties.directory, event.properties)
          if (event.properties.status === "idle") {
            void bootstrap({ fatal: false, mode: "reload" })
            void resyncLoadedSessions()
          }
          break
        case "tui.sse.reconnected":
          void bootstrap({ fatal: false })
          void resyncLoadedSessions()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "exbash.updated": {
          const next = event as { properties: { sessionID: string; workspace: string } }
          const list = store.session.filter(
            (item) => item.id === next.properties.sessionID || item.directory === next.properties.workspace,
          )
          void Promise.all(list.map((item) => syncExbash(item.id).catch(() => undefined)))
          break
        }

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found)
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        case "lsp.updated": {
          sdk.client.lsp.status().then((x) => setStore("lsp", x.data!))
          break
        }

        case "vcs.branch.updated": {
          setStore("vcs", { branch: event.properties.branch })
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(options?: { fatal?: boolean; reason?: "directory"; directory?: string; mode?: "full" | "reload" }) {
      console.log("bootstrapping")
      const modal = options?.reason === "directory" ? { reason: "directory" as const, directory: options.directory } : undefined
      const mode = options?.mode ?? "full"
      const full = mode === "full"
      batch(() => {
        setStore("bootstrap", "count", (x) => x + 1)
        if (modal) setStore("bootstrap", "modal", modal)
      })
      const start = Date.now() - 30 * 24 * 60 * 60 * 1000
      const sessionListPromise = sdk.client.session
        .list({ start: start })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({}, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({}, { throwOnError: true })
      const agentsPromise = sdk.client.app.agents({}, { throwOnError: true })
      const skillsPromise = sdk.client.app.skills({}, { throwOnError: true })
      const toolsPromise = sdk.client.tool.ids({}, { throwOnError: true })
      const configPromise = sdk.client.config.get({}, { throwOnError: true })
      const pluginsPromise = full ? sdk.client.config.plugins({}, { throwOnError: true }) : undefined
      const blockingRequests: Promise<unknown>[] = [
        providersPromise,
        providerListPromise,
        agentsPromise,
        skillsPromise,
        toolsPromise,
        configPromise,
        ...(pluginsPromise ? [pluginsPromise] : []),
        ...(args.continue ? [sessionListPromise] : []),
      ]

      try {
        await Promise.all(blockingRequests)

        const [providers, providerList, agents, skills, tools, config, plugins, sessions] = await Promise.all([
          providersPromise.then((x) => x.data!),
          providerListPromise.then((x) => x.data!),
          agentsPromise.then((x) => x.data ?? []),
          skillsPromise.then((x) => x.data ?? []),
          toolsPromise.then((x) => x.data ?? []),
          configPromise.then((x) => x.data!),
          pluginsPromise ? pluginsPromise.then((x) => x.data ?? []) : Promise.resolve(undefined),
          args.continue ? sessionListPromise : Promise.resolve(undefined),
        ])

        batch(() => {
          setStore("provider", reconcile(providers.providers))
          setStore("provider_default", reconcile(providers.default))
          setStore("provider_next", reconcile(providerList))
          setStore("agent", reconcile(agents))
          setStore("skill", reconcile(skills))
          setStore("tool", reconcile(tools))
          if (plugins) setStore("plugin", reconcile(plugins))
          setStore("config", reconcile(config))
          if (sessions !== undefined) setStore("session", reconcile(sessions))
        })

        if (store.status !== "complete") setStore("status", "partial")

        await Promise.all([
          ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
          sdk.client.command.list().then((x) => setStore("command", reconcile(x.data ?? []))),
          sdk.client.mcp.status().then((x) => setStore("mcp", reconcile(x.data!))),
          sdk.client.experimental.resource.list().then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
          sdk.client.session.status().then((x) => {
            setStore("session_status", reconcile(x.data!))
          }),
          sdk.client.path.get().then((x) => setStore("path", reconcile(x.data!))),
          syncWorkspaces(),
          ...(full
            ? [
                sdk.client.lsp.status().then((x) => setStore("lsp", reconcile(x.data!))),
                sdk.client.formatter.status().then((x) => setStore("formatter", reconcile(x.data!))),
                sdk.client.provider.auth().then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
                sdk.client.vcs.get().then((x) => setStore("vcs", reconcile(x.data))),
              ]
            : []),
        ])

        setStore("status", "complete")
      } catch (e) {
        Log.Default.error("tui bootstrap failed", {
          error: e instanceof Error ? e.message : String(e),
          name: e instanceof Error ? e.name : undefined,
          stack: e instanceof Error ? e.stack : undefined,
        })
        if (options?.fatal !== false) {
          await exit(e)
        }
      } finally {
        batch(() => {
          setStore("bootstrap", "count", (x) => Math.max(0, x - 1))
          if (modal) setStore("bootstrap", "modal", undefined)
        })
      }
    }

    onMount(() => {
      bootstrap()
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        return store.status !== "loading"
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string, options?: { force?: boolean }) {
          await syncSession(sessionID, options)
        },
      },
      workspace: {
        get(workspaceID: string) {
          return store.workspaceList.find((workspace) => workspace.id === workspaceID)
        },
        sync: syncWorkspaces,
      },
      bootstrap,
    }
    return result
  },
})
