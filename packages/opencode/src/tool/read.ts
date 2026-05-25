import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { Filesystem } from "../util/filesystem"
import { RemoteExecutor } from "./remote_executor"
import { Instruction } from "../session/instruction"
import { FileTime } from "../file/time"

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file or directory to read"),
    offset: z.coerce.number().describe("The line number to start reading from (1-indexed)").optional(),
    limit: z.coerce.number().describe("The maximum number of lines to read (defaults to 2000)").optional(),
    executor: z.string().optional().describe("RemoteExecutor executor id. Defaults to local."),
  }),
  async execute(params, ctx) {
    if (params.offset !== undefined && params.offset < 1) {
      throw new Error("offset must be greater than or equal to 1")
    }
    const file = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(Instance.directory, params.filePath)
    const filepath = process.platform === "win32" ? Filesystem.normalizePath(file) : file
    const executor = params.executor?.trim() || "local"
    const local = executor === "local"
    const stat = local ? Filesystem.stat(filepath) : undefined

    if (local) {
      await assertExternalDirectory(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: stat?.isDirectory() ? "directory" : "file",
      })

      await ctx.ask({
        permission: "read",
        patterns: [filepath],
        always: ["*"],
        metadata: {},
      })
    }

    if (local && stat && !stat.isDirectory()) {
      const mime = Filesystem.mimeType(filepath)
      const image = mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
      const pdf = mime === "application/pdf"
      if (image || pdf) {
        if (pdf) throw new Error("PDF read is not supported yet")
        const msg = "Image read successfully"
        const instructions = await Instruction.resolve(ctx.messages, filepath, ctx.messageID)
        return {
          title: path.relative(Instance.worktree, filepath),
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
              url: `data:${mime};base64,${Buffer.from(await Filesystem.readBytes(filepath)).toString("base64")}`,
            },
          ],
        }
      }
    }

    const result = await RemoteExecutor.call(
      "read",
      {
        filePath: filepath,
        ...(params.offset === undefined ? {} : { offset: params.offset }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(local ? {} : { executor }),
      },
      { signal: ctx.abort },
    )
    const stamp = RemoteExecutor.stamp(result.metadata.file)
    if (stamp?.kind === "file") await FileTime.read(ctx.sessionID, filepath, { executor, file: stamp })
    else if (stat && !stat.isDirectory()) await FileTime.read(ctx.sessionID, filepath, { executor })
    return result
  },
})
