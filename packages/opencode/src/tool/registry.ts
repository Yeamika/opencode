import { PlanExitTool } from "./plan"
import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { BatchTool } from "./batch"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Config } from "../config/config"
import path from "path"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { Truncate } from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { ReloadTool } from "./reload"
import { WorkspaceMcpTool } from "./workspace_mcp"
import { WorkspaceToolTool } from "./workspace_tool"
import { WorkspaceSkillTool } from "./workspace_skill"
import { WorkspaceOverviewTool } from "./workspace_state_overview"
import { Glob } from "../util/glob"
import { pathToFileURL } from "url"
import { Effect, Layer, ServiceMap } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Env } from "../env"
import { Question } from "../question"
import { getRefsTools } from "./refs-tools"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  type State = {
    custom: Tool.Info[]
  }

  export interface Interface {
    readonly ids: () => Effect.Effect<string[]>
    readonly named: {
      task: Tool.Info
      read: Tool.Info
    }
    readonly tools: (
      model: { providerID: ProviderID; modelID: ModelID },
      agent?: Agent.Info,
    ) => Effect.Effect<(Tool.Def & { id: string })[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/ToolRegistry") {}

  export const layer: Layer.Layer<Service, never, Config.Service | Plugin.Service | Question.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const plugin = yield* Plugin.Service

      const build = <T extends Tool.Info>(tool: T | Effect.Effect<T, never, any>) =>
        Effect.isEffect(tool) ? tool : Effect.succeed(tool)

      const state = yield* InstanceState.make<State>(
        Effect.fn("ToolRegistry.state")(function* (ctx) {
          const custom: Tool.Info[] = []

          function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
            return {
              id,
              init: async (initCtx) => ({
                parameters: z.object(def.args),
                description: def.description,
                execute: async (args, toolCtx) => {
                  const pluginCtx = {
                    ...toolCtx,
                    directory: ctx.directory,
                    worktree: ctx.worktree,
                  } as unknown as PluginToolContext
                  const result = await def.execute(args as any, pluginCtx)
                  const out = await Truncate.output(result, {}, initCtx?.agent)
                  return {
                    title: "",
                    output: out.truncated ? out.content : result,
                    metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
                  }
                },
              }),
            }
          }

          const dirs = yield* config.directories()
          const matches = dirs.flatMap((dir) =>
            Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
          )
          if (matches.length) yield* config.waitForDependencies()
          for (const match of matches) {
            const namespace = path.basename(match, path.extname(match))
            const mod = yield* Effect.promise(
              () => import(process.platform === "win32" ? match : pathToFileURL(match).href),
            )
            for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
              custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
            }
          }

          const plugins = yield* plugin.list()
          for (const p of plugins) {
            for (const [id, def] of Object.entries(p.tool ?? {})) {
              custom.push(fromPlugin(id, def))
            }
          }

          return { custom }
        }),
      )

      const invalid = yield* build(InvalidTool)
      const ask = yield* build(QuestionTool)
      const bash = yield* build(BashTool)
      const reload = yield* build(ReloadTool)
      const workspaceMcp = yield* build(WorkspaceMcpTool)
      const workspaceTool = yield* build(WorkspaceToolTool)
      const workspaceSkill = yield* build(WorkspaceSkillTool)
      const workspaceOverview = yield* build(WorkspaceOverviewTool)
      const glob = yield* build(GlobTool)
      const edit = yield* build(EditTool)
      const write = yield* build(WriteTool)
      const task = yield* build(TaskTool)
      const fetch = yield* build(WebFetchTool)
      const todo = yield* build(TodoWriteTool)
      const search = yield* build(WebSearchTool)
      const code = yield* build(CodeSearchTool)
      const skill = yield* build(SkillTool)
      const patch = yield* build(ApplyPatchTool)
      const lsp = yield* build(LspTool)
      const batch = yield* build(BatchTool)
      const plan = yield* build(PlanExitTool)

      // REFS-backed tools: read from MCP tools/list dynamically
      // Replaces hand-written ReadTool, RgTool, ExBashTool, ExecutorManagerTool
      const refsTools = getRefsTools()
      const refsMap = new Map(refsTools.map((t) => [t.id, t]))
      const read = refsMap.get("read")!

      const all = Effect.fn("ToolRegistry.all")(function* (custom: Tool.Info[]) {
        const cfg = yield* config.get()

        return [
          invalid,
          ask,
          bash,
          ...refsTools, // FileAction, read, rg, exbash, executorManager
          reload,
          workspaceOverview,
          workspaceMcp,
          workspaceTool,
          workspaceSkill,
          glob,
          edit,
          write,
          task,
          fetch,
          todo,
          search,
          code,
          skill,
          patch,
          ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [lsp] : []),
          ...(cfg.experimental?.batch_tool === true ? [batch] : []),
          ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [plan] : []),
          ...custom,
        ]
      })

      const ids = Effect.fn("ToolRegistry.ids")(function* () {
        const s = yield* InstanceState.get(state)
        const tools = yield* all(s.custom)
        return tools.map((t) => t.id)
      })

      const tools = Effect.fn("ToolRegistry.tools")(function* (
        model: { providerID: ProviderID; modelID: ModelID },
        agent?: Agent.Info,
      ) {
        const s = yield* InstanceState.get(state)
        const allTools = yield* all(s.custom)
        const filtered = allTools.filter((tool) => {
          if (tool.id === "bash") return false

          if (tool.id === "codesearch" || tool.id === "websearch") {
            return model.providerID === ProviderID.opencode || Flag.OPENCODE_ENABLE_EXA
          }

          const usePatch =
            !!Env.get("OPENCODE_E2E_LLM_URL") ||
            (model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4"))
          if (tool.id === "apply_patch") return usePatch
          if (tool.id === "edit" || tool.id === "write") return !usePatch

          return true
        })
        return yield* Effect.forEach(
          filtered,
          Effect.fnUntraced(function* (tool: Tool.Info) {
            using _ = log.time(tool.id)
            const next = yield* Effect.promise(() => tool.init({ agent }))
            const output = {
              description: next.description,
              parameters: next.parameters,
            }
            yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
            return {
              id: tool.id,
              description: output.description,
              parameters: output.parameters,
              execute: next.execute,
              formatValidationError: next.formatValidationError,
            }
          }),
          { concurrency: "unbounded" },
        )
      })

      return Service.of({ ids, named: { task, read }, tools })
    }),
  )

  export const defaultLayer = Layer.unwrap(
    Effect.sync(() =>
      layer.pipe(
        Layer.provide(Config.defaultLayer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(Question.defaultLayer),
      ),
    ),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function ids() {
    return runPromise((svc) => svc.ids())
  }

  export async function tools(
    model: {
      providerID: ProviderID
      modelID: ModelID
    },
    agent?: Agent.Info,
  ): Promise<(Tool.Def & { id: string })[]> {
    return runPromise((svc) => svc.tools(model, agent))
  }
}
