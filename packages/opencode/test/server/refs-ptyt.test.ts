import { afterEach, describe, expect, test } from "bun:test"
import { RefsPtyt } from "../../src/server/refs-ptyt"
import { SessionID } from "../../src/session/schema"

const task = (input: Partial<Parameters<typeof RefsPtyt.chooseSlot>[1]["task"]> = {}) => ({
  asyncID: "task-1",
  executor: "exec-1",
  scope: "local" as const,
  description: "build",
  command: "make",
  cwd: "/workspace/a",
  startedAt: 1,
  state: "running" as const,
  ...input,
})

afterEach(() => {
  RefsPtyt.reset()
})

describe("RefsPtyt.chooseSlot", () => {
  const sessionA = SessionID.make("session-a")
  const sessionB = SessionID.make("session-b")

  test("fills empty schedulable slots before replacing occupied slots", () => {
    const picked = RefsPtyt.chooseSlot(
      [
        {
          id: "occupied",
          sessionID: sessionA,
          workspace: "/workspace/a",
          connectedAt: 1,
          touched: 1,
          current: { asyncID: "old", executor: "exec-1", scope: "local" },
        },
        {
          id: "empty",
          sessionID: sessionA,
          workspace: "/workspace/a",
          connectedAt: 2,
          touched: 2,
        },
      ],
      { sessionID: sessionA, workspace: "/workspace/a", task: task() },
    )

    expect(picked).toBe("empty")
  })

  test("keeps the same task on its current slot", () => {
    const picked = RefsPtyt.chooseSlot(
      [
        {
          id: "same",
          sessionID: sessionA,
          workspace: "/workspace/a",
          connectedAt: 1,
          touched: 10,
          current: { asyncID: "task-1", executor: "exec-1", scope: "local" },
        },
        {
          id: "empty",
          sessionID: sessionA,
          workspace: "/workspace/a",
          connectedAt: 2,
          touched: 1,
        },
      ],
      { sessionID: sessionA, workspace: "/workspace/a", task: task() },
    )

    expect(picked).toBe("same")
  })

  test("replaces the least recently touched slot when all slots are occupied", () => {
    const picked = RefsPtyt.chooseSlot(
      [
        {
          id: "newer",
          sessionID: sessionA,
          workspace: "/workspace/a",
          connectedAt: 1,
          touched: 20,
          current: { asyncID: "newer-task", executor: "exec-1", scope: "local" },
        },
        {
          id: "older",
          sessionID: sessionA,
          workspace: "/workspace/a",
          connectedAt: 2,
          touched: 10,
          current: { asyncID: "older-task", executor: "exec-1", scope: "local" },
        },
      ],
      { sessionID: sessionA, workspace: "/workspace/a", task: task() },
    )

    expect(picked).toBe("older")
  })

  test("matches workspace tasks by workspace and local tasks by session", () => {
    const slots = [
      {
        id: "same-workspace",
        sessionID: sessionB,
        workspace: "/workspace/a",
        connectedAt: 1,
        touched: 1,
      },
      {
        id: "same-path-different-session",
        sessionID: sessionB,
        workspace: "/workspace/a",
        connectedAt: 2,
        touched: 2,
      },
    ]

    expect(
      RefsPtyt.chooseSlot(slots, {
        sessionID: sessionA,
        workspace: "/workspace/a",
        task: task({ scope: "workspace" }),
      }),
    ).toBe("same-workspace")
    expect(
      RefsPtyt.chooseSlot(slots, {
        sessionID: sessionA,
        workspace: "/workspace/a",
        task: task({ scope: "local" }),
      }),
    ).toBeUndefined()
  })

  test("treats missing schedulable as true and skips explicit false", () => {
    const picked = RefsPtyt.chooseSlot(
      [
        {
          id: "disabled",
          sessionID: sessionA,
          workspace: "/workspace/a",
          schedulable: false,
          connectedAt: 1,
          touched: 1,
        },
        {
          id: "default-enabled",
          sessionID: sessionA,
          workspace: "/workspace/a",
          connectedAt: 2,
          touched: 2,
        },
      ],
      { sessionID: sessionA, workspace: "/workspace/a", task: task() },
    )

    expect(picked).toBe("default-enabled")
  })

  test("registers clients as schedulable by default and sends assignments", () => {
    const sent: unknown[] = []
    const registration = RefsPtyt.register({
      sessionID: sessionA,
      workspace: "/workspace/a",
      socket: {
        send: (data) => sent.push(JSON.parse(data)),
      },
    })

    expect(sent[0]).toMatchObject({
      type: "refs-ptyt.registered",
      slotID: registration.id,
      schedulable: true,
    })

    RefsPtyt.assign({ sessionID: sessionA, workspace: "/workspace/a", task: task() })

    expect(sent[1]).toMatchObject({
      type: "refs-ptyt.assign",
      task: {
        asyncID: "task-1",
        executor: "exec-1",
      },
    })
  })
})
