import z from "zod"
import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "@/global"
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
  description:
    "Authoritative control surface for workspace MCP entries. Read local/global MCP config, or write/delete one local mcp[name] entry at a time. For write, pass only the JSON object for the single entry value, not the full opencode.json file. After local write/delete, call reload {} before verifying behavior.",
  parameters: z.object({
    mode: z.enum(["read", "write", "delete"]).describe("Use read to inspect config, write to upsert a single local entry, or delete to remove a single local entry by name."),
    scope: z.enum(["local", "global"]).default("local").describe("Read supports local or global. Write/delete only support local."),
    name: z.string().optional().describe("The MCP entry name under mcp[name]. Required for write and delete."),
    value: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        "The JSON object to store at mcp[name] for a single entry. Pass only the entry object, not the full opencode.json file. Example: {\"type\":\"remote\",\"url\":\"http://host.docker.internal:8811/mcp\"}.",
      ),
  }),
  async execute(args, ctx) {
    const directory = String(ctx.directory ?? "")
    if ((args.mode === "write" || args.mode === "delete") && args.scope === "global") {
      throw new Error("workspaceMcp only allows write/delete for local scope")
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
