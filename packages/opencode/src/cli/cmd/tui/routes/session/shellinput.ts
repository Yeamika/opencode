type Input = {
  mode?: "run" | "shell" | "attach" | "list" | "stop" | "remove"
  command?: string
  description?: string
  workdir?: string
  asyncID?: string
  text?: string
  filePath?: string
}

export function shellinput(input: Input, norm: (value?: string) => string) {
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

  if (input.mode === undefined || input.mode === "run" || input.mode === "shell") {
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

  const next = text(input.text)
  const path = file(input.filePath)

  return {
    icon: "<==",
    mode: input.mode,
    command: next ?? (path ? `[file] ${path}` : "[attach]"),
    description: next ? "Attach async text input" : path ? "Attach async file input" : "Attach async run",
  }
}
