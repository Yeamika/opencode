import { afterEach, describe, expect, test } from "bun:test"
import z from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Instance } from "../../src/project/instance"
import { Reload } from "../../src/project/reload"
import { Server } from "../../src/server/server"
import { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const TestEvent = BusEvent.define("test.server.event-stream", z.object({ value: z.number() }))

function createReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const events: any[] = []
  let buffer = ""

  async function pump() {
    while (events.length === 0) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("event stream ended")

      buffer += decoder.decode(chunk.value, { stream: true })

      while (true) {
        const split = buffer.indexOf("\n\n")
        if (split === -1) break

        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")

        if (!data) continue
        events.push(JSON.parse(data))
      }
    }
  }

  return {
    async next(match: (event: any) => boolean, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (events.length === 0) {
          const remaining = deadline - Date.now()
          await Promise.race([
            pump(),
            Bun.sleep(Math.max(remaining, 1)).then(() => {
              throw new Error("timed out waiting for event")
            }),
          ])
        }

        while (events.length > 0) {
          const event = events.shift()
          if (match(event)) return event
        }
      }

      throw new Error("timed out waiting for matching event")
    },
    async close() {
      await reader.cancel()
    },
  }
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("event stream", () => {
  test("stays connected across soft reload and receives post-reload instance bus events", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const response = await app.request(`/event?directory=${encodeURIComponent(tmp.path)}`)

    expect(response.status).toBe(200)
    expect(response.body).toBeDefined()

    const stream = createReader(response.body!)

    try {
      await stream.next((event) => event.type === "server.connected")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Bus.publish(TestEvent, { value: 1 })
        },
      })

      expect(await stream.next((event) => event.type === TestEvent.type)).toEqual({
        type: TestEvent.type,
        properties: { value: 1 },
      })

      const sessionID = SessionID.make("session_reload-event")
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Reload.enter(Instance.directory, sessionID)
          try {
            void Reload.request(Instance.directory)
            Reload.arrive(Instance.directory, sessionID)
            await Reload.wait(Instance.directory, sessionID)
          } finally {
            Reload.leave(Instance.directory, sessionID)
          }
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Bus.publish(TestEvent, { value: 2 })
        },
      })

      expect(await stream.next((event) => event.type === TestEvent.type && event.properties.value === 2)).toEqual({
        type: TestEvent.type,
        properties: { value: 2 },
      })
    } finally {
      await stream.close()
    }
  })

})
