import { spyOn } from "bun:test"
import { createHash } from "crypto"
import path from "path"
import fs from "fs/promises"
import { RemoteExecutor } from "../../src/tool/remote_executor"

function hash(input: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function applyBinaryPatch(before: Buffer, patchText: string) {
  if (patchText.split("\n").some((line) => line.trim() === "*** Begin Patch")) {
    throw new Error("old apply_patch envelope format is not supported")
  }
  const hunks: Array<{ kind: string; offset: number; len?: number; bytes: number[]; order: number }> = []
  let current: (typeof hunks)[number] | undefined
  for (const line of patchText.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const match = /^(replace|delete|insert)\s+(-?\d+)(?:\s+(-?\d+))?$/.exec(line)
    if (match) {
      current = { kind: match[1]!, offset: Number(match[2]), len: match[3] === undefined ? undefined : Number(match[3]), bytes: [], order: hunks.length }
      hunks.push(current)
      continue
    }
    if (!current) throw new Error("binary patchText must start with a hunk header")
    if (!line.startsWith("+")) throw new Error("unsupported binary patch body line")
    current.bytes.push(...decodeHex(line.slice(1)))
  }
  const ops = hunks.map((hunk) => {
    if (hunk.kind === "insert") {
      const start = hunk.offset === -1 ? before.length : hunk.offset
      return { start, end: start, bytes: hunk.bytes, order: hunk.order }
    }
    const len = hunk.len === -1 ? before.length - hunk.offset : hunk.len ?? 0
    return { start: hunk.offset, end: hunk.offset + len, bytes: hunk.kind === "delete" ? [] : hunk.bytes, order: hunk.order }
  })
  ops.sort((a, b) => a.start - b.start || Number(b.end > b.start) - Number(a.end > a.start) || a.order - b.order)
  const out: number[] = []
  let cursor = 0
  for (const op of ops) {
    if (op.start < cursor) throw new Error("binary patch hunks overlap")
    out.push(...before.subarray(cursor, op.start))
    out.push(...op.bytes)
    cursor = op.end
  }
  out.push(...before.subarray(cursor))
  return Buffer.from(out)
}

function decodeHex(text: string) {
  const compact = text.replace(/(?:0x|0X)/g, "").replace(/[\s,_]/g, "")
  if (compact.length % 2 !== 0) throw new Error("hex content must contain an even number of digits")
  if (!/^[0-9a-fA-F]*$/.test(compact)) throw new Error("hex content contains non-hex characters")
  const bytes = []
  for (let index = 0; index < compact.length; index += 2) bytes.push(Number.parseInt(compact.slice(index, index + 2), 16))
  return bytes
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join(" ")
}

async function stamp(filePath: string): Promise<RemoteExecutor.FileStamp> {
  const real = await fs.realpath(filePath).catch(() => filePath)
  const stat = await fs.stat(filePath).catch(() => undefined)
  return {
    fileKey: real,
    canonicalPath: real,
    kind: stat?.isFile() ? "file" : stat?.isDirectory() ? "directory" : stat ? "other" : "missing",
    size: stat?.size,
    mtimeMs: stat?.mtimeMs,
  }
}

function lines(text: string) {
  if (!text) return { body: [] as string[], finalNewline: false }
  const finalNewline = text.endsWith("\n")
  const body = finalNewline ? text.slice(0, -1) : text
  return { body: body ? body.split("\n") : [], finalNewline }
}

function applyLinePatch(before: string, patchText: string) {
  if (patchText.split("\n").some((line) => line.trim() === "*** Begin Patch")) {
    throw new Error("old apply_patch envelope format is not supported")
  }
  const [header, ...body] = patchText.split("\n").filter((line) => line.trim() !== "")
  const match = /^(replace|insert)\s+(-?\d+)(?:\s+(\d+))?$/.exec(header ?? "")
  if (!match) throw new Error("patchText must start with a hunk header")
  const current = lines(before)
  const replacement = body.map((line) => {
    if (!line.startsWith("+")) throw new Error("unsupported patch body line")
    return line.slice(1)
  })
  if (match[1] === "insert") {
    const target = Number(match[2])
    const index = target === -1 ? current.body.length : target
    current.body.splice(index, 0, ...replacement)
  } else {
    const start = Number(match[2])
    const end = Number(match[3])
    current.body.splice(start - 1, end - start + 1, ...replacement)
  }
  return current.body.join("\n") + (current.finalNewline ? "\n" : "")
}

export function mockRemoteExecutor() {
  const statSpy = spyOn(RemoteExecutor, "stat").mockImplementation(async (filePath) => stamp(filePath))
  const callSpy = spyOn(RemoteExecutor, "call").mockImplementation(async (tool, args) => {
    const filePath = String(args.filePath)
    if (tool === "read") {
      if (args.mode === "binary") {
        const bytes = await fs.readFile(filePath)
        const file = await stamp(filePath)
        const offset = typeof args.offset === "number" ? args.offset : 0
        const limit = Math.min(typeof args.limit === "number" ? args.limit : 128, 128)
        const slice = bytes.subarray(offset, offset + limit)
        return {
          title: path.basename(filePath),
          output: `<path>${filePath}</path>\n<type>binary</type>\n<hashCode>${hash(bytes)}</hashCode>\n<content encoding="hex" offset="${offset}" length="${slice.length}" total="${bytes.length}">\n${hex(slice)}\n</content>`,
          metadata: { file, hashCode: hash(bytes), mode: "binary", encoding: "hex", offset, length: slice.length, total: bytes.length, truncated: offset + slice.length < bytes.length },
        }
      }
      const text = await fs.readFile(filePath, "utf-8")
      const file = await stamp(filePath)
      const numbered = text
        .split("\n")
        .slice(0, text.endsWith("\n") ? -1 : undefined)
        .map((line, idx) => `${idx + 1}: ${line}`)
        .join("\n")
      return {
        title: path.basename(filePath),
        output: `<path>${filePath}</path>\n<type>file</type>\n<hashCode>${hash(text)}</hashCode>\n<content>\n${numbered}\n</content>`,
        metadata: { file, hashCode: hash(text), truncated: false, loaded: [] },
      }
    }
    if (tool === "apply_patch") {
      if (args.patchMode === "binary") {
        const before = await fs.readFile(filePath)
        if (args.hashCheckMode && args.hashCode !== hash(before)) {
          throw new Error(`hash mismatch for ${filePath}: expected ${args.hashCode}, current ${hash(before)}; re-read and retry`)
        }
        const after = applyBinaryPatch(before, String(args.patchText))
        await fs.writeFile(filePath, after)
        const file = {
          filePath,
          relativePath: path.basename(filePath),
          type: "binary-update",
          diff: `Binary update: ${path.basename(filePath)}\n- ${before.length} bytes: ${hex(before)}\n+ ${after.length} bytes: ${hex(after)}\n`,
          before: hex(before),
          after: hex(after),
          additions: 0,
          deletions: 0,
        }
        return {
          title: `Success. Updated file:\nM ${path.basename(filePath)}`,
          output: `Success. Updated file:\nM ${path.basename(filePath)}\nhashCode: ${hash(after)}`,
          metadata: { file, diff: file.diff, diagnostics: {}, hashCode: hash(after) },
        }
      }
      const before = await fs.readFile(filePath, "utf-8")
      if (args.hashCheckMode && args.hashCode !== hash(before)) {
        throw new Error(`hash mismatch for ${filePath}: expected ${args.hashCode}, current ${hash(before)}; re-read and retry`)
      }
      const after = applyLinePatch(before, String(args.patchText))
      await fs.writeFile(filePath, after, "utf-8")
      const file = {
        filePath,
        relativePath: path.basename(filePath),
        type: "update",
        diff: "",
        before,
        after,
        additions: 0,
        deletions: 0,
      }
      return {
        title: `Success. Updated file:\nM ${path.basename(filePath)}`,
        output: `Success. Updated file:\nM ${path.basename(filePath)}\nhashCode: ${hash(after)}`,
        metadata: { file, diff: "", diagnostics: {}, hashCode: hash(after) },
      }
    }
    throw new Error(`unexpected tool ${tool}`)
  })
  return () => {
    statSpy.mockRestore()
    callSpy.mockRestore()
  }
}
