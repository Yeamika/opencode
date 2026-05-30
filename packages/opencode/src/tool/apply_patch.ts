import z from "zod"
import * as path from "path"
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
      await ctx.ask({
        permission: "edit",
        patterns: [path.relative(Instance.worktree, filePath)],
        always: ["*"],
        metadata: { filepath: filePath, diff: params.patchText },
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
    const files = file ? [file] : []

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
        diff: typeof result.metadata.diff === "string" ? result.metadata.diff : (file?.diff ?? ""),
        files,
        diagnostics,
        fileRef: label,
        smallHashCode: next?.smallHashCode ?? entry.smallHashCode,
      },
    }
  },
})
