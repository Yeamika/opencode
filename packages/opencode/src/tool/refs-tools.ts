/**
 * refs-tools.ts: Dynamic tool registration from MCP tools/list.
 *
 * Reads tool definitions from the REFS-opencode MCP handle and creates
 * OpenCode Tool.Info objects. No hand-written schemas - everything comes
 * from the Rust SDK's mcptooldefs.rs via tools/list.
 *
 * Exports type-compatible stubs for code that needs Tool.InferParameters<T>.
 */

import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { callToolAsync, getHandle } from "./refs-bridge"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { Instruction } from "../session/instruction"
import { ExBashTask } from "../session/exbash"
import { assertExternalDirectory } from "./external-directory"
import { Truncate } from "./truncate"

// ─── Local types (avoid importing from native addon) ───

interface ToolDefinition {
  name: string
  description: string | null
  inputSchema: Record<string, unknown>
}

const HIDDEN_MCP_PARAMS = new Set(["ExecutorSessionID", "includeStructuredContent"])
const EXBASH_MAX_OUTPUT_BYTES = 5 * 1024
const EXBASH_DEFAULT_TITLE = "running command"

function withJsonSchemaMetadata(schema: Record<string, any>, value: z.ZodTypeAny): z.ZodTypeAny {
  let next = value
  if (typeof schema.description === "string" && schema.description.length > 0) {
    next = next.describe(schema.description)
  }
  if (Object.prototype.hasOwnProperty.call(schema, "default")) {
    next = next.default(schema.default)
  }
  return next
}

function zodUnion(values: z.ZodTypeAny[]): z.ZodTypeAny {
  if (values.length === 0) return z.any()
  if (values.length === 1) return values[0]!
  return z.union(values as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
}

function jsonLiteralToZod(value: unknown): z.ZodTypeAny {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return z.literal(value)
  }
  return z.any()
}

export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return z.any()
  const s = schema as Record<string, any>

  if (Object.prototype.hasOwnProperty.call(s, "const")) {
    return withJsonSchemaMetadata(s, jsonLiteralToZod(s.const))
  }

  if (Array.isArray(s.enum) && s.enum.length > 0) {
    if (s.enum.every((value: unknown) => typeof value === "string")) {
      return withJsonSchemaMetadata(s, z.enum(s.enum as [string, ...string[]]))
    }
    return withJsonSchemaMetadata(s, zodUnion(s.enum.map(jsonLiteralToZod)))
  }

  const unionSchemas = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined
  if (unionSchemas) {
    return withJsonSchemaMetadata(s, zodUnion(unionSchemas.map(jsonSchemaToZod)))
  }

  const types = Array.isArray(s.type)
    ? s.type.filter((value: unknown): value is string => typeof value === "string")
    : typeof s.type === "string"
      ? [s.type]
      : []

  if (types.length > 1) {
    return withJsonSchemaMetadata(
      s,
      zodUnion(types.map((type) => (type === "null" ? z.null() : jsonSchemaToZod({ ...s, type })))),
    )
  }

  const type = types[0]
  if (type === "object" || s.properties) {
    const properties =
      s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)
        ? (s.properties as Record<string, unknown>)
        : {}
    const required = new Set(Array.isArray(s.required) ? s.required.filter((item) => typeof item === "string") : [])
    const shape: Record<string, z.ZodTypeAny> = {}

    for (const [key, value] of Object.entries(properties)) {
      const property = jsonSchemaToZod(value)
      shape[key] = required.has(key) ? property : property.optional()
    }

    if (
      Object.keys(shape).length === 0 &&
      s.additionalProperties &&
      typeof s.additionalProperties === "object" &&
      !Array.isArray(s.additionalProperties)
    ) {
      return withJsonSchemaMetadata(s, z.record(z.string(), jsonSchemaToZod(s.additionalProperties)))
    }

    const objectSchema = z.object(shape)
    if (
      s.additionalProperties &&
      typeof s.additionalProperties === "object" &&
      !Array.isArray(s.additionalProperties)
    ) {
      return withJsonSchemaMetadata(s, objectSchema.catchall(jsonSchemaToZod(s.additionalProperties)))
    }

    return withJsonSchemaMetadata(s, objectSchema.passthrough())
  }

  if (type === "array") return withJsonSchemaMetadata(s, z.array(jsonSchemaToZod(s.items)))
  if (type === "integer") return withJsonSchemaMetadata(s, z.number().int())
  if (type === "number") return withJsonSchemaMetadata(s, z.number())
  if (type === "boolean") return withJsonSchemaMetadata(s, z.boolean())
  if (type === "string") return withJsonSchemaMetadata(s, z.string())
  if (type === "null") return withJsonSchemaMetadata(s, z.null())
  return withJsonSchemaMetadata(s, z.any())
}

function modelInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(schema) as Record<string, any>
  const properties = next.properties
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const key of HIDDEN_MCP_PARAMS) delete properties[key]
  }
  if (Array.isArray(next.required)) {
    next.required = next.required.filter((item: unknown) => typeof item !== "string" || !HIDDEN_MCP_PARAMS.has(item))
  }
  return next
}

async function callRefsTool(def: ToolDefinition, args: unknown, ctx: Tool.Context) {
  const values =
    args && typeof args === "object" && !Array.isArray(args)
      ? { ExecutorSessionID: ctx.sessionID, ...(args as Record<string, unknown>) }
      : { ExecutorSessionID: ctx.sessionID }
  values.ExecutorSessionID = ctx.sessionID
  const workdir = ctx.directory ?? Instance.directory
  return callToolAsync({
    sessionID: ctx.sessionID,
    workdir,
    tool: def.name,
    argsJson: JSON.stringify(values),
  })
}

type RefsToolStubParams = ReturnType<typeof z.any>

function refsToolStub(sdkName: string): Tool.Info<RefsToolStubParams> {
  return {
    id: sdkName,
    init: async (ctx) => {
      const info = getRefsTool(sdkName)
      if (!info) throw new Error(`REFS tool not available: ${sdkName}`)
      return (await info.init(ctx)) as Tool.Def<RefsToolStubParams, Record<string, any>>
    },
  }
}

/** Compatibility exports for code that refers to core REFS tools by name. */
export const ReadTool = refsToolStub("read")
export const FileActionTool = refsToolStub("FileAction")
export const RgTool = refsToolStub("rg")
export const ExBashTool = refsToolStub("exbash")
export const ExecutorManagerTool = refsToolStub("RemoteExecutorManager")

// ─── Dynamic tool creation ───

function extractOutput(parsed: {
  error?: { code: number; message: string }
  result?: { content: Array<{ type: string; text: string }> }
}): { title: string; metadata: Record<string, any>; output: string } {
  if (parsed.error) throw new Error(parsed.error.message || "SDK call failed")
  const result = parsed.result
  if (!result) throw new Error("SDK returned no result")

  return { title: "tool", metadata: {}, output: result.content?.[0]?.text ?? "" }
}

function exbashTitle(args: unknown) {
  const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  const mode = typeof input.mode === "string" ? input.mode : "shell"
  const description = typeof input.description === "string" ? input.description.trim() : ""
  if (description) return description
  if (mode === "shell" || mode === "run") return EXBASH_DEFAULT_TITLE
  const asyncID = typeof input.asyncID === "string" ? input.asyncID.trim() : ""
  if ((mode === "stop" || mode === "remove" || mode === "attach") && asyncID) return `${mode} ${asyncID}`
  return `exbash ${mode}`
}

function mcpToolToInfo(def: ToolDefinition): Tool.Info {
  const toolId = def.name
  const parameters = jsonSchemaToZod(modelInputSchema(def.inputSchema))

  return {
    id: toolId,
    init: async (initCtx) => ({
      description: def.description ?? "",
      parameters,
      execute: async (args, ctx) => {
        await ctx.ask({
          permission: toolId as any,
          patterns: [`${toolId}`],
          always: ["*"],
          metadata: { tool: toolId },
        })
        const workspace = ctx.directory ?? Instance.directory
        const json = await callRefsTool(def, args, ctx)
        const output = extractOutput(JSON.parse(json))
        if (toolId === "exbash") {
          await ExBashTask.refresh({ sessionID: ctx.sessionID, workspace })
          const truncated = await Truncate.output(
            output.output,
            { maxBytes: EXBASH_MAX_OUTPUT_BYTES, maxLines: Number.POSITIVE_INFINITY },
            initCtx?.agent,
          )
          return {
            ...output,
            title: exbashTitle(args),
            output: truncated.content,
            metadata: {
              ...output.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }
        return output
      },
    }),
  }
}

function createReadTool(def: ToolDefinition): Tool.Info {
  const parameters = jsonSchemaToZod(modelInputSchema(def.inputSchema))

  return {
    id: "read",
    init: async () => ({
      description: def.description ?? "",
      parameters,
      execute: async (args, ctx) => {
        const a = args as Record<string, any>
        const target = a.filePath ?? a.fileKey ?? ""
        const executor = a.executor ?? "local"
        const local = executor === "local"
        const isHashRef = /\s+#[0-9a-fA-F]{4}$/.test(target)

        const resolvedPath =
          local && !isHashRef ? (path.isAbsolute(target) ? target : path.resolve(Instance.directory, target)) : target

        if (local && !isHashRef) {
          await assertExternalDirectory(ctx, resolvedPath, {
            bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
            kind: Filesystem.stat(resolvedPath)?.isDirectory() ? "directory" : "file",
          })
          await ctx.ask({ permission: "read", patterns: [resolvedPath], always: ["*"], metadata: {} })
        }

        if (local && !isHashRef) {
          const stat = Filesystem.stat(resolvedPath)
          if (stat && !stat.isDirectory()) {
            const mime = Filesystem.mimeType(resolvedPath)
            const image = mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
            const pdf = mime === "application/pdf"
            if (image || pdf) {
              if (pdf) throw new Error("PDF read is not supported yet")
              const msg = "Image read successfully"
              const instructions = await Instruction.resolve(ctx.messages, resolvedPath, ctx.messageID)
              return {
                title: path.relative(Instance.worktree, resolvedPath),
                output: msg,
                metadata: { preview: msg, truncated: false, loaded: instructions.map((i) => i.filepath) },
                attachments: [
                  {
                    type: "file" as const,
                    mime,
                    url: `data:${mime};base64,${Buffer.from(await Filesystem.readBytes(resolvedPath)).toString("base64")}`,
                  },
                ],
              }
            }
          }
        }

        const json = await callRefsTool(def, args, ctx)
        return extractOutput(JSON.parse(json))
      },
    }),
  }
}

// ─── Public API ───

/**
 * Get all REFS-backed tools by reading tools/list from the MCP.
 * Requires RefsBridge to be initialized first.
 */
export function getRefsTools(): Tool.Info[] {
  const handle = getHandle()
  const json = handle.listTools()
  const parsed = JSON.parse(json)
  const defs: ToolDefinition[] = parsed?.result?.tools ?? []
  return defs.map((def) => (def.name === "read" ? createReadTool(def) : mcpToolToInfo(def)))
}

/**
 * Get a specific REFS-backed tool by SDK name.
 */
export function getRefsTool(sdkName: string): Tool.Info | undefined {
  const handle = getHandle()
  const json = handle.listTools()
  const parsed = JSON.parse(json)
  const defs: ToolDefinition[] = parsed?.result?.tools ?? []
  const def = defs.find((d) => d.name === sdkName)
  if (!def) return undefined
  return def.name === "read" ? createReadTool(def) : mcpToolToInfo(def)
}
