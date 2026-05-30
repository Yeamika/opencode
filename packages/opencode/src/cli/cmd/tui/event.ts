import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "@/session/schema"
import z from "zod"

export const TuiEvent = {
  PromptAppend: BusEvent.define("tui.prompt.append", z.object({ text: z.string() })),
  CommandExecute: BusEvent.define(
    "tui.command.execute",
    z.object({
      command: z.union([
        z.enum([
          "session.list",
          "session.new",
          "session.interrupt",
          "session.compact",
          "session.page.up",
          "session.page.down",
          "session.line.up",
          "session.line.down",
          "session.half.page.up",
          "session.half.page.down",
          "session.first",
          "session.last",
          "prompt.clear",
          "prompt.submit",
          "agent.cycle",
        ]),
        z.string(),
      ]),
    }),
  ),
  ToastShow: BusEvent.define(
    "tui.toast.show",
    z.object({
      title: z.string().optional(),
      message: z.string(),
      variant: z.enum(["info", "success", "warning", "error"]),
      duration: z.number().default(5000).optional().describe("Duration in milliseconds"),
    }),
  ),
  SessionSelect: BusEvent.define(
    "tui.session.select",
    z.object({
      sessionID: SessionID.zod.describe("Session ID to navigate to"),
      displayID: z.string().describe("TUI display ID to target"),
      directory: z.string().optional().describe("Directory to switch the targeted TUI into before opening the session"),
      requestID: z.string().optional().describe("Request identifier used to acknowledge delivery of the control event"),
    }),
  ),
  TUIAttachTOrunningsession: BusEvent.define(
    "tui.attach-to-running-session",
    z.object({
      sessionID: SessionID.zod.describe("Session ID to attach the targeted display to"),
      displayID: z.string().describe("TUI display ID to target"),
      directory: z.string().optional().describe("Directory of the target running session"),
      workspaceID: z.string().optional().describe("Workspace ID of the target running session, when present"),
      requestID: z.string().optional().describe("Request identifier used to acknowledge delivery of the control event"),
    }),
  ),
  DisplayReport: BusEvent.define(
    "tui.display.report",
    z.object({
      displayID: z.string().describe("TUI display ID that is reporting status"),
      directory: z.string().optional().describe("Current directory visible to this display"),
      sessionID: SessionID.zod.optional().describe("Current session shown in this display, if any"),
    }),
  ),
}
