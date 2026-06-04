/**
 * refs-tools.ts: Dynamic tool registration from MCP tools/list.
 *
 * Reads tool definitions from the REFS-opencode MCP handle and creates
 * OpenCode Tool.Info objects. No hand-written schemas - everything comes
 * from the Rust SDK's mcptooldefs.rs via tools/list.
 *
 * Special case: `read` tool gets an image/PDF wrapper before SDK delegation.
 *
 * Exports type-compatible stubs (ReadTool, RgTool, ExBashTool, ExecutorManagerTool)
 * for code that needs Tool.InferParameters<typeof XXX> type inference.
 */

import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { getHandle } from "./refs-bridge"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { Instruction } from "../session/instruction"
import { assertExternalDirectory } from "./external-directory"
import {
  getSdkToolDefinitions,
  type ToolDefinition,
} from "@opencode-ai/refs-opencode"

// ─── Map SDK tool names ───

const PERMISSION_MAP: Record<string, string> = {
  FileAction: "edit",
  read: "read",
  rg: "grep",
  exbash: "bash",
  RemoteExecutorManager: "executorManager",
}

const TOOL_ID_MAP: Record<string, string> = {
  FileAction: "FileAction",
  read: "read",
  rg: "rg",
  exbash: "exbash",
  RemoteExecutorManager: "executorManager",
}

// Permissive Zod schema - SDK handles validation
const passthroughSchema = z.object({}).passthrough()

// ─── Type stubs for Tool.InferParameters<T> ───
// These match the SDK's mcptooldefs.rs schemas. They're only used for
// TypeScript type inference, not at runtime.

const readParams = z.object({
  filePath: z.string().optional(),
  fileKey: z.string().optional(),
  mode: z.enum(["text", "binary"]).optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  executor: z.string().optional(),
})

const rgParams = z.object({
  pattern: z.string(),
  root: z.string().optional(),
  path: z.string().optional(),
  include: z.string().optional(),
  globs: z.array(z.string()).optional(),
  case_sensitive: z.boolean().optional(),
  max_count: z.number().optional(),
  executor: z.string().optional(),
})

const exbashParams = z.object({
  mode: z.enum(["run", "shell", "attach", "list", "stop", "remove"]).optional(),
  command: z.string().optional(),
  description: z.string().optional(),
  workdir: z.string().optional(),
  executor: z.string().optional(),
  timeout: z.number().optional(),
  scope: z.enum(["local", "workspace"]).optional(),
  read_timeout: z.number().optional(),
  asyncID: z.string().optional(),
  text: z.string().optional(),
  filePath: z.string().optional(),
  shell: z.string().optional(),
})

const executorManagerParams = z.object({
  mode: z.enum(["add", "reload", "reconnect", "remove", "list", "save"]),
  scope: z.enum(["workspace", "user"]).optional(),
  id: z.string().optional(),
  url: z.string().optional(),
  system: z.string().optional(),
  device: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  executors: z.array(z.any()).optional(),
})

/** Type-compatible stubs for code that needs Tool.InferParameters<T>. */
export const ReadTool = Tool.define("read", {
  description: "Read a file via REC. Supports file references and direct paths.",
  parameters: readParams,
  execute: async () => ({ title: "", output: "", metadata: {} }),
})

export const RgTool = Tool.define("rg", {
  description: "Ripgrep-style search powered by RemoteExecutor.",
  parameters: rgParams,
  execute: async () => ({ title: "", output: "", metadata: {} }),
})

export const ExBashTool = Tool.define("exbash", {
  description: "Extended PTY command control surface backed by RemoteExecutor.",
  parameters: exbashParams,
  execute: async () => ({ title: "", output: "", metadata: {} }),
})

export const ExecutorManagerTool = Tool.define("executorManager", {
  description: "Manage RemoteExecutor executor links for the current workspace.",
  parameters: executorManagerParams,
  execute: async () => ({ title: "", output: "", metadata: {} }),
})

// ─── Dynamic tool creation ───

/**
 * Extract output from SDK JSON-RPC response.
 */
function extractOutput(parsed: {
  error?: { code: number; message: string }
  result?: { content: Array<{ type: string; text: string }>; structuredContent?: unknown }
}): { title: string; metadata: Record<string, unknown>; output: string } {
  if (parsed.error) throw new Error(parsed.error.message || "SDK call failed")
  const result = parsed.result
  if (!result) throw new Error("SDK returned no result")

  const sc = (result.structuredContent ?? {}) as Record<string, unknown>
  const meta = (sc.metadata ?? {}) as Record<string, unknown>
  const title = typeof sc.title === "string" ? sc.title : "tool"

  let output: string
  if (typeof sc.output === "string") {
    output = sc.output
  } else if (sc.output && typeof sc.output === "object") {
    const obj = sc.output as Record<string, unknown>
    const parts = [obj.message, obj.text, obj.info]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
    output = parts.length ? parts.join("\n") : result.content?.[0]?.text ?? ""
  } else {
    output = result.content?.[0]?.text ?? ""
  }

  return { title, metadata: meta, output }
}

/**
 * Create a generic OpenCode Tool.Info from an MCP tool definition.
 */
function mcpToolToInfo(def: ToolDefinition): Tool.Info {
  const toolId = TOOL_ID_MAP[def.name] ?? def.name
  const permission = PERMISSION_MAP[def.name]

  return {
    id: toolId,
    init: async () => ({
      description: def.description ?? "",
      parameters: passthroughSchema,
      execute: async (args, ctx) => {
        if (permission) {
          await ctx.ask({
            permission: permission as any,
            patterns: [`${toolId}`],
            always: ["*"],
            metadata: { tool: toolId },
          })
        }
        const json = getHandle().callTool(def.name, JSON.stringify(args))
        return extractOutput(JSON.parse(json))
      },
    }),
  }
}

/**
 * Create the `read` tool with image/PDF handling.
 */
function createReadTool(def: ToolDefinition): Tool.Info {
  return {
    id: "read",
    init: async () => ({
      description: def.description ?? "",
      parameters: passthroughSchema,
      execute: async (args, ctx) => {
        const filePath = (args as Record<string, unknown>).filePath as string | undefined
        const fileKey = (args as Record<string, unknown>).fileKey as string | undefined
        const target = filePath ?? fileKey ?? ""
        const executor = ((args as Record<string, unknown>).executor as string) ?? "local"
        const local = executor === "local"
        const isHashRef = /\s+#[0-9a-fA-F]{4}$/.test(target)

        const resolvedPath =
          local && !isHashRef
            ? path.isAbsolute(target)
              ? target
              : path.resolve(Instance.directory, target)
            : target

        if (local && !isHashRef) {
          await assertExternalDirectory(ctx, resolvedPath, {
            bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
            kind: Filesystem.stat(resolvedPath)?.isDirectory() ? "directory" : "file",
          })
          await ctx.ask({
            permission: "read",
            patterns: [resolvedPath],
            always: ["*"],
            metadata: {},
          })
        }

        if (local && !isHashRef) {
          const stat = Filesystem.stat(resolvedPath)
          const mode = (args as Record<string, unknown>).mode as string | undefined
          if (stat && !stat.isDirectory() && mode !== "binary") {
            const mime = Filesystem.mimeType(resolvedPath)
            const image =
              mime.startsWith("image/") &&
              mime !== "image/svg+xml" &&
              mime !== "image/vnd.fastbidsheet"
            const pdf = mime === "application/pdf"

            if (image || pdf) {
              if (pdf) throw new Error("PDF read is not supported yet")
              const msg = "Image read successfully"
              const instructions = await Instruction.resolve(ctx.messages, resolvedPath, ctx.messageID)
              return {
                title: path.relative(Instance.worktree, resolvedPath),
                output: msg,
                metadata: {
                  preview: msg,
                  truncated: false,
                  loaded: instructions.map((item) => item.filepath),
                },
                attachments: [
                  {
                    type: "file" as const,
                    mime,
                    url: `data:${mime};base64,${Buffer.from(
                      await Filesystem.readBytes(resolvedPath),
                    ).toString("base64")}`,
                  },
                ],
              }
            }
          }
        }

        const json = getHandle().callTool(def.name, JSON.stringify(args))
        return extractOutput(JSON.parse(json))
      },
    }),
  }
}

// ─── Public API ───

/**
 * Get all REFS-backed tools by reading tools/list from the MCP.
 */
export function getRefsTools(): Tool.Info[] {
  const handle = getHandle()
  const defs = getSdkToolDefinitions(handle)
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
