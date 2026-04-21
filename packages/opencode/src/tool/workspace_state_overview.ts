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
  description:
    "Authoritative control surface for workspace overview.",
  parameters: z.object({
    scope: z.enum(["local", "global"]).default("local").describe("Which workspace scope to inspect."),
  }),
  async execute(args, ctx) {
    const directory = String(ctx.directory ?? "")
    const base = args.scope === "global" ? Global.Path.config : path.join(directory, ".opencode")
    const configFile = path.join(base, "opencode.json")
    const config = await safeReadJson(configFile)
    const mcp = Object.keys(config.mcp ?? {}).sort((a, b) => a.localeCompare(b))
    const toolsDir = path.join(base, "tools")
    const skillsDir = path.join(base, "skills")
    const tools = await listNames(toolsDir, "file")
    const skills = await listNames(skillsDir, "directory")
    const output = { scope: args.scope, directory, configFile, toolsDir, skillsDir, mcp, tools, skills }
    return {
      title: "Workspace overview",
      output: JSON.stringify(output, null, 2),
      metadata: output,
    }
  },
})
