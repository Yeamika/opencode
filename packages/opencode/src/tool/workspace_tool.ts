import z from "zod"
import path from "node:path"
import fs from "node:fs/promises"
import { Tool } from "./tool"

async function readDir(dir: string) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export const WorkspaceToolTool = Tool.define("workspaceTool", {
  description: "Write or delete files inside workspace .opencode/tools.",
  parameters: z.object({
    mode: z.enum(["write", "delete"]),
    name: z.string(),
    content: z.string().optional(),
  }),
  async execute(args, ctx) {
    const directory = String(ctx.extra?.directory ?? "")
    const root = path.join(directory, ".opencode", "tools")
    if (args.mode === "write") {
      if (args.content === undefined) throw new Error("content is required for write")
      await fs.mkdir(root, { recursive: true })
      await fs.writeFile(path.join(root, args.name), args.content)
    }
    if (args.mode === "delete") {
      await fs.rm(path.join(root, args.name), { force: true })
    }
    const output = { root, files: await readDir(root) }
    return { title: "Workspace tool files updated", output: JSON.stringify(output, null, 2), metadata: output }
  },
})
