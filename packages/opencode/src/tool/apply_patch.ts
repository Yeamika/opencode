import z from "zod"
import * as path from "path"
import * as fs from "fs/promises"
import { Tool } from "./tool"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectory } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "../lsp"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"
import { RemoteExecutor } from "./remote_executor"

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
  patchText: z.string().describe("The full patch text that describes all changes to be made"),
  executor: z.string().optional().describe("RemoteExecutor executor id. Defaults to local."),
})

export const ApplyPatchTool = Tool.define("apply_patch", {
  description: DESCRIPTION,
  parameters: PatchParams,
  async execute(params, ctx) {
    if (!params.patchText) {
      throw new Error("patchText is required")
    }
    const executor = params.executor?.trim() || "local"
    if (executor !== "local") {
      const result = await RemoteExecutor.call("apply_patch", { patchText: params.patchText, executor }, { signal: ctx.abort })
      const files = Array.isArray(result.metadata.files) ? (result.metadata.files as ViewFile[]) : []
      return {
        ...result,
        metadata: {
          ...result.metadata,
          diff: typeof result.metadata.diff === "string" ? result.metadata.diff : "",
          files,
          diagnostics: {},
        },
      }
    }

    // Parse the patch to get hunks
    let hunks: Patch.Hunk[]
    try {
      const parseResult = Patch.parsePatch(params.patchText)
      hunks = parseResult.hunks
    } catch (error) {
      throw new Error(`apply_patch verification failed: ${error}`)
    }

    if (hunks.length === 0) {
      const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
      if (normalized === "*** Begin Patch\n*** End Patch") {
        throw new Error("patch rejected: empty patch")
      }
      throw new Error("apply_patch verification failed: no hunks found")
    }

    // Validate file paths and check permissions
    const fileChanges: Array<{
      filePath: string
      oldContent: string
      newContent: string
      type: "add" | "update" | "delete" | "move"
      movePath?: string
      diff: string
      additions: number
      deletions: number
    }> = []

    let totalDiff = ""

    for (const hunk of hunks) {
      const filePath = path.resolve(Instance.directory, hunk.path)
      await assertExternalDirectory(ctx, filePath)

      switch (hunk.type) {
        case "add": {
          const oldContent = ""
          const newContent =
            hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
          const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

          let additions = 0
          let deletions = 0
          for (const change of diffLines(oldContent, newContent)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }

          fileChanges.push({
            filePath,
            oldContent,
            newContent,
            type: "add",
            diff,
            additions,
            deletions,
          })

          totalDiff += diff + "\n"
          break
        }

        case "update": {
          // Check if file exists for update
          const stats = await fs.stat(filePath).catch(() => null)
          if (!stats || stats.isDirectory()) {
            throw new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`)
          }

          const oldContent = await fs.readFile(filePath, "utf-8")
          let newContent = oldContent

          // Apply the update chunks to get new content
          try {
            const fileUpdate = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks)
            newContent = fileUpdate.content
          } catch (error) {
            throw new Error(`apply_patch verification failed: ${error}`)
          }

          const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

          let additions = 0
          let deletions = 0
          for (const change of diffLines(oldContent, newContent)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }

          const movePath = hunk.move_path ? path.resolve(Instance.directory, hunk.move_path) : undefined
          await assertExternalDirectory(ctx, movePath)

          fileChanges.push({
            filePath,
            oldContent,
            newContent,
            type: hunk.move_path ? "move" : "update",
            movePath,
            diff,
            additions,
            deletions,
          })

          totalDiff += diff + "\n"
          break
        }

        case "delete": {
          const contentToDelete = await fs.readFile(filePath, "utf-8").catch((error) => {
            throw new Error(`apply_patch verification failed: ${error}`)
          })
          const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

          const deletions = contentToDelete.split("\n").length

          fileChanges.push({
            filePath,
            oldContent: contentToDelete,
            newContent: "",
            type: "delete",
            diff: deleteDiff,
            additions: 0,
            deletions,
          })

          totalDiff += deleteDiff + "\n"
          break
        }
      }
    }

    // Build per-file metadata for UI rendering (used for both permission and result)
    const files = fileChanges.map((change) => ({
      filePath: change.filePath,
      relativePath: path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
      type: change.type,
      diff: change.diff,
      before: change.oldContent,
      after: change.newContent,
      additions: change.additions,
      deletions: change.deletions,
      movePath: change.movePath,
    }))

    // Check permissions if needed
    const relativePaths = fileChanges.map((c) => path.relative(Instance.worktree, c.filePath).replaceAll("\\", "/"))
    await ctx.ask({
      permission: "edit",
      patterns: relativePaths,
      always: ["*"],
      metadata: {
        filepath: relativePaths.join(", "),
        diff: totalDiff,
        files,
      },
    })

    const result = await RemoteExecutor.call(
      "apply_patch",
      {
        patchText: params.patchText,
        ...(params.executor === undefined ? {} : { executor: params.executor }),
      },
      { signal: ctx.abort },
    )

    for (const change of fileChanges) {
      if (change.type === "delete") continue
      const target = change.movePath ?? change.filePath
      Bus.publish(File.Event.Edited, { file: target })
      await LSP.touchFile(target, true)
    }

    for (const change of fileChanges) {
      if (change.type === "add") await Bus.publish(FileWatcher.Event.Updated, { file: change.filePath, event: "add" })
      if (change.type === "update") await Bus.publish(FileWatcher.Event.Updated, { file: change.filePath, event: "change" })
      if (change.type === "move" && change.movePath) {
        await Bus.publish(FileWatcher.Event.Updated, { file: change.filePath, event: "unlink" })
        await Bus.publish(FileWatcher.Event.Updated, { file: change.movePath, event: "add" })
      }
      if (change.type === "delete") await Bus.publish(FileWatcher.Event.Updated, { file: change.filePath, event: "unlink" })
    }

    const diagnostics = await LSP.diagnostics()

    return {
      ...result,
      metadata: {
        ...result.metadata,
        diff: totalDiff,
        files,
        diagnostics,
      },
    }
  },
})
