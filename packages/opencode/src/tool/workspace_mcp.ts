import z from "zod"
import path from "node:path"
import fs from "node:fs/promises"
import { Tool } from "./tool"

async function safeReadJson(file: string) {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"))
  } catch {
    return {}
  }
}

async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data, null, 2))
}

export const WorkspaceMcpTool = Tool.define("workspaceMcp", {
  description: "Write or delete workspace MCP config entries in opencode.json.",
  parameters: z.object({
    mode: z.enum(["write", "delete"]),
    name: z.string(),
    value: z.record(z.string(), z.any()).optional(),
  }),
  async execute(args, ctx) {
    const directory = String(ctx.extra?.directory ?? "")
    const file = path.join(directory, "opencode.json")
    const json = await safeReadJson(file)
    json.mcp ||= {}
    if (args.mode === "write") {
      if (!args.value) throw new Error("value is required for write")
      json.mcp[args.name] = args.value
    }
    if (args.mode === "delete") {
      delete json.mcp[args.name]
    }
    await writeJson(file, json)
    const output = { file, mcp: json.mcp }
    return { title: "Workspace MCP updated", output: JSON.stringify(output, null, 2), metadata: output }
  },
})
