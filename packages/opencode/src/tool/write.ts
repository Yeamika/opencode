import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { trimDiff } from "./edit"
import { assertExternalDirectory } from "./external-directory"
import { RemoteExecutor } from "./remote_executor"
import { SessionFileRead } from "../session/file-read"

function splitLines(text: string) {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  if (!normalized) return []
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n")
}

function linePatch(before: string, after: string) {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  const header = oldLines.length === 0 ? "insert -1" : `replace 1 ${oldLines.length}`
  return [header, ...newLines.map((line) => `+${line}`)].join("\n")
}

function parseReadOutput(output: string) {
  return output
    .split("\n")
    .flatMap((line) => {
      const match = /^\d+: ?(.*)$/.exec(line)
      return match ? [match[1]!] : []
    })
    .join("\n")
}

async function readCurrent(filePath: string, executor: string) {
  if (executor === "local") return Filesystem.readText(filePath)
  const result = await RemoteExecutor.call("read", { filePath, executor, limit: 1_000_000, hashCheckMode: true })
  return parseReadOutput(result.output)
}

export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z.object({
    content: z.string().describe("The content to write to the file"),
    filePath: z
      .string()
      .describe('For existing files, the read reference to overwrite, for example "App.ts #A1B2". For new local files only, a file path.'),
    mode: z
      .enum(["text", "binary"])
      .optional()
      .describe("Write mode. Defaults to text. Binary mode is not supported by REC line patch."),
    encoding: z.enum(["hex"]).optional().describe("Encoding for binary content. Currently only hex is supported."),
    executor: z.string().optional().describe("RemoteExecutor executor id. Defaults to local."),
  }),
  async execute(params, ctx) {
    if (params.mode === "binary") throw new Error("Binary write is not supported by REC line patch")

    if (SessionFileRead.parseTarget(params.filePath)) {
      const entry = SessionFileRead.resolve({ sessionID: ctx.sessionID, target: params.filePath })
      const executor = SessionFileRead.executor(entry)
      const filepath = entry.filePath
      const contentOld = await readCurrent(filepath, executor)
      const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
      if (executor === "local") {
        await assertExternalDirectory(ctx, filepath)
        await ctx.ask({
          permission: "edit",
          patterns: [path.relative(Instance.worktree, filepath)],
          always: ["*"],
          metadata: { filepath, diff },
        })
      }
      const result = await RemoteExecutor.call(
        "apply_patch",
        {
          filePath: filepath,
          patchText: linePatch(contentOld, params.content),
          hashCheckMode: true,
          hashCode: entry.hashCode,
          ...(executor === "local" ? {} : { executor }),
        },
        { signal: ctx.abort },
      )
      const hashCode = RemoteExecutor.hashCode(result) ?? (executor === "local" ? await RemoteExecutor.fileHashCode(filepath).catch(() => undefined) : undefined)
      const next = hashCode ? SessionFileRead.retouch({ sessionID: ctx.sessionID, fileKeyRef: entry.fileKeyRef, hashCode }) : undefined
      const label = next ? SessionFileRead.label(next) : SessionFileRead.label(entry)
      if (executor === "local") {
        Bus.publish(File.Event.Edited, { file: filepath })
        await Bus.publish(FileWatcher.Event.Updated, { file: filepath, event: "change" })
        await LSP.touchFile(filepath, true)
      }
      const diagnostics = executor === "local" ? await LSP.diagnostics() : {}
      return {
        ...result,
        title: label,
        output: `Wrote file successfully.\n<fileRef>${label}</fileRef>`,
        metadata: {
          ...result.metadata,
          diagnostics,
          filepath,
          exists: true,
          diff,
          fileRef: label,
          smallHashCode: next?.smallHashCode ?? entry.smallHashCode,
        },
      }
    }

    const executor = params.executor?.trim() || "local"
    if (executor !== "local") {
      throw new Error("Creating remote files with write is not supported by REC apply_patch; create the file remotely first, then read it.")
    }

    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    await assertExternalDirectory(ctx, filepath)
    if (await Filesystem.exists(filepath)) {
      throw new Error('Existing files must be written using a read reference like "App.ts #A1B2". Use read first.')
    }

    const diff = trimDiff(createTwoFilesPatch(filepath, filepath, "", params.content))
    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, filepath)],
      always: ["*"],
      metadata: {
        filepath,
        diff,
      },
    })

    await Filesystem.write(filepath, params.content)
    Bus.publish(File.Event.Edited, { file: filepath })
    await Bus.publish(FileWatcher.Event.Updated, { file: filepath, event: "add" })

    let output = "Wrote file successfully."
    await LSP.touchFile(filepath, true)
    const diagnostics = await LSP.diagnostics()
    const readResult = await RemoteExecutor.call("read", { filePath: filepath, hashCheckMode: true, limit: 1 }, { signal: ctx.abort })
    const stamp = RemoteExecutor.stamp(readResult.metadata.file) ?? (await RemoteExecutor.stat(filepath, executor).catch(() => undefined))
    const hashCode = RemoteExecutor.hashCode(readResult) ?? (executor === "local" ? await RemoteExecutor.fileHashCode(filepath).catch(() => undefined) : undefined)
    const entry =
      stamp?.kind === "file" && hashCode
        ? SessionFileRead.touch({ sessionID: ctx.sessionID, executor, file: stamp, hashCode, filePath: filepath })
        : undefined
    if (!entry) throw new Error(`Failed to register file reference for ${filepath}`)
    const label = SessionFileRead.label(entry)
    output += `\n<fileRef>${label}</fileRef>`

    return {
      title: label,
      metadata: {
        diagnostics,
        filepath,
        exists: false,
        diff,
        fileRef: label,
        smallHashCode: entry.smallHashCode,
      },
      output,
    }
  },
})
