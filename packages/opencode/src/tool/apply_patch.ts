import z from "zod"
import * as path from "path"
import fs from "fs/promises"
import { createTwoFilesPatch } from "diff"
import { Tool } from "./tool"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { LSP } from "../lsp"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"
import { RemoteExecutor } from "./remote_executor"
import { SessionFileRead } from "../session/file-read"

type ViewFile = {
  filePath: string
  relativePath: string
  type: string
  diff: string
  before: string
  after: string
  additions: number
  deletions: number
  movePath?: string
}

const PatchParams = z.object({
  filePath: z.string().optional().describe('Target file read label returned by read, for example "App.ts #A1B2"'),
  patchMode: z
    .enum(["text", "binary"])
    .optional()
    .describe("Patch mode. Defaults to text. Binary mode uses 0-based byte-offset hex patchText."),
  patchText: z.string().describe("REC patch text. Text example: `replace 3 3\n+new line`. Binary example: `replace 0 1\n+FF`."),
  executor: z.string().optional().describe("Ignored for file references; executor is resolved from the read table."),
})

function fileMeta(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  return value as ViewFile
}

function hexBytes(input: string) {
  const compact = input.replace(/(?:0x|0X)/g, "").replace(/[\s,_]/g, "")
  if (compact.length % 2 !== 0) throw new Error("hex content must contain an even number of digits")
  if (!/^[0-9a-fA-F]*$/.test(compact)) throw new Error("hex content contains non-hex characters")
  const bytes = []
  for (let index = 0; index < compact.length; index += 2) bytes.push(Number.parseInt(compact.slice(index, index + 2), 16))
  return bytes
}

function hexDump(bytes: Uint8Array | number[]) {
  const rows = []
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const slice = Array.from(bytes.slice(offset, offset + 16))
    const hex = slice.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ").padEnd(47, " ")
    const ascii = slice.map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".")).join("")
    rows.push(`${offset.toString(16).padStart(8, "0").toUpperCase()}  ${hex}  |${ascii}|`)
  }
  return rows.join("\n") + (rows.length ? "\n" : "")
}

function binaryDiff(filePath: string, beforeHex: string, afterHex: string) {
  return createTwoFilesPatch(filePath, filePath, hexDump(hexBytes(beforeHex)), hexDump(hexBytes(afterHex)))
}

function binaryFile(file: ViewFile) {
  if (file.type !== "binary-update") return file
  try {
    return { ...file, diff: binaryDiff(file.relativePath || file.filePath, file.before, file.after) }
  } catch {
    return file
  }
}

function applyBinaryPatch(before: Uint8Array, patchText: string) {
  if (patchText.split("\n").some((line) => line.trim() === "*** Begin Patch")) {
    throw new Error("old apply_patch envelope format is not supported; pass filePath separately and use binary patchText")
  }

  const hunks: Array<{ kind: "insert" | "replace" | "delete"; offset: number; len?: number; bytes: number[]; order: number }> = []
  let current: (typeof hunks)[number] | undefined
  for (const raw of patchText.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const header = /^(insert|replace|delete)\s+(-?\d+)(?:\s+(-?\d+))?$/.exec(line)
    if (header) {
      const kind = header[1] as "insert" | "replace" | "delete"
      if (kind !== "insert" && header[3] === undefined) throw new Error("binary replace/delete hunks require a byte length")
      current = {
        kind,
        offset: Number(header[2]),
        len: header[3] === undefined ? undefined : Number(header[3]),
        bytes: [],
        order: hunks.length,
      }
      hunks.push(current)
      continue
    }
    if (!current) throw new Error("binary patchText must start with a hunk header")
    if (line.startsWith("copy ")) throw new Error("copy body lines are not supported in binary patch mode")
    if (!line.startsWith("+")) throw new Error(`unsupported binary patch body line \`${line}\`; body lines must start with \`+\``)
    current.bytes.push(...hexBytes(line.slice(1)))
  }
  if (hunks.length === 0) throw new Error("patchText did not contain any hunks")

  const ops = hunks.map((hunk) => {
    if (hunk.kind === "delete" && hunk.bytes.length > 0) throw new Error("delete hunks cannot contain body lines")
    if (hunk.kind !== "delete" && hunk.bytes.length === 0) throw new Error("non-delete binary hunks require at least one byte")
    if (hunk.kind === "insert") {
      const start = hunk.offset === -1 ? before.length : hunk.offset
      if (hunk.offset !== -1 && hunk.offset !== 0 && (start < 0 || start >= before.length)) {
        throw new Error(`insert offset ${hunk.offset} is out of range for this file (${before.length} bytes); use insert 0 for the start or insert -1 for the end`)
      }
      return { start, end: start, bytes: hunk.bytes, order: hunk.order }
    }
    if (hunk.offset < 0 || hunk.offset >= before.length) {
      throw new Error(`byte offset ${hunk.offset} is out of range for this file (${before.length} bytes)`)
    }
    const end = hunk.len === -1 ? before.length : hunk.offset + (hunk.len ?? 0)
    if (end > before.length) throw new Error(`byte range ${hunk.offset}..${end} is out of range for this file (${before.length} bytes)`)
    return { start: hunk.offset, end, bytes: hunk.kind === "delete" ? [] : hunk.bytes, order: hunk.order }
  })
  ops.sort((a, b) => a.start - b.start || Number(b.end > b.start) - Number(a.end > a.start) || a.order - b.order)

  const output = []
  let cursor = 0
  for (const op of ops) {
    if (op.start < cursor) throw new Error("binary patch hunks overlap or target already replaced bytes")
    output.push(...before.slice(cursor, op.start), ...op.bytes)
    cursor = op.end
  }
  output.push(...before.slice(cursor))
  return Uint8Array.from(output)
}

export const ApplyPatchTool = Tool.define("apply_patch", {
  description: DESCRIPTION,
  parameters: PatchParams,
  async execute(params, ctx) {
    if (!params.patchText.trim()) throw new Error("patchText is required")
    if (!params.filePath) throw new Error('filePath is required and must be a read reference like "App.ts #A1B2"')

    const entry = SessionFileRead.resolve({ sessionID: ctx.sessionID, target: params.filePath })
    const executor = SessionFileRead.executor(entry)
    const local = executor === "local"
    const filePath = entry.filePath

    if (local) {
      await assertExternalDirectory(ctx, filePath)
      const permissionDiff =
        params.patchMode === "binary"
          ? await fs.readFile(filePath).then((before) =>
              binaryDiff(filePath, before.toString("hex"), Buffer.from(applyBinaryPatch(before, params.patchText)).toString("hex")),
            )
          : params.patchText
      await ctx.ask({
        permission: "edit",
        patterns: [path.relative(Instance.worktree, filePath)],
        always: ["*"],
        metadata: { filepath: filePath, diff: permissionDiff },
      })
    }

    const result = await RemoteExecutor.call(
      "apply_patch",
      {
        filePath,
        patchText: params.patchText,
        ...(params.patchMode === undefined ? {} : { patchMode: params.patchMode }),
        hashCheckMode: true,
        hashCode: entry.hashCode,
        ...(local ? {} : { executor }),
      },
      { signal: ctx.abort },
    )

    const hashCode = RemoteExecutor.hashCode(result) ?? (local ? await RemoteExecutor.fileHashCode(filePath).catch(() => undefined) : undefined)
    const next = hashCode ? SessionFileRead.retouch({ sessionID: ctx.sessionID, fileKeyRef: entry.fileKeyRef, hashCode }) : undefined
    const label = next ? SessionFileRead.label(next) : SessionFileRead.label(entry)
    const file = fileMeta(result.metadata.file)
    const viewFile = file ? binaryFile(file) : undefined
    const files = viewFile ? [viewFile] : []

    if (local) {
      Bus.publish(File.Event.Edited, { file: filePath })
      await LSP.touchFile(filePath, true)
      await Bus.publish(FileWatcher.Event.Updated, { file: filePath, event: "change" })
    }

    const diagnostics = local ? await LSP.diagnostics() : {}
    return {
      ...result,
      output: `${result.output}\n<fileRef>${label}</fileRef>`,
      metadata: {
        ...result.metadata,
        diff: viewFile?.diff ?? (typeof result.metadata.diff === "string" ? result.metadata.diff : (file?.diff ?? "")),
        file: viewFile ?? result.metadata.file,
        files,
        diagnostics,
        fileRef: label,
        smallHashCode: next?.smallHashCode ?? entry.smallHashCode,
      },
    }
  },
})
