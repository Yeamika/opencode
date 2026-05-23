import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { assertExternalDirectory } from "./external-directory"
import { RemoteExecutor } from "./remote_executor"

export const RgTool = Tool.define("rg", {
  description: [
    "Ripgrep-style search powered by the private RemoteExecutor backend.",
    "Use this instead of grep. It supports the common grep workflow plus raw rg-like matches with optional root, path, globs, case sensitivity, and max count.",
    "For compatibility with the old grep tool, include is accepted as a single glob filter when globs is omitted.",
    "Requires experimental.remote_executor.enabled; permission is checked with the existing grep permission key.",
  ].join("\n"),
  parameters: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    root: z.string().optional().describe("Root directory for the search. Defaults to the current workspace directory."),
    path: z.string().optional().describe("File or directory to search, relative to root unless absolute."),
    include: z.string().optional().describe("Compatibility alias for a single glob filter, for example '*.js' or '*.{ts,tsx}'. Ignored when globs is provided."),
    globs: z.array(z.string()).optional().describe("Optional glob filters, for example ['*.ts', 'src/**']."),
    case_sensitive: z.boolean().optional().describe("Whether matching is case-sensitive. Defaults to true."),
    max_count: z.number().int().positive().optional().describe("Maximum number of matches to return."),
    executor: z.string().optional().describe("RemoteExecutor executor id. Defaults to local."),
  }),
  async execute(params, ctx) {
    if (!params.pattern) throw new Error("pattern is required")

    const root = params.root
      ? path.isAbsolute(params.root)
        ? params.root
        : path.resolve(Instance.directory, params.root)
      : Instance.directory
    const target = params.path
      ? path.isAbsolute(params.path)
        ? params.path
        : path.resolve(root, params.path)
      : root

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        root,
        path: params.path,
        globs: params.globs ?? (params.include === undefined ? undefined : [params.include]),
        case_sensitive: params.case_sensitive,
        max_count: params.max_count,
      },
    })

    await assertExternalDirectory(ctx, root, { kind: "directory" })
    await assertExternalDirectory(ctx, target, { kind: Filesystem.stat(target)?.isDirectory() ? "directory" : "file" })

    if (!(await RemoteExecutor.enabled())) {
      throw new Error("rg requires experimental.remote_executor.enabled")
    }

    return RemoteExecutor.call(
      "rg",
      {
        pattern: params.pattern,
        root,
        ...(params.path === undefined ? {} : { path: params.path }),
        ...(params.globs === undefined && params.include === undefined ? {} : { globs: params.globs ?? [params.include] }),
        ...(params.case_sensitive === undefined ? {} : { case_sensitive: params.case_sensitive }),
        ...(params.max_count === undefined ? {} : { max_count: params.max_count }),
        ...(params.executor === undefined ? {} : { executor: params.executor }),
      },
      { signal: ctx.abort },
    )
  },
})
