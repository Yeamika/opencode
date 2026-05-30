import z from "zod"
import { Tool } from "./tool"
import { EditTool } from "./edit"
import DESCRIPTION from "./multiedit.txt"
import path from "path"
import { Instance } from "../project/instance"

export const MultiEditTool = Tool.define("multiedit", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe('The file reference returned by read, for example "App.ts #A1B2"'),
    edits: z
      .array(
        z.object({
          filePath: z.string().optional().describe("Deprecated; ignored. Use the top-level filePath."),
          oldString: z.string().describe("The text to replace"),
          newString: z.string().describe("The text to replace it with (must be different from oldString)"),
          replaceAll: z.boolean().optional().describe("Replace all occurrences of oldString (default false)"),
        }),
      )
      .describe("Array of edit operations to perform sequentially on the file"),
  }),
  async execute(params, ctx) {
    const tool = await EditTool.init()
    const results = []
    let currentFilePath = params.filePath
    for (const [, edit] of params.edits.entries()) {
      const result = await tool.execute(
        {
          filePath: currentFilePath,
          oldString: edit.oldString,
          newString: edit.newString,
          replaceAll: edit.replaceAll,
        },
        ctx,
      )
      results.push(result)
      if (typeof result.metadata.fileRef === "string") currentFilePath = result.metadata.fileRef
    }
    return {
      title: currentFilePath.includes(" #") ? currentFilePath : path.relative(Instance.worktree, currentFilePath),
      metadata: {
        results: results.map((r) => r.metadata),
        fileRef: currentFilePath,
      },
      output: results.at(-1)!.output,
    }
  },
})
