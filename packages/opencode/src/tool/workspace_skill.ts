import z from "zod"
import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Tool } from "./tool"

async function readDir(dir: string) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b))
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

export const WorkspaceSkillTool = Tool.define("workspaceSkill", {
  description: "Read workspace/global skill folders, or write/delete local workspace skill folders using an absolute source directory path.",
  parameters: z.object({
    mode: z.enum(["read", "write", "delete"]),
    scope: z.enum(["local", "global"]).default("local"),
    directoryPath: z.string().optional(),
  }),
  async execute(args, ctx) {
    if ((args.mode === "write" || args.mode === "delete") && args.scope === "global") {
      throw new Error("workspaceSkill only allows write/delete for local scope")
    }
    const rootDirectory = String(ctx.directory ?? "")
    if ((args.mode === "write" || args.mode === "delete") && isGlobalContext(rootDirectory)) {
      throw new Error("workspaceSkill refuses to modify local skills when the current session is in the global context")
    }
    const root =
      args.scope === "global"
        ? path.join(Global.Path.config, "skills")
        : path.join(rootDirectory, ".opencode", "skills")
    const sourcePath = args.directoryPath ? path.resolve(args.directoryPath) : undefined

    if ((args.mode === "write" || args.mode === "delete") && !sourcePath) {
      throw new Error("directoryPath is required for write/delete")
    }

    if (sourcePath && !path.isAbsolute(sourcePath)) {
      throw new Error("directoryPath must be absolute")
    }

    if (args.mode === "write") {
      const stat = await fs.stat(sourcePath!)
      if (!stat.isDirectory()) throw new Error("directoryPath must point to a directory")
      await fs.mkdir(root, { recursive: true })
      await fs.cp(sourcePath!, path.join(root, path.basename(sourcePath!)), {
        recursive: true,
        force: true,
      })
    }
    if (args.mode === "delete") {
      await fs.rm(path.join(root, path.basename(sourcePath!)), { recursive: true, force: true })
    }
    const output = { scope: args.scope, rootDirectory, root, skills: await readDir(root) }
    return { title: "Workspace skill files updated", output: JSON.stringify(output, null, 2), metadata: output }
  },
})
