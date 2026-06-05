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
import { getHandle } from "./refs-bridge"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { Instruction } from "../session/instruction"
import { assertExternalDirectory } from "./external-directory"

// ─── Local types (avoid importing from native addon) ───

interface ToolDefinition {
  name: string
  description: string | null
  inputSchema: Record<string, unknown>
}

const HIDDEN_MCP_PARAMS = new Set(["ExecutorSessionID", "includeStructuredContent"])

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
    : typeof s.type === "string" ? [s.type] : []

  if (types.length > 1) {
    return withJsonSchemaMetadata(
      s,
      zodUnion(types.map((type) => type === "null" ? z.null() : jsonSchemaToZod({ ...s, type }))),
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
    if (s.additionalProperties && typeof s.additionalProperties === "object" && !Array.isArray(s.additionalProperties)) {
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

function callRefsTool(def: ToolDefinition, args: unknown, ctx: Tool.Context) {
  const values =
    args && typeof args === "object" && !Array.isArray(args)
      ? { ExecutorSessionID: ctx.sessionID, ...(args as Record<string, unknown>) }
      : { ExecutorSessionID: ctx.sessionID }
  values.ExecutorSessionID = ctx.sessionID
  return getHandle({
    sessionID: ctx.sessionID,
    workdir: ctx.directory ?? Instance.directory,
  }).callTool(def.name, JSON.stringify(values))
}

// ─── Type stubs for Tool.InferParameters<T> ───

const readParams = z.object({
  filePath: z.string().optional(),
  fileKey: z.string().optional(),
  mode: z.enum(["text", "binary"]).optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  executor: z.string().optional(),
}).passthrough()

const fileActionParams = z.object({
  mode: z.enum(["patch", "create", "delete", "rename"]).optional(),
  fileKey: z.string().optional(),
  filePath: z.string().optional(),
  newFilePath: z.string().optional(),
  patchText: z.string().optional(),
  content: z.string().optional(),
  patchMode: z.enum(["text", "binary"]).optional(),
  executor: z.string().optional(),
  targetExecutor: z.string().optional(),
}).passthrough()

const rgParams = z.object({
  pattern: z.string().describe("Regex pattern to search for."),
  root: z.string().optional().describe("Legacy search root alias."),
  path: z.string().optional().describe("Specific file or directory to search."),
  include: z.string().optional().describe("Legacy include glob alias."),
  globs: z.array(z.string()).optional().describe("Glob filters."),
  case_sensitive: z.boolean().optional().describe("Case-sensitive matching."),
  max_count: z.number().int().optional().describe("Maximum number of matches to return."),
  executor: z.string().optional().describe("Target executor id."),
}).passthrough()

const exbashParams = z.object({
  mode: z.enum(["run", "runexe", "shell", "attach", "list", "stop", "remove"]).optional(),
  command: z.string().optional(),
  description: z.string().optional(),
  workdir: z.string().optional(),
  executor: z.string().optional(),
  timeout: z.number().optional(),
  scope: z.enum(["local", "workspace", "remote"]).optional(),
  read_timeout: z.number().optional(),
  asyncID: z.string().optional(),
  text: z.string().optional(),
  filePath: z.string().optional(),
  shell: z.string().optional(),
}).passthrough()

const executorManagerParams = z.object({
  mode: z.enum(["add", "reload", "reconnect", "remove", "list", "save"]).optional(),
  method: z.enum(["list_executor", "connect_to_executor", "list_shells", "set_executor_shell"]).optional(),
  scope: z.enum(["workspace", "user"]).optional(),
  executor: z.string().optional(),
  id: z.string().optional(),
  url: z.string().optional(),
  system: z.string().optional(),
  device: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  shell: z.string().optional(),
  executors: z.array(z.any()).optional(),
}).passthrough()

/** Type-compatible stubs for code that needs Tool.InferParameters<T>. */
export const ReadTool = Tool.define("read", {
  description: "Read a file via REC. Supports file references and direct paths.",
  parameters: readParams,
  execute: async () => ({ title: "", output: "", metadata: {} as Record<string, any> }),
})

export const FileActionTool = Tool.define("FileAction", {
  description: "Create, patch, rename, or delete a file via REC.",
  parameters: fileActionParams,
  execute: async () => ({ title: "", output: "", metadata: {} as Record<string, any> }),
})

export const RgTool = Tool.define("rg", {
  description: "Ripgrep-style search powered by RemoteExecutor.",
  parameters: rgParams,
  execute: async () => ({ title: "", output: "", metadata: {} as Record<string, any> }),
})

export const ExBashTool = Tool.define("exbash", {
  description: "Extended PTY command control surface backed by RemoteExecutor.",
  parameters: exbashParams,
  execute: async () => ({ title: "", output: "", metadata: {} as Record<string, any> }),
})

export const ExecutorManagerTool = Tool.define("RemoteExecutorManager", {
  description: "Manage RemoteExecutor executor links for the current workspace.",
  parameters: executorManagerParams,
  execute: async () => ({ title: "", output: "", metadata: {} as Record<string, any> }),
})

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

function mcpToolToInfo(def: ToolDefinition): Tool.Info {
  const toolId = def.name
  const parameters = jsonSchemaToZod(modelInputSchema(def.inputSchema))

  return {
    id: toolId,
    init: async () => ({
      description: def.description ?? "",
      parameters,
      execute: async (args, ctx) => {
        await ctx.ask({
          permission: toolId as any,
          patterns: [`${toolId}`],
          always: ["*"],
          metadata: { tool: toolId },
        })
        const json = callRefsTool(def, args, ctx)
        return extractOutput(JSON.parse(json))
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
          local && !isHashRef
            ? path.isAbsolute(target) ? target : path.resolve(Instance.directory, target)
            : target

        if (local && !isHashRef) {
          await assertExternalDirectory(ctx, resolvedPath, {
            bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
            kind: Filesystem.stat(resolvedPath)?.isDirectory() ? "directory" : "file",
          })
          await ctx.ask({ permission: "read", patterns: [resolvedPath], always: ["*"], metadata: {} })
        }

        if (local && !isHashRef) {
          const stat = Filesystem.stat(resolvedPath)
          if (stat && !stat.isDirectory() && a.mode !== "binary") {
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
                attachments: [{ type: "file" as const, mime, url: `data:${mime};base64,${Buffer.from(await Filesystem.readBytes(resolvedPath)).toString("base64")}` }],
              }
            }
          }
        }

        const json = callRefsTool(def, args, ctx)
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
