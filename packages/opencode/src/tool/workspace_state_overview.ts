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

async function listNames(dir: string, kind: "file" | "directory") {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => (kind === "file" ? entry.isFile() : entry.isDirectory()))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export const WorkspaceOverviewTool = Tool.define("workspaceOverview", {
  description: "List current workspace MCP config entries, custom tool files, and skill folders.",
  parameters: z.object({}),
  async execute(_args, ctx) {
    const directory = String(ctx.extra?.directory ?? "")
    const configFile = path.join(directory, "opencode.json")
    const config = await safeReadJson(configFile)
    const mcp = Object.keys(config.mcp ?? {}).sort((a, b) => a.localeCompare(b))
    const tools = await listNames(path.join(directory, ".opencode", "tools"), "file")
    const skills = await listNames(path.join(directory, ".opencode", "skills"), "directory")
    const output = { directory, configFile, mcp, tools, skills }
    return {
      title: "Workspace overview",
      output: JSON.stringify(output, null, 2),
      metadata: output,
    }
  },
})
