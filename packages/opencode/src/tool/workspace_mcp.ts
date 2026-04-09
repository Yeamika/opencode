import z from "zod"
import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
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

function isGlobalContext(directory: string) {
  try {
    if (Instance.project.id === "global") return true
  } catch {}
  return directory === Global.Path.home || directory === Global.Path.config
}

export const WorkspaceMcpTool = Tool.define("workspaceMcp", {
  description: "Read workspace/global MCP config, or write/delete local workspace MCP entries only.",
  parameters: z.object({
    mode: z.enum(["read", "write", "delete"]),
    scope: z.enum(["local", "global"]).default("local"),
    name: z.string().optional(),
    value: z.record(z.string(), z.any()).optional(),
  }),
  async execute(args, ctx) {
    const directory = String(ctx.directory ?? "")
    if ((args.mode === "write" || args.mode === "delete") && args.scope === "global") {
      throw new Error("workspaceMcp only allows write/delete for local scope")
    }
    if ((args.mode === "write" || args.mode === "delete") && isGlobalContext(directory)) {
      throw new Error("workspaceMcp refuses to modify local config when the current session is in the global context")
    }

    const file =
      args.scope === "global"
        ? path.join(Global.Path.config, "opencode.json")
        : path.join(directory, ".opencode", "opencode.json")
    const json = await safeReadJson(file)
    json.mcp ||= {}
    if (args.mode === "read") {
      const output = { scope: args.scope, file, mcp: json.mcp }
      return { title: "Workspace MCP updated", output: JSON.stringify(output, null, 2), metadata: output }
    }
    if (args.mode === "write") {
      if (!args.name) throw new Error("name is required for write")
      if (!args.value) throw new Error("value is required for write")
      json.mcp[args.name] = args.value
    }
    if (args.mode === "delete") {
      if (!args.name) throw new Error("name is required for delete")
      delete json.mcp[args.name]
    }
    await writeJson(file, json)
    const output = { scope: args.scope, file, mcp: json.mcp }
    return { title: "Workspace MCP updated", output: JSON.stringify(output, null, 2), metadata: output }
  },
})
