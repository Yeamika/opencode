import { parsePatch } from "diff"

export function preview(input: Record<string, unknown>, filename = "file") {
  const mode = typeof input.mode === "string" ? input.mode : "patch"
  if (mode !== "patch") return ""
  if ((input.patchMode ?? "text") === "binary") return ""

  const text = typeof input.patchText === "string" ? input.patchText.trimEnd() : ""
  if (!text) return ""

  const trimmed = text.trimStart()
  const diff = trimmed.startsWith("@@")
    ? `--- ${filename}\n+++ ${filename}\n${trimmed}`
    : trimmed.startsWith("--- ") || trimmed.startsWith("diff --git ")
      ? trimmed
      : ""
  if (!diff) return ""

  return valid(fix(diff))
}

function fix(text: string) {
  const lines = text.split("\n")
  const result: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.startsWith("@@")) {
      result.push(line)
      continue
    }

    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (!match) return text

    const body: string[] = []
    let old = 0
    let next = 0

    for (i++; i < lines.length; i++) {
      const item = lines[i]!
      if (item.startsWith("@@") || item.startsWith("diff --git ")) {
        i--
        break
      }
      body.push(item)
      if (item.startsWith(" ")) {
        old++
        next++
        continue
      }
      if (item.startsWith("-")) {
        old++
        continue
      }
      if (item.startsWith("+")) next++
    }

    result.push(`@@ -${match[1]},${old} +${match[2]},${next} @@${match[3]}`)
    result.push(...body)
  }

  return result.join("\n")
}

function valid(text: string) {
  try {
    parsePatch(text)
    return text
  } catch {
    return ""
  }
}
