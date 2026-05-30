import z from "zod"
import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Tool } from "./tool"

async function readDir(dir: string) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function isGlobalContext(directory: string) {
  try {
    if (Instance.project.id === "global") return true
  } catch {}
  return directory === Global.Path.home || directory === Global.Path.config
}

export const WorkspaceToolTool = Tool.define("workspaceTool", {
  description: "Authoritative control surface for workspace tools.",
  parameters: z.object({
    mode: z
      .enum(["read", "write", "delete"])
      .describe("Read current tool files, write one local tool file, or delete one local tool file."),
    scope: z
      .enum(["local", "global"])
      .default("local")
      .describe("Read supports local or global. Write/delete only support local."),
    filePath: z.string().optional().describe("Absolute source file path. Required for write and delete."),
  }),
  async execute(args, ctx) {
    await ctx.ask({
      permission: "workspaceTool",
      patterns: [args.mode === "read" ? `${args.scope} read` : `${args.scope} ${args.mode} ${args.filePath ?? "*"}`],
      always: ["*"],
      metadata: {
        mode: args.mode,
        scope: args.scope,
        filePath: args.filePath,
      },
    })
    if ((args.mode === "write" || args.mode === "delete") && args.scope === "global") {
      throw new Error("workspaceTool only allows write/delete for local scope")
    }
    const rootDirectory = String(ctx.directory ?? "")
    if ((args.mode === "write" || args.mode === "delete") && isGlobalContext(rootDirectory)) {
      throw new Error("workspaceTool refuses to modify local tools when the current session is in the global context")
    }
    const root =
      args.scope === "global" ? path.join(Global.Path.config, "tools") : path.join(rootDirectory, ".opencode", "tools")
    const sourcePath = args.filePath ? path.resolve(args.filePath) : undefined

    if ((args.mode === "write" || args.mode === "delete") && !sourcePath) {
      throw new Error("filePath is required for write/delete")
    }

    if (sourcePath && !path.isAbsolute(sourcePath)) {
      throw new Error("filePath must be absolute")
    }

    if (args.mode === "write") {
      const stat = await fs.stat(sourcePath!)
      if (!stat.isFile()) throw new Error("filePath must point to a file")
      await fs.mkdir(root, { recursive: true })
      await fs.copyFile(sourcePath!, path.join(root, path.basename(sourcePath!)))
    }
    if (args.mode === "delete") {
      await fs.rm(path.join(root, path.basename(sourcePath!)), { force: true })
    }
    const output = { scope: args.scope, rootDirectory, root, files: await readDir(root) }
    return { title: "Workspace tool files updated", output: JSON.stringify(output, null, 2), metadata: output }
  },
})
