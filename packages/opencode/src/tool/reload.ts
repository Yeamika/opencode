import z from "zod"
import { Instance } from "@/project/instance"
import { Reload } from "@/project/reload"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"

type Snapshot = {
  tool: string[]
  server: string[]
  mcp: string[]
  skill: string[]
}

function sort(list: string[]) {
  return Array.from(new Set(list)).sort((a, b) => a.localeCompare(b))
}

function diff(prev: string[], next: string[]) {
  const seen = new Set(prev)
  return next.filter((item) => !seen.has(item))
}

function count(label: string, prev: number, next: number) {
  if (prev === next) return `- ${label}: ${next} (no change)`
  const delta = next - prev
  return `- ${label}: ${prev} -> ${next} (${delta > 0 ? `+${delta}` : delta})`
}

function fmt(label: string, list: string[]) {
  if (list.length === 0) return []
  return [`- ${label}: ${list.join(", ")}`]
}

function text(prev: Snapshot, next: Snapshot, agent: string) {
  const added = {
    tool: diff(prev.tool, next.tool),
    server: diff(prev.server, next.server),
    mcp: diff(prev.mcp, next.mcp),
    skill: diff(prev.skill, next.skill),
  }
  const removed = {
    tool: diff(next.tool, prev.tool),
    server: diff(next.server, prev.server),
    mcp: diff(next.mcp, prev.mcp),
    skill: diff(next.skill, prev.skill),
  }
  return [
    "Workspace reload completed.",
    "",
    "Workspace inventory:",
    count("Workspace tools", prev.tool.length, next.tool.length),
    count("MCP servers", prev.server.length, next.server.length),
    count("MCP tools", prev.mcp.length, next.mcp.length),
    count("Skills", prev.skill.length, next.skill.length),
    ...(added.server.length > 0 || removed.server.length > 0 || added.skill.length > 0 || removed.skill.length > 0
      ? [
          "",
          "Changes:",
          ...fmt("MCP added", added.server),
          ...fmt("MCP removed", removed.server),
          ...fmt("Skills added", added.skill),
          ...fmt("Skills removed", removed.skill),
        ]
      : []),
    "",
    "Note:",
    "- These counts describe the workspace-wide loaded inventory, not per-session visibility.",
    "- Tool visibility in the current session still depends on session context.",
    `- Current agent: ${agent}`,
    "- If something is not visible, report the current agent name.",
  ].join("\n")
}

async function snapshot() {
  const [tool, status, mcp, skill] = await Promise.all([
    ToolRegistry.ids(),
    MCP.status(),
    MCP.tools(),
    Skill.all(),
  ])
  const mcpStatus = status as Record<string, { status: string }>
  return {
    tool: sort(tool),
    server: sort(
      Object.entries(mcpStatus)
        .filter(([, item]) => item.status === "connected")
        .map(([key]) => key),
    ),
    mcp: sort(Object.keys(mcp)),
    skill: sort(skill.map((item) => item.name)),
  } satisfies Snapshot
}

export const ReloadTool = Tool.define("reload", {
  description: "Reload the current workspace instance so the agent continues with refreshed project state and system context.",
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "reload",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const prev = await snapshot()
    const targetDirectory = ctx.directory ?? Instance.directory
    const promise = Reload.request(targetDirectory)
    Reload.arrive(targetDirectory, ctx.sessionID)
    await promise
    const next = await snapshot()

    return {
      title: "Workspace reloaded",
      output: text(prev, next, ctx.agent),
      metadata: {
        directory: targetDirectory,
      },
    }
  },
})
