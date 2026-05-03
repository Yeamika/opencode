import { afterEach, describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { TuiEvent } from "../../src/cli/cmd/tui/event"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tui.selectSession endpoint", () => {
  test("should return 200 when called with valid session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // #given
        const session = await Session.create({})

        // #when
        const app = Server.Default()
        const event = new Promise<{ requestID?: string; displayID?: string }>((resolve) => {
          const unsub = Bus.subscribe(TuiEvent.SessionSelect, (evt) => {
            unsub()
            resolve(evt.properties)
            return "done"
          })
        })
        const pending = app.request(`/tui/select-session?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, displayID: "tui_test1234" }),
        })
        const evt = await event
        const ack = await app.request("/tui/ack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestID: evt.requestID, displayID: evt.displayID }),
        })
        expect(ack.status).toBe(200)
        const response = await pending

        // #then
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("should return 404 when session does not exist", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // #given
        const nonExistentSessionID = "ses_nonexistent123"

        // #when
        const app = Server.Default()
        const response = await app.request("/tui/select-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: nonExistentSessionID, displayID: "tui_test1234" }),
        })

        // #then
        expect(response.status).toBe(404)
      },
    })
  })

  test("should return 400 when session ID format is invalid", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // #given
        const invalidSessionID = "invalid_session_id"

        // #when
        const app = Server.Default()
        const response = await app.request("/tui/select-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: invalidSessionID, displayID: "tui_test1234" }),
        })

        // #then
        expect(response.status).toBe(400)
      },
    })
  })

  test("should return 400 when display ID is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const app = Server.Default()
        const response = await app.request("/tui/select-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })

        expect(response.status).toBe(400)

        await Session.remove(session.id)
      },
    })
  })

  test("should publish targeted display selection", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        const event = new Promise<{ sessionID: string; displayID?: string; directory?: string; requestID?: string }>((resolve) => {
          const unsub = Bus.subscribe(TuiEvent.SessionSelect, (evt) => {
            unsub()
            resolve(evt.properties)
            return "done"
          })
        })

        const pending = app.request(`/tui/select-session?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, displayID: "tui_test1234" }),
        })
        const evt = await event
        const ack = await app.request("/tui/ack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestID: evt.requestID, displayID: evt.displayID }),
        })
        expect(ack.status).toBe(200)
        const response = await pending

        expect(response.status).toBe(200)
        expect(evt).toEqual({
          sessionID: session.id,
          displayID: "tui_test1234",
          directory: tmp.path,
          requestID: evt.requestID,
        })

        await Session.remove(session.id)
      },
    })
  })
})
