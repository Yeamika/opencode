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
import { Flag } from "../flag/flag"
import { File } from "../file"

// ─── Local types (avoid importing from native addon) ───

interface ToolDefinition {
  name: string
  description: string | null
  inputSchema: Record<string, unknown>
}

const HIDDEN_MCP_PARAMS = new Set(["ExecutorSessionID", "includeStructuredContent"])
const EXBASH_MAX_OUTPUT_BYTES = 5 * 1024
const READ_MAX_LINES = 2000
const READ_MAX_BYTES = 50 * 1024
const READ_MAX_BYTES_LABEL = `${READ_MAX_BYTES / 1024} KB`
const INSTRUCTIONS = ["AGENTS.md", ...(Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT ? [] : ["CLAUDE.md"]), "CONTEXT.md"]

type Found = { filepath: string; content: string; hash?: string }
type Seen = { paths: Set<string>; refs: Map<string, string>; system: Set<string> }

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

function readInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const next = modelInputSchema(schema) as Record<string, any>
  const mode = next.properties?.mode
  if (mode && typeof mode === "object" && Array.isArray(mode.enum) && !mode.enum.includes("img")) {
    mode.enum = [...mode.enum, "img"]
    mode.description = "Read mode: text for normal files, binary for hexdump bytes, img for local image/PDF attachments."
  }
  return next
}

async function callRefsTool(def: ToolDefinition, args: unknown, ctx: Tool.Context) {
  const values: Record<string, unknown> =
    args && typeof args === "object" && !Array.isArray(args)
      ? { ExecutorSessionID: ctx.sessionID, ...(args as Record<string, unknown>) }
      : { ExecutorSessionID: ctx.sessionID }
  values.ExecutorSessionID = ctx.sessionID
  if (def.name === "FileAction") values.includeStructuredContent = true
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
  result?: { content: Array<{ type: string; text: string }>; structuredContent?: unknown }
}): { title: string; metadata: Record<string, any>; output: string } {
  if (parsed.error) throw new Error(parsed.error.message || "SDK call failed")
  const result = parsed.result
  if (!result) throw new Error("SDK returned no result")
  const data = result.structuredContent
  const meta =
    data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).metadata : undefined

  return {
    title: "tool",
    metadata: meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, any>) : {},
    output: result.content?.[0]?.text ?? "",
  }
}

function exbashTitle(args: unknown, metadata: Record<string, any>) {
  const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  const description = typeof input.description === "string" ? input.description.trim() : ""
  if (description) return description
  const state = typeof metadata.description === "string" ? metadata.description.trim() : ""
  if (state) return state
  return ""
}

function lineNo(line: string) {
  return Number(line.match(/^(\d+):/)?.[1])
}

function readResult(result: { title: string; metadata: Record<string, any>; output: string }, args: Record<string, any>) {
  if (args.mode === "binary" || result.metadata.file?.kind !== "file") {
    if (result.metadata.truncated === undefined) {
      result.metadata.truncated = result.output.includes("Use offset=")
    }
    return result
  }

  const lines = result.output.split("\n")
  const total = lines.findIndex((line) => /^total \d+ lines$/.test(line))
  if (total < 0) {
    const footer = lines.findIndex((line) => /^Showing lines \d+-\d+ of \d+\. Use offset=\d+ to continue\.$/.test(line))
    if (footer >= 0) {
      const refs = lines.slice(0, footer).filter((line) => line.startsWith("<fileRef>"))
      const body = lines.slice(0, footer).filter((line) => !line.startsWith("<fileRef>"))
      const kept: string[] = []
      let bytes = 0

      for (const line of body) {
        const size = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0)
        if (bytes + size > READ_MAX_BYTES) {
          const offset = Number(args.offset ?? 1)
          const last = kept.map(lineNo).filter((n) => Number.isFinite(n)).at(-1) ?? offset + kept.length - 1
          return {
            ...result,
            output: [
              ...kept,
              ...refs,
              "",
              `(Output capped at ${READ_MAX_BYTES_LABEL}. Showing lines ${offset}-${last}. Use offset=${last + 1} to continue.)`,
            ].join("\n"),
            metadata: { ...result.metadata, truncated: true },
          }
        }
        kept.push(line)
        bytes += size
      }
    }
    if (result.metadata.truncated === undefined) {
      result.metadata.truncated = lines.some((line) => /^(Showing lines|Showing bytes) .*Use offset=/.test(line))
    }
    return result
  }

  const count = Number(lines[total]!.match(/^total (\d+) lines$/)?.[1] ?? 0)
  const refs = lines.slice(0, total).filter((line) => line.startsWith("<fileRef>"))
  const body = lines.slice(0, total).filter((line) => !line.startsWith("<fileRef>"))
  const kept: string[] = []
  let bytes = 0
  let capped = false

  for (const line of body) {
    const size = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0)
    if (kept.length >= READ_MAX_LINES || bytes + size > READ_MAX_BYTES) {
      capped = true
      break
    }
    kept.push(line)
    bytes += size
  }

  const offset = Number(args.offset ?? 1)
  const last = kept.map(lineNo).filter((n) => Number.isFinite(n)).at(-1) ?? offset + kept.length - 1
  const hint = capped
    ? `Output capped at ${READ_MAX_BYTES_LABEL}. Showing lines ${offset}-${last}. Use offset=${last + 1} to continue.`
    : `End of file - total ${count} lines`

  return {
    ...result,
    output: [...kept, ...refs, "", `(${hint})`].join("\n"),
    metadata: { ...result.metadata, truncated: capped },
  }
}

function remind<T extends { title: string; metadata: Record<string, any>; output: string }>(
  result: T,
  instructions: Found[],
) {
  if (instructions.length === 0) return result
  const table =
    result.metadata.loadedRefs &&
    typeof result.metadata.loadedRefs === "object" &&
    !Array.isArray(result.metadata.loadedRefs)
      ? result.metadata.loadedRefs
      : {}
  const hashes = Object.fromEntries(instructions.flatMap((item) => (item.hash ? [[item.filepath, item.hash]] : [])))
  return {
    ...result,
    output: [
      result.output,
      "<opencode-system-reminder>",
      instructions.map((item) => item.content).join("\n\n"),
      "</opencode-system-reminder>",
    ].join("\n"),
    metadata: {
      ...result.metadata,
      loaded: [
        ...(Array.isArray(result.metadata.loaded) ? result.metadata.loaded : []),
        ...instructions.map((item) => item.filepath),
      ],
      loadedRefs: {
        ...table,
        ...hashes,
      },
    },
  } as T
}

function paths(filepath: string) {
  return /^[a-zA-Z]:[\\/]/.test(filepath) || filepath.includes("\\") ? path.win32 : path.posix
}

function inside(api: path.PlatformPath, root: string, dir: string) {
  const rel = api.relative(root, dir)
  return rel === "" || (!rel.startsWith("..") && !api.isAbsolute(rel))
}

function plain(output: string) {
  return output
    .split("\n")
    .filter((line) => !line.startsWith("<fileRef>") && !/^total \d+ lines$/.test(line) && !/^Showing lines /.test(line))
    .map((line) => line.replace(/^\d+: ?/, ""))
    .join("\n")
    .trimEnd()
}

function refs(ctx: Tool.Context) {
  const result = new Map<string, string>()
  for (const msg of ctx.messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.tool !== "read" || part.state.status !== "completed") continue
      if (part.state.time.compacted) continue
      const table = part.state.metadata?.loadedRefs
      if (!table || typeof table !== "object" || Array.isArray(table)) continue
      for (const [key, value] of Object.entries(table)) {
        if (typeof value === "string") result.set(key, value)
      }
    }
  }
  return result
}

async function loaded(ctx: Tool.Context, executor: string): Promise<Seen> {
  const system = new Set<string>()
  if (executor === "local") {
    for (const item of await Instruction.systemPaths()) system.add(item)
  }
  return { paths: Instruction.loaded(ctx.messages), refs: refs(ctx), system }
}

function key(executor: string, filepath: string) {
  return `${executor}:${filepath}`
}

async function localRefs(
  def: ToolDefinition,
  ctx: Tool.Context,
  instructions: { filepath: string; content: string }[],
) {
  const entries = await Promise.all(
    instructions.map(async (item) => {
      const data = await load(def, ctx, "local", item.filepath).catch(() => undefined)
      return [key("local", item.filepath), data?.hash]
    }),
  )
  return Object.fromEntries(entries.filter((item): item is [string, string] => typeof item[1] === "string"))
}

function root(api: path.PlatformPath, executor: string, target: string, ctx: Tool.Context) {
  if (executor === "local") return api.normalize(ctx.directory ?? Instance.directory)
  return api.normalize(api.parse(target).root || api.dirname(target))
}

async function load(def: ToolDefinition, ctx: Tool.Context, executor: string, filepath: string) {
  const json = await callRefsTool(
    def,
    { filePath: filepath, executor, mode: "text", includeStructuredContent: true },
    ctx,
  )
  const result = extractOutput(JSON.parse(json))
  if (result.metadata.file?.kind !== "file") return
  const content = plain(result.output)
  const code = typeof result.metadata.hashCode === "string" ? result.metadata.hashCode : undefined
  return { content, ...(code ? { hash: code } : {}) }
}

async function nearby(def: ToolDefinition, ctx: Tool.Context, executor: string, filepath: string) {
  const api = paths(filepath)
  const seen = await loaded(ctx, executor)
  const found: Found[] = []
  const target = api.normalize(filepath)
  const base = root(api, executor, target, ctx)
  let dir = api.dirname(target)

  for (let i = 0; i < 64 && inside(api, base, dir) && dir !== base; i++) {
    for (const file of INSTRUCTIONS) {
      const item = api.join(dir, file)
      const ref = key(executor, item)
      if (item === target || (executor === "local" && seen.system.has(item))) continue
      try {
        const data = await load(def, ctx, executor, item)
        if (!data) continue
        const old = seen.refs.get(ref) ?? (executor === "local" ? seen.refs.get(item) : undefined)
        const known = seen.paths.has(ref) || (executor === "local" && seen.paths.has(item))
        if (known && old && data.hash && old === data.hash) continue
        found.push({ filepath: ref, content: `Instructions from: ${ref}\n${data.content}`, hash: data.hash })
        break
      } catch {
        continue
      }
    }
    const parent = api.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return found
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
            title: exbashTitle(args, output.metadata),
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
  const parameters = jsonSchemaToZod(readInputSchema(def.inputSchema))

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
        const mode = a.mode ?? "text"
        const isHashRef = /\s+#[0-9a-fA-F]{4}$/.test(target)
        const localTarget =
          typeof target === "string" ? (path.isAbsolute(target) ? target : path.resolve(Instance.directory, target)) : ""

        const resolvedPath =
          local && !isHashRef ? (path.isAbsolute(target) ? target : path.resolve(Instance.directory, target)) : target
        const stat = local && !isHashRef ? Filesystem.stat(resolvedPath) : undefined
        const localStat = localTarget && !isHashRef ? Filesystem.stat(localTarget) : undefined
        const mime = localTarget && !localStat?.isDirectory() ? Filesystem.mimeType(localTarget) : ""
        const image = mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
        const pdf = mime === "application/pdf"

        if (mode === "img" && !local) {
          throw new Error("Image/PDF reads require executor=local")
        }

        if (local && !isHashRef) {
          await assertExternalDirectory(ctx, resolvedPath, {
            bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
            kind: stat?.isDirectory() ? "directory" : "file",
          })
          await ctx.ask({ permission: "read", patterns: [resolvedPath], always: ["*"], metadata: {} })
        }

        if (local && !isHashRef) {
          if (stat && !stat.isDirectory()) {
            if (mode === "img") {
              if (!image && !pdf) throw new Error("mode=img only supports local image or PDF files")
              const msg = `${image ? "Image" : "PDF"} read successfully`
              const instructions = await Instruction.resolve(ctx.messages, resolvedPath, ctx.messageID)
              return {
                title: path.relative(Instance.worktree, resolvedPath),
                output: msg,
                metadata: {
                  preview: msg,
                  truncated: false,
                  loaded: instructions.map((i) => key("local", i.filepath)),
                  loadedRefs: await localRefs(def, ctx, instructions),
                },
                attachments: [
                  {
                    type: "file" as const,
                    mime,
                    url: `data:${mime};base64,${Buffer.from(await Filesystem.readBytes(resolvedPath)).toString("base64")}`,
                  },
                ],
              }
            }
            if (mode !== "binary" && File.isKnownBinary(resolvedPath)) {
              throw new Error("Cannot read binary file")
            }
          }
        }

        if (mode === "img") throw new Error("mode=img only supports local image or PDF files")

        const json = await callRefsTool(
          def,
          { ...a, includeStructuredContent: true, ...(stat?.isDirectory() ? { hashCheckMode: false } : {}) },
          ctx,
        )
        const result = readResult(extractOutput(JSON.parse(json)), a)
        if (local && !isHashRef && mode !== "binary" && stat && !stat.isDirectory()) {
          return remind(result, await nearby(def, ctx, executor, resolvedPath))
        }
        if (mode !== "binary" && result.metadata.file?.kind === "file") {
          const filepath = result.metadata.file.canonicalPath
          if (typeof filepath === "string") return remind(result, await nearby(def, ctx, executor, filepath))
        }
        return result
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
