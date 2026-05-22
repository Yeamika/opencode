import z from "zod"
import path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./glob.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { RemoteExecutor } from "./remote_executor"

export const GlobTool = Tool.define("glob", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z
      .string()
      .optional()
      .describe(
        `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
      ),
    executor: z.string().optional().describe("RemoteExecutor executor id. Defaults to local."),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "glob",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
      },
    })

    const search = path.isAbsolute(params.path ?? Instance.directory)
      ? (params.path ?? Instance.directory)
      : path.resolve(Instance.directory, params.path!)
    await assertExternalDirectory(ctx, search, { kind: "directory" })

    const result = await RemoteExecutor.call(
      "glob",
      {
        pattern: params.pattern,
        path: search,
        ...(params.executor === undefined ? {} : { executor: params.executor }),
      },
      { signal: ctx.abort },
    )
    return {
      ...result,
      metadata: {
        count: typeof result.metadata.count === "number" ? result.metadata.count : 0,
        truncated: result.metadata.truncated === true,
      },
    }
  },
})
