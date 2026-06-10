import z from "zod"
import { Instance } from "@/project/instance"
import { Skill } from "@/skill"
import { callToolAsync } from "./refs-bridge"
import { Tool } from "./tool"

const parameters = z.object({
  mode: z.enum(["list", "read"]).default("list").describe("list discovers skills; read loads one full skill."),
  name: z.string().optional().describe("Regex filter over skill names. Required for read."),
  path: z
    .string()
    .optional()
    .describe("Skill root folder or SKILL.md file. Use executor:/path for remote executors. Omit for local skills."),
})

type Params = z.infer<typeof parameters>
type Metadata = {
  mode: "list" | "read"
  path?: string
  name?: string
  dir?: string
  skills?: Array<{ name: string; description: string; path: string }>
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function output(list: Skill.Info[]) {
  if (list.length === 0) return "No skills found."
  return list
    .map((skill) => [`name: ${skill.name}`, `description: ${skill.description}`, `path: ${skill.location}`].join("\n"))
    .join("\n\n")
}

function parse(json: string): string {
  const result = JSON.parse(json)
  if (result.error) throw new Error(result.error.message || "REFS skill call failed")
  return result.result?.content?.[0]?.text ?? ""
}

function local(path?: string) {
  return !path || path === "local"
}

async function refs(args: { mode: "list" | "read"; name?: string; path: string }, ctx: Tool.Context) {
  return parse(
    await callToolAsync({
      sessionID: ctx.sessionID,
      workdir: ctx.directory ?? Instance.directory,
      tool: "skill",
      argsJson: JSON.stringify({ ExecutorSessionID: ctx.sessionID, ...args }),
    }),
  )
}

export const SkillTool = Tool.define<typeof parameters, Metadata>("skill", async (init) => {
  return {
    description: [
      "Discover or load specialized skills that provide domain-specific instructions and workflows.",
      'Use mode "list" to inspect available skill names, descriptions, and paths.',
      'Use mode "read" with a name regex to load one skill\'s full instructions and bundled file summary.',
      "Omit path for local skills. Use path like executor:/path/to/skills for remote executor skills.",
    ].join("\n"),
    parameters,
    async execute(params: Params, ctx) {
      const mode = params.mode ?? "list"
      if (!local(params.path)) {
        if (mode === "read" && !params.name) throw new Error("skill mode=read requires name regex")
        if (mode === "read") {
          await ctx.ask({
            permission: "skill",
            patterns: [params.name!],
            always: [params.name!],
            metadata: { path: params.path },
          })
        }
        return {
          title: mode === "read" ? `Loaded skill: ${params.name}` : "Skills",
          output: await refs({ mode, name: params.name, path: params.path! }, ctx),
          metadata: { mode, path: params.path },
        }
      }

      const skills = await Skill.available(init?.agent)
      const regex = params.name ? new RegExp(params.name) : undefined
      const filtered = regex ? skills.filter((skill) => regex.test(skill.name)) : skills
      if (mode === "list") {
        return {
          title: "Skills",
          output: output(filtered),
          metadata: {
            mode,
            skills: filtered.map((skill) => ({
              name: skill.name,
              description: skill.description,
              path: skill.location,
            })),
          },
        }
      }

      if (!params.name) throw new Error("skill mode=read requires name regex")
      const [skill] = filtered
      if (!skill) {
        throw new Error(`Skill not found. Available skills: ${skills.map((item) => item.name).join(", ") || "none"}`)
      }
      if (filtered.length > 1) {
        throw new Error(`Skill name regex matched multiple skills: ${filtered.map((item) => item.name).join(", ")}`)
      }

      await ctx.ask({
        permission: "skill",
        patterns: [skill.name],
        always: [skill.name],
        metadata: {},
      })

      return {
        title: `Loaded skill: ${skill.name}`,
        output: await refs({ mode: "read", name: `^${escape(skill.name)}$`, path: skill.location }, ctx),
        metadata: {
          mode,
          name: skill.name,
          dir: skill.location.replace(/[\\/][^\\/]*$/, ""),
        },
      }
    },
  }
})
