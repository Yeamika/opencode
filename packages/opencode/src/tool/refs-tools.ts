/**
 * refs-tools.ts: Dynamic tool registration from MCP tools/list.
 *
 * Reads tool definitions from the REFS-opencode MCP handle and creates
 * OpenCode Tool.Info objects. No hand-written schemas - everything comes
 * from the Rust SDK's mcptooldefs.rs via tools/list.
 *
 * Special case: `read` tool gets an image/PDF wrapper before SDK delegation.
 */

import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { RefsBridge } from "./refs-bridge"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { Instruction } from "../session/instruction"
import { assertExternalDirectory } from "./external-directory"
import {
  getSdkToolDefinitions,
  type ToolDefinition,
} from "@opencode-ai/refs-opencode"

// Map SDK tool names to OpenCode permission keys
const PERMISSION_MAP: Record<string, string> = {
  FileAction: "edit",
  read: "read",
  rg: "grep",
  exbash: "bash",
  RemoteExecutorManager: "executorManager",
}

// Map SDK tool names to OpenCode tool IDs
const TOOL_ID_MAP: Record<string, string> = {
  FileAction: "FileAction",
  read: "read",
  rg: "rg",
  exbash: "exbash",
  RemoteExecutorManager: "executorManager",
}

// Permissive Zod schema - SDK handles validation
const passthroughSchema = z.object({}).passthrough()

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
        const json = RefsBridge.getHandle().callTool(def.name, JSON.stringify(args))
        return extractOutput(JSON.parse(json))
      },
    }),
  }
}

/**
 * Create the `read` tool with image/PDF handling.
 *
 * The SDK handles normal file reads + hashRef pipeline.
 * Image/PDF detection is OpenCode-specific and happens before SDK delegation.
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

        // Resolve path for local non-hashRef files
        const resolvedPath =
          local && !isHashRef
            ? path.isAbsolute(target)
              ? target
              : path.resolve(Instance.directory, target)
            : target

        // Permission check (kept from original)
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

        // Image/PDF handling (OpenCode-specific, kept from original read.ts)
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
              const instructions = await Instruction.resolve(
                ctx.messages,
                resolvedPath,
                ctx.messageID,
              )
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

        // SDK call for non-image files
        const json = RefsBridge.getHandle().callTool(def.name, JSON.stringify(args))
        return extractOutput(JSON.parse(json))
      },
    }),
  }
}

/**
 * Get all REFS-backed tools by reading tools/list from the MCP.
 * Call once during tool registry initialization.
 */
export function getRefsTools(): Tool.Info[] {
  const handle = RefsBridge.getHandle()
  const defs = getSdkToolDefinitions(handle)
  return defs.map((def) => (def.name === "read" ? createReadTool(def) : mcpToolToInfo(def)))
}

/**
 * Get a specific REFS-backed tool by SDK name.
 */
export function getRefsTool(sdkName: string): Tool.Info | undefined {
  const handle = RefsBridge.getHandle()
  const json = handle.listTools()
  const parsed = JSON.parse(json)
  const defs: ToolDefinition[] = parsed?.result?.tools ?? []
  const def = defs.find((d) => d.name === sdkName)
  if (!def) return undefined
  return def.name === "read" ? createReadTool(def) : mcpToolToInfo(def)
}
