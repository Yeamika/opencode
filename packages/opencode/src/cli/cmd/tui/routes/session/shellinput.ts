import { BashTool } from "@/tool/bash"
import { ExBashTool } from "@/tool/exbash"
import type { Tool } from "@/tool/tool"

type Input = Partial<Tool.InferParameters<typeof BashTool>> | Partial<Tool.InferParameters<typeof ExBashTool>>
type Legacy = {
  mode?: "control"
  action?: "stop" | "remove"
  asyncID?: string
  command?: string
  description?: string
  workdir?: string
  text?: string
  filePath?: string
}

export function shellinput(input: Input | Legacy, norm: (value?: string) => string) {
  const text = (value?: string) => {
    if (!value?.trim()) return
    const next = value.replace(/\s+/g, " ").trim()
    if (next.length <= 24) return next
    return next.slice(0, 21) + "..."
  }

  const file = (value?: string) => {
    if (!value?.trim()) return
    return norm(value)
  }

  if (!("mode" in input)) {
    return {
      icon: "$",
      mode: undefined,
      command: (input as Partial<Tool.InferParameters<typeof BashTool>>).command,
      description: (input as Partial<Tool.InferParameters<typeof BashTool>>).description,
      workdir: (input as Partial<Tool.InferParameters<typeof BashTool>>).workdir,
    }
  }

  if (input.mode === undefined || input.mode === "run") {
    return {
      icon: "$",
      mode: input.mode,
      command: input.command,
      description: input.description,
      workdir: input.workdir,
    }
  }

  if (input.mode === "list") {
    return {
      icon: "≡",
      mode: input.mode,
      command: input.asyncID ?? "all",
      description: "List async runs",
    }
  }

  if (input.mode === "stop" || input.mode === "remove") {
    return {
      icon: input.mode === "remove" ? "✕" : "■",
      mode: input.mode,
      command: input.asyncID,
      description: input.mode === "remove" ? "Remove async task" : "Stop async task",
    }
  }

  if (input.mode === "control") {
    return {
      icon: input.action === "remove" ? "✕" : "■",
      mode: input.mode,
      command: input.asyncID,
      description: input.action === "remove" ? "Remove async task" : "Stop async task",
    }
  }

  const next = text(input.text)
  const path = file(input.filePath)

  return {
    icon: "<==",
    mode: input.mode,
    command: next ?? (path ? `[file] ${path}` : "[attach]"),
    description: next ? "Attach async text input" : path ? "Attach async file input" : "Attach async run",
  }
}
