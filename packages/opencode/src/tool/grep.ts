import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./grep.txt"
import { Instance } from "../project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"
import { RemoteExecutor } from "./remote_executor"

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
    executor: z.string().optional().describe("RemoteExecutor executor id. Defaults to local."),
  }),
  async execute(params, ctx) {
    if (!params.pattern) throw new Error("pattern is required")
    const executor = params.executor?.trim() || "local"
    const local = executor === "local"

    if (local) {
      await ctx.ask({
        permission: "grep",
        patterns: [params.pattern],
        always: ["*"],
        metadata: {
          pattern: params.pattern,
          path: params.path,
          include: params.include,
        },
      })
    }

    const search = local
      ? path.isAbsolute(params.path ?? Instance.directory)
        ? (params.path ?? Instance.directory)
        : path.resolve(Instance.directory, params.path!)
      : params.path
    if (local) await assertExternalDirectory(ctx, search, { kind: "directory" })

    const result = await RemoteExecutor.call(
      "grep",
      {
        pattern: params.pattern,
        ...(search === undefined ? {} : { path: search }),
        ...(params.include === undefined ? {} : { include: params.include }),
        ...(local ? {} : { executor }),
      },
      { signal: ctx.abort },
    )
    return {
      ...result,
      metadata: {
        matches: typeof result.metadata.matches === "number" ? result.metadata.matches : 0,
        truncated: result.metadata.truncated === true,
      },
    }
  },
})
