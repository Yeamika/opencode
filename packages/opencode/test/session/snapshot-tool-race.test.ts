/**
 * Reproducer for snapshot race condition with instant tool execution.
 *
 * When the mock LLM returns a tool call response instantly, the AI SDK
 * processes the tool call and executes the tool (e.g. apply_patch) before
 * the processor's start-step handler can capture a pre-tool snapshot.
 * Both the "before" and "after" snapshots end up with the same git tree
 * hash, so computeDiff returns empty and the session summary shows 0 files.
 *
 * This is a real bug: the snapshot system assumes it can capture state
 * before tools run by hooking into start-step, but the AI SDK executes
 * tools internally during multi-step processing before emitting events.
 */
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

Log.init({ print: false })
const it = testEffect(Layer.mergeAll(TestLLMServer.layer, CrossSpawnSpawner.defaultLayer))

const providerCfg = (url: string) => ({
  snapshot: true,
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: url,
      },
    },
  },
})

it.live("tool execution produces non-empty session diff (snapshot race)", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const session = yield* Effect.promise(() =>
        Session.create({
          title: "snapshot race test",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      )

      const file = path.join(dir, "race-test.txt")
      yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("create the file"), "write", {
        filePath: file,
        content: "snapshot race test content\n",
      })
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("write"), "done")

      yield* Effect.promise(() =>
        SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "create the file" }],
        }),
      )

      const result = yield* Effect.promise(() => SessionPrompt.loop({ sessionID: session.id }))
      expect(result.info.role).toBe("assistant")

      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)

      const allMsgs = yield* Effect.sync(() => MessageV2.filterCompacted(MessageV2.stream(session.id)))
      const tool = allMsgs
        .flatMap((m) => m.parts)
        .find((p): p is MessageV2.ToolPart => p.type === "tool" && p.tool === "write")
      expect(tool?.state.status).toBe("completed")

      let diff: Awaited<ReturnType<typeof SessionSummary.diff>> = []
      for (let i = 0; i < 50; i++) {
        diff = yield* Effect.promise(() => SessionSummary.diff({ sessionID: session.id }))
        if (diff.length > 0) break
        yield* Effect.sleep("100 millis")
      }
      expect(diff.length).toBeGreaterThan(0)
    }),
    { git: true, config: providerCfg },
  ),
)
