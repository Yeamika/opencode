import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { Filesystem } from "../util/filesystem"
import { RemoteExecutor } from "./remote_executor"
import { Instruction } from "../session/instruction"
import { SessionFileRead } from "../session/file-read"

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file or directory to read"),
    mode: z
      .enum(["text", "binary"])
      .optional()
      .describe("Read mode. Defaults to text. Binary mode returns a hex dump and reads at most 128 bytes."),
    offset: z.coerce
      .number()
      .describe("Text mode: 1-based line offset. Binary mode: 0-based byte offset.")
      .optional(),
    limit: z.coerce
      .number()
      .describe("Text mode: maximum lines to read (defaults to 2000). Binary mode: maximum bytes to read, capped by REC.")
      .optional(),
    executor: z.string().optional().describe("RemoteExecutor executor id. Defaults to local."),
  }),
  async execute(params, ctx) {
    if (params.offset !== undefined) {
      if (params.mode === "binary") {
        if (params.offset < 0) throw new Error("binary offset must be greater than or equal to 0")
      } else if (params.offset < 1) {
        throw new Error("offset must be greater than or equal to 1")
      }
    }
    const executor = params.executor?.trim() || "local"
    const local = executor === "local"
    const file = local
      ? path.isAbsolute(params.filePath)
        ? params.filePath
        : path.resolve(Instance.directory, params.filePath)
      : params.filePath
    const filepath = local && process.platform === "win32" ? Filesystem.normalizePath(file) : file
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

    if (local && params.mode !== "binary" && stat && !stat.isDirectory()) {
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

    const remoteStamp = !local ? await RemoteExecutor.stat(filepath, executor) : undefined
    const shouldHash = local ? Boolean(stat && !stat.isDirectory()) : remoteStamp?.kind === "file"

    const result = await RemoteExecutor.call(
      "read",
      {
        filePath: filepath,
        ...(shouldHash ? { hashCheckMode: true } : {}),
        ...(params.mode === undefined ? {} : { mode: params.mode }),
        ...(params.offset === undefined ? {} : { offset: params.offset }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(local ? {} : { executor }),
      },
      { signal: ctx.abort },
    )
    const stamp = RemoteExecutor.stamp(result.metadata.file) ?? remoteStamp ?? (shouldHash ? await RemoteExecutor.stat(filepath, executor).catch(() => undefined) : undefined)
    const hashCode = RemoteExecutor.hashCode(result) ?? (local && shouldHash ? await RemoteExecutor.fileHashCode(filepath).catch(() => undefined) : undefined)
    if (stamp?.kind === "file" && hashCode) {
      const entry = SessionFileRead.touch({ sessionID: ctx.sessionID, executor, file: stamp, hashCode, filePath: filepath })
      return {
        ...result,
        output: `${result.output}\n<fileRef>${SessionFileRead.label(entry)}</fileRef>`,
        metadata: {
          ...result.metadata,
          fileRef: SessionFileRead.label(entry),
          smallHashCode: entry.smallHashCode,
        },
      }
    }
    return result
  },
})
