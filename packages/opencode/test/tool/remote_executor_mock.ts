import { spyOn } from "bun:test"
import { createHash } from "crypto"
import path from "path"
import fs from "fs/promises"
import { RemoteExecutor } from "../../src/tool/remote_executor"

function hash(text: string) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`
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
