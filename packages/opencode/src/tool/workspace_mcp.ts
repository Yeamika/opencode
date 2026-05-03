import z from "zod"
import path from "node:path"
import fs from "node:fs/promises"
import { Config } from "@/config/config"
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
    "Authoritative control surface for workspace MCP.",
  parameters: z.object({
    mode: z.enum(["read", "write", "delete"]).describe("Read current entries, write one local entry, or delete one local entry."),
    scope: z.enum(["local", "global"]).default("local").describe("Read supports local or global. Write/delete only support local."),
    name: z.string().optional().describe("Entry name. Required for write and delete."),
    value: z
      .string()
      .optional()
      .describe(
        "JSON object string for one entry value. Example: {\"type\":\"remote\",\"url\":\"http://host.docker.internal:8811/mcp\"}.",
      ),
  }),
  async execute(args, ctx) {
    const directory = String(ctx.directory ?? "")
    await ctx.ask({
      permission: "workspaceMcp",
      patterns: [args.mode === "read" ? `${args.scope} read` : `${args.scope} ${args.mode} ${args.name ?? "*"}`],
      always: ["*"],
      metadata: {
        mode: args.mode,
        scope: args.scope,
        name: args.name,
      },
    })
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
      const value = JSON.parse(args.value)
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("value must be a JSON object string")
      }
      const parsed = Config.Mcp.safeParse(value)
      if (!parsed.success) {
        const msg = parsed.error.issues.map((item) => item.message).join("; ") || "Invalid MCP configuration"
        throw new Error(`Invalid MCP configuration: ${msg}`)
      }
      json.mcp[args.name] = parsed.data
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
