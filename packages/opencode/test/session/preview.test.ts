import { describe, expect, test } from "bun:test"
import { Preview } from "../../src/session/preview"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { MessageV2 } from "../../src/session/message-v2"

const ids = {
  sessionID: SessionID.make("ses_preview"),
  messageID: MessageID.make("msg_preview"),
  id: PartID.make("prt_preview"),
}

describe("session preview", () => {
  test("does not inject truncation notes into diff metadata", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 0000000..1111111 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      `-${"a".repeat(5000)}`,
      `+${"b".repeat(5000)}`,
    ].join("\n")
    const part: MessageV2.ToolPart = {
      ...ids,
      type: "tool",
      callID: "call_preview",
      tool: "FileAction",
      state: {
        status: "completed",
        input: { filePath: "a.txt" },
        output: "ok",
        title: "FileAction",
        metadata: {
          diff,
          files: [{ diff }],
          note: "x".repeat(5000),
        },
        time: { start: 1, end: 2 },
      },
    }

    const next = Preview.part(part)
    if (next.state.status !== "completed") throw new Error("expected completed")
    expect(next.state.metadata.diff).toBe(diff)
    expect(next.state.metadata.files[0].diff).toBe(diff)
    expect(next.state.metadata.note).toContain("preview truncated")
  })
})
