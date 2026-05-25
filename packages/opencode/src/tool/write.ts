import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { trimDiff } from "./edit"
import { assertExternalDirectory } from "./external-directory"
import { RemoteExecutor } from "./remote_executor"

const MAX_DIAGNOSTICS_PER_FILE = 20
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z.object({
    content: z.string().describe("The content to write to the file"),
    filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
    executor: z.string().optional().describe("RemoteExecutor executor id. Defaults to local."),
  }),
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    const executor = params.executor?.trim() || "local"
    if (executor !== "local") {
      const result = await RemoteExecutor.call(
        "apply_patch",
        { patchText: RemoteExecutor.patch(filepath, "", params.content, false), executor },
        { signal: ctx.abort },
      )
      const next = await RemoteExecutor.stat(filepath, executor).catch(() => undefined)
      await FileTime.read(ctx.sessionID, filepath, next ? { executor, file: next } : undefined)
      return {
        ...result,
        metadata: {
          ...result.metadata,
          diagnostics: {},
          filepath,
          exists: next ? next.kind !== "missing" : undefined,
        },
      }
    }

    await assertExternalDirectory(ctx, filepath)

    const stat = await RemoteExecutor.stat(filepath, executor).catch(() => undefined)
    const local = await Filesystem.exists(filepath)
    const exists = stat ? stat.kind !== "missing" : local
    const contentOld = local ? await Filesystem.readText(filepath) : ""
    if (exists) await FileTime.assert(ctx.sessionID, filepath, stat ? { executor, file: stat } : undefined)

    const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, filepath)],
      always: ["*"],
      metadata: {
        filepath,
        diff,
      },
    })

    await RemoteExecutor.call(
      "apply_patch",
      {
        patchText: RemoteExecutor.patch(filepath, contentOld, params.content, exists),
        ...(params.executor === undefined ? {} : { executor: params.executor }),
      },
      { signal: ctx.abort },
    )
    Bus.publish(File.Event.Edited, { file: filepath })
    await Bus.publish(FileWatcher.Event.Updated, {
      file: filepath,
      event: exists ? "change" : "add",
    })
    const next = await RemoteExecutor.stat(filepath, executor).catch(() => undefined)
    await FileTime.read(ctx.sessionID, filepath, next ? { executor, file: next } : undefined)

    let output = "Wrote file successfully."
    await LSP.touchFile(filepath, true)
    const diagnostics = await LSP.diagnostics()
    const normalizedFilepath = Filesystem.normalizePath(filepath)
    let projectDiagnosticsCount = 0
    for (const [file, issues] of Object.entries(diagnostics)) {
      const errors = issues.filter((item) => item.severity === 1)
      if (errors.length === 0) continue
      const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const suffix =
        errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
      if (file === normalizedFilepath) {
        output += `\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${filepath}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
        continue
      }
      if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
      projectDiagnosticsCount++
      output += `\n\nLSP errors detected in other files:\n<diagnostics file="${file}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
    }

    return {
      title: path.relative(Instance.worktree, filepath),
      metadata: {
        diagnostics,
        filepath,
        exists: exists,
      },
      output,
    }
  },
})
