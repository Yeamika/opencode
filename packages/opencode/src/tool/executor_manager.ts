import z from "zod"
import path from "node:path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Tool } from "./tool"
import { RemoteExecutor } from "./remote_executor"

const Mode = z.enum(["add", "reload", "reconnect", "remove", "list", "save"])

function global(dir: string) {
  const root = path.resolve(dir || Instance.directory)
  return [Global.Path.home, Global.Path.config, path.join(Global.Path.home, ".opencode")]
    .map((item) => path.resolve(item))
    .includes(root)
}

function change(mode: z.infer<typeof Mode>) {
  return mode === "add" || mode === "remove" || mode === "save"
}

function guard(scope: RemoteExecutor.Scope, mode: z.infer<typeof Mode>, dir: string) {
  if (!change(mode)) return
  if (scope !== "user") return
  if (global(dir)) return
  throw new Error("executorManager can modify user scope only from a user-level session")
}

function info(args: { id?: string; url?: string; system?: string; device?: string; labels?: Record<string, string> }) {
  if (!args.id) throw new Error("id is required for add")
  if (!args.url) throw new Error("url is required for add")
  return RemoteExecutor.Info.parse({
    id: args.id,
    url: args.url,
    ...(args.system === undefined ? {} : { system: args.system }),
    ...(args.device === undefined ? {} : { device: args.device }),
    ...(args.labels === undefined ? {} : { labels: args.labels }),
  })
}

async function output(
  mode: z.infer<typeof Mode>,
  scope: RemoteExecutor.Scope,
  dir: string,
  rec?: Record<string, unknown>,
) {
  const list = await RemoteExecutor.list(dir)
  const result = { mode, scope, ...list, ...(rec === undefined ? {} : { rec }) }
  return {
    title: "Executor list",
    metadata: result,
    output: JSON.stringify(result, null, 2),
  }
}

export const ExecutorManagerTool = Tool.define("executorManager", {
  description: [
    "Manage RemoteExecutor executor links for the current workspace.",
    "Configuration is stored in .opencode/remote_executor_infos.json for workspace scope and in the user's ~/.opencode/remote_executor_infos.json for user scope.",
    "mode=list shows built-in local, user-scope, and workspace-scope executors visible to this workspace, including current bridge/connected status.",
    "mode=add/remove/save modifies one scope and returns the visible executor list. User scope can only be modified from a user-level session.",
    "mode=reload restarts the private REC bridge and reconnects configured executors.",
    "mode=reconnect keeps the private REC bridge and force-connects one configured executor by id. id is required. Connection failures are returned as tool errors.",
    "local is the fixed default executor and cannot be added, removed, saved, or changed.",
  ].join("\n"),
  parameters: z.object({
    mode: Mode.describe("Operation mode: add, reload, reconnect, remove, list, or save."),
    scope: RemoteExecutor.Scope.optional().describe(
      "Scope to modify for add/remove/save. Defaults to workspace. list and reload always show both workspace and user executors.",
    ),
    id: z
      .string()
      .optional()
      .describe("Executor id. Required for add, remove, and reconnect. 'local' is reserved for add/remove/save."),
    url: z.string().optional().describe("WebSocket URL. Required for add, for example ws://host:9001."),
    system: z.string().optional().describe("Optional system label for add."),
    device: z.string().optional().describe("Optional device label for add."),
    labels: z.record(z.string(), z.string()).optional().describe("Optional string labels for add."),
    executors: z
      .array(RemoteExecutor.Info)
      .optional()
      .describe("Use for save: complete executor list for the selected scope. Must not include local."),
  }),
  async execute(args, ctx) {
    const dir = String(ctx.directory ?? Instance.directory)
    const scope = args.scope ?? "workspace"
    await ctx.ask({
      permission: "executorManager",
      patterns: [
        args.mode === "list" || args.mode === "reload" ? args.mode : `${scope} ${args.mode} ${args.id ?? "*"}`,
      ],
      always: ["*"],
      metadata: {
        mode: args.mode,
        scope,
        id: args.id,
      },
    })
    guard(scope, args.mode, dir)

    if (args.mode === "list") return output(args.mode, scope, dir)
    if (args.mode === "reload") {
      const rec = await RemoteExecutor.reload(dir)
      return output(args.mode, scope, dir, rec.metadata)
    }
    if (args.mode === "reconnect") {
      if (!args.id) throw new Error("id is required for reconnect")
      const rec = await RemoteExecutor.reconnect(dir, args.id)
      return output(args.mode, scope, dir, rec.metadata)
    }
    if (args.mode === "add") {
      await RemoteExecutor.upsert(scope, info(args), dir)
      return output(args.mode, scope, dir)
    }
    if (args.mode === "remove") {
      if (!args.id) throw new Error("id is required for remove")
      await RemoteExecutor.remove(scope, args.id, dir)
      return output(args.mode, scope, dir)
    }
    if (!args.executors) throw new Error("executors is required for save")
    await RemoteExecutor.save(scope, { executors: args.executors }, dir)
    return output(args.mode, scope, dir)
  },
})
