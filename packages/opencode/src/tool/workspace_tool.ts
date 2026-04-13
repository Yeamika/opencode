import z from "zod"
import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Tool } from "./tool"

async function readDir(dir: string) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b))
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
  description:
    "Authoritative control surface for workspace tool installation. Read local/global tool file inventory, or copy/delete one local tool file by absolute source path. The tool copies the source basename into the workspace .opencode/tools directory. After local write/delete, call reload {} before verifying availability.",
  parameters: z.object({
    mode: z.enum(["read", "write", "delete"]).describe("Use read to inspect tool files, write to copy one local tool file into the workspace, or delete to remove one copied local tool file by basename."),
    scope: z.enum(["local", "global"]).default("local").describe("Read supports local or global. Write/delete only support local."),
    filePath: z.string().optional().describe("Absolute source file path. For write, the file is copied into .opencode/tools using its basename. For delete, the same basename is removed from .opencode/tools."),
  }),
  async execute(args, ctx) {
    if ((args.mode === "write" || args.mode === "delete") && args.scope === "global") {
      throw new Error("workspaceTool only allows write/delete for local scope")
    }
    const rootDirectory = String(ctx.directory ?? "")
    if ((args.mode === "write" || args.mode === "delete") && isGlobalContext(rootDirectory)) {
      throw new Error("workspaceTool refuses to modify local tools when the current session is in the global context")
    }
    const root =
      args.scope === "global"
        ? path.join(Global.Path.config, "tools")
        : path.join(rootDirectory, ".opencode", "tools")
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
