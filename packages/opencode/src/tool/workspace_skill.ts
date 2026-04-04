import z from "zod"
import path from "node:path"
import fs from "node:fs/promises"
import { Tool } from "./tool"

async function readDir(dir: string) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export const WorkspaceSkillTool = Tool.define("workspaceSkill", {
  description: "Write or delete skills inside workspace .opencode/skills.",
  parameters: z.object({
    mode: z.enum(["write", "delete"]),
    name: z.string(),
    content: z.string().optional(),
  }),
  async execute(args, ctx) {
    const directory = String(ctx.directory ?? "")
    const root = path.join(directory, ".opencode", "skills")
    if (args.mode === "write") {
      if (args.content === undefined) throw new Error("content is required for write")
      const dir = path.join(root, args.name)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "SKILL.md"), args.content)
    }
    if (args.mode === "delete") {
      await fs.rm(path.join(root, args.name), { recursive: true, force: true })
    }
    const output = { root, skills: await readDir(root) }
    return { title: "Workspace skill files updated", output: JSON.stringify(output, null, 2), metadata: output }
  },
})
