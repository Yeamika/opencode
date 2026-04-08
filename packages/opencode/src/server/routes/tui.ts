import { Hono, type Context } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { randomUUID } from "node:crypto"
import { Bus } from "../../bus"
import { Session } from "../../session"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { AsyncQueue } from "../../util/queue"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

const TuiRequest = z.object({
  path: z.string(),
  body: z.any(),
})

type TuiRequest = z.infer<typeof TuiRequest>

const request = new AsyncQueue<TuiRequest>()
const response = new AsyncQueue<any>()
const pendingAcks = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

function waitForAck(requestID: string, timeoutMs = 5000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(requestID)
      reject(new Error(`Timed out waiting for TUI ack: ${requestID}`))
    }, timeoutMs)
    pendingAcks.set(requestID, { resolve, reject, timer })
  })
}

function resolveAck(requestID: string) {
  const pending = pendingAcks.get(requestID)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingAcks.delete(requestID)
  pending.resolve()
  return true
}

export async function callTui(ctx: Context) {
  const body = await ctx.req.json()
  request.push({
    path: ctx.req.path,
    body,
  })
  return response.next()
}

const TuiControlRoutes = new Hono()
  .get(
    "/next",
    describeRoute({
      summary: "Get next TUI request",
      description: "Retrieve the next TUI (Terminal User Interface) request from the queue for processing.",
      operationId: "tui.control.next",
      responses: {
        200: {
          description: "Next TUI request",
          content: {
            "application/json": {
              schema: resolver(TuiRequest),
            },
          },
        },
      },
    }),
    async (c) => {
      const req = await request.next()
      return c.json(req)
    },
  )
  .post(
    "/response",
    describeRoute({
      summary: "Submit TUI response",
      description: "Submit a response to the TUI request queue to complete a pending request.",
      operationId: "tui.control.response",
      responses: {
        200: {
          description: "Response submitted successfully",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
      },
    }),
    validator("json", z.any()),
    async (c) => {
      const body = c.req.valid("json")
      response.push(body)
      return c.json(true)
    },
  )

export const TuiRoutes = lazy(() =>
  new Hono()
    .post(
      "/append-prompt",
      describeRoute({
        summary: "Append TUI prompt",
        description: "Append prompt to the TUI",
        operationId: "tui.appendPrompt",
        responses: {
          200: {
            description: "Prompt processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", TuiEvent.PromptAppend.properties),
      async (c) => {
        await Bus.publish(TuiEvent.PromptAppend, c.req.valid("json"))
        return c.json(true)
      },
    )
    .post(
      "/open-help",
      describeRoute({
        summary: "Open help dialog",
        description: "Open the help dialog in the TUI to display user assistance information.",
        operationId: "tui.openHelp",
        responses: {
          200: {
            description: "Help dialog opened successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Bus.publish(TuiEvent.CommandExecute, {
          command: "help.show",
        })
        return c.json(true)
      },
    )
    .post(
      "/open-sessions",
      describeRoute({
        summary: "Open sessions dialog",
        description: "Open the session dialog",
        operationId: "tui.openSessions",
        responses: {
          200: {
            description: "Session dialog opened successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Bus.publish(TuiEvent.CommandExecute, {
          command: "session.list",
        })
        return c.json(true)
      },
    )
    .post(
      "/open-themes",
      describeRoute({
        summary: "Open themes dialog",
        description: "Open the theme dialog",
        operationId: "tui.openThemes",
        responses: {
          200: {
            description: "Theme dialog opened successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Bus.publish(TuiEvent.CommandExecute, {
          command: "session.list",
        })
        return c.json(true)
      },
    )
    .post(
      "/open-models",
      describeRoute({
        summary: "Open models dialog",
        description: "Open the model dialog",
        operationId: "tui.openModels",
        responses: {
          200: {
            description: "Model dialog opened successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Bus.publish(TuiEvent.CommandExecute, {
          command: "model.list",
        })
        return c.json(true)
      },
    )
    .post(
      "/submit-prompt",
      describeRoute({
        summary: "Submit TUI prompt",
        description: "Submit the prompt",
        operationId: "tui.submitPrompt",
        responses: {
          200: {
            description: "Prompt submitted successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Bus.publish(TuiEvent.CommandExecute, {
          command: "prompt.submit",
        })
        return c.json(true)
      },
    )
    .post(
      "/clear-prompt",
      describeRoute({
        summary: "Clear TUI prompt",
        description: "Clear the prompt",
        operationId: "tui.clearPrompt",
        responses: {
          200: {
            description: "Prompt cleared successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Bus.publish(TuiEvent.CommandExecute, {
          command: "prompt.clear",
        })
        return c.json(true)
      },
    )
    .post(
      "/execute-command",
      describeRoute({
        summary: "Execute TUI command",
        description: "Execute a TUI command (e.g. agent_cycle)",
        operationId: "tui.executeCommand",
        responses: {
          200: {
            description: "Command executed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ command: z.string() })),
      async (c) => {
        const command = c.req.valid("json").command
        await Bus.publish(TuiEvent.CommandExecute, {
          // @ts-expect-error
          command: {
            session_new: "session.new",
            session_share: "session.share",
            session_interrupt: "session.interrupt",
            session_compact: "session.compact",
            messages_page_up: "session.page.up",
            messages_page_down: "session.page.down",
            messages_line_up: "session.line.up",
            messages_line_down: "session.line.down",
            messages_half_page_up: "session.half.page.up",
            messages_half_page_down: "session.half.page.down",
            messages_first: "session.first",
            messages_last: "session.last",
            agent_cycle: "agent.cycle",
          }[command],
        })
        return c.json(true)
      },
    )
    .post(
      "/show-toast",
      describeRoute({
        summary: "Show TUI toast",
        description: "Show a toast notification in the TUI",
        operationId: "tui.showToast",
        responses: {
          200: {
            description: "Toast notification shown successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("json", TuiEvent.ToastShow.properties),
      async (c) => {
        await Bus.publish(TuiEvent.ToastShow, c.req.valid("json"))
        return c.json(true)
      },
    )
    .post(
      "/publish",
      describeRoute({
        summary: "Publish TUI event",
        description: "Publish a TUI event",
        operationId: "tui.publish",
        responses: {
          200: {
            description: "Event published successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.union(
          Object.values(TuiEvent).map((def) => {
            return z
              .object({
                type: z.literal(def.type),
                properties: def.properties,
              })
              .meta({
                ref: "Event" + "." + def.type,
              })
          }),
        ),
      ),
      async (c) => {
        const evt = c.req.valid("json")
        await Bus.publish(Object.values(TuiEvent).find((def) => def.type === evt.type)!, evt.properties)
        return c.json(true)
      },
    )
    .post(
      "/ack",
      describeRoute({
        summary: "Acknowledge TUI control delivery",
        description: "Used by a TUI client to acknowledge that it received a directed control event.",
        operationId: "tui.ack",
        responses: {
          200: {
            description: "Ack accepted",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          requestID: z.string(),
          displayID: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        if (!resolveAck(body.requestID)) return c.json(false, 400)
        return c.json(true)
      },
    )
    .post(
      "/select-session",
      describeRoute({
        summary: "Select session",
        description: "Navigate the targeted TUI display to the specified session.",
        operationId: "tui.selectSession",
        responses: {
          200: {
            description: "Session selected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", TuiEvent.SessionSelect.properties),
      async (c) => {
        const body = c.req.valid("json")
        await Session.get(body.sessionID)
        const directory = c.req.query("directory") || c.req.header("x-opencode-directory")
        const requestID = randomUUID()
        await Bus.publish(TuiEvent.SessionSelect, {
          ...body,
          directory: directory || undefined,
          requestID,
        })
        try {
          await waitForAck(requestID)
        } catch (error) {
          return c.json({ ok: false, error: String(error instanceof Error ? error.message : error) }, 504)
        }
        return c.json(true)
      },
    )
    .post(
      "/attach-to-running-session",
      describeRoute({
        summary: "Attach display to running session",
        description:
          "Switch the targeted TUI display to a running session and proactively align its directory/workspace before navigation.",
        operationId: "tui.attachToRunningSession",
        responses: {
          200: {
            description: "Attach request published successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "json",
        z.object({
          sessionID: TuiEvent.TUIAttachTOrunningsession.properties.shape.sessionID,
          displayID: TuiEvent.TUIAttachTOrunningsession.properties.shape.displayID,
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const session = await Session.get(body.sessionID)
        const requestID = randomUUID()
        await Bus.publish(TuiEvent.TUIAttachTOrunningsession, {
          sessionID: body.sessionID,
          displayID: body.displayID,
          directory: session.directory,
          workspaceID: session.workspaceID,
          requestID,
        })
        try {
          await waitForAck(requestID)
        } catch (error) {
          return c.json({ ok: false, error: String(error instanceof Error ? error.message : error) }, 504)
        }
        return c.json(true)
      },
    )
    .route("/control", TuiControlRoutes),
)
