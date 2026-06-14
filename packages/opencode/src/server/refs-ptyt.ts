import type { ExBashTask } from "@/session/exbash"
import type { SessionID } from "@/session/schema"

type Socket = {
  send: (data: string) => void
}

type TaskKey = {
  asyncID: string
  executor: string
  scope: ExBashTask.Scope
}

export namespace RefsPtyt {
  export type ControlMessage =
    | {
        type: "refs-ptyt.register"
        sessionID: string
        slotID?: string
        schedulable?: boolean
      }
    | {
        type: "refs-ptyt.touch"
        slotID?: string
      }

  export type SlotSnapshot = {
    id: string
    sessionID: string
    workspace: string
    schedulable?: boolean
    connectedAt: number
    touched: number
    current?: TaskKey
  }

  type Slot = SlotSnapshot & {
    socket: Socket
  }

  type AssignInput = {
    sessionID: SessionID
    workspace: string
    task: ExBashTask.Info
  }

  type RemoveInput = {
    sessionID: SessionID
    workspace: string
    executor: string
    asyncID: string
  }

  const slots = new Map<string, Slot>()

  const key = (task: { asyncID: string; executor: string; scope?: string }) =>
    `${task.scope ?? ""}\0${task.executor}\0${task.asyncID}`

  const matchTask = (current: TaskKey | undefined, task: TaskKey) => current !== undefined && key(current) === key(task)

  const matchesScope = (slot: Pick<SlotSnapshot, "sessionID" | "workspace">, input: AssignInput) =>
    input.task.scope === "workspace" ? slot.workspace === input.workspace : slot.sessionID === input.sessionID

  const deliver = (slot: Slot, value: unknown) => {
    try {
      slot.socket.send(JSON.stringify(value))
      return true
    } catch {
      slots.delete(slot.id)
      return false
    }
  }

  export function parse(input: string): ControlMessage | undefined {
    let value: unknown
    try {
      value = JSON.parse(input)
    } catch {
      return undefined
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (record.type !== "refs-ptyt.register" && record.type !== "refs-ptyt.touch") return undefined
    if (record.type === "refs-ptyt.register") {
      if (typeof record.sessionID !== "string" || !record.sessionID.trim()) {
        throw new Error("refs-ptyt.register requires sessionID")
      }
      return {
        type: "refs-ptyt.register",
        sessionID: record.sessionID,
        ...(typeof record.slotID === "string" && record.slotID.trim() ? { slotID: record.slotID } : {}),
        ...(typeof record.schedulable === "boolean" ? { schedulable: record.schedulable } : {}),
      }
    }
    return {
      type: "refs-ptyt.touch",
      ...(typeof record.slotID === "string" && record.slotID.trim() ? { slotID: record.slotID } : {}),
    }
  }

  export function chooseSlot(slots: readonly SlotSnapshot[], input: AssignInput) {
    const task = input.task
    const candidates = slots.filter((slot) => slot.schedulable !== false && matchesScope(slot, input))
    const same = candidates.find((slot) => matchTask(slot.current, task))
    if (same) return same.id
    const empty = candidates
      .filter((slot) => !slot.current)
      .toSorted((a, b) => a.connectedAt - b.connectedAt || a.touched - b.touched)
    if (empty[0]) return empty[0].id
    return candidates.toSorted((a, b) => a.touched - b.touched || a.connectedAt - b.connectedAt)[0]?.id
  }

  export function register(input: {
    sessionID: SessionID
    workspace: string
    socket: Socket
    slotID?: string
    schedulable?: boolean
  }) {
    const now = Date.now()
    const base = input.slotID?.trim() || `refs-ptyt-${crypto.randomUUID()}`
    const id = slots.has(base) ? `${base}-${crypto.randomUUID()}` : base
    const slot: Slot = {
      id,
      sessionID: input.sessionID,
      workspace: input.workspace,
      schedulable: input.schedulable ?? true,
      connectedAt: now,
      touched: now,
      socket: input.socket,
    }
    slots.set(id, slot)
    deliver(slot, { type: "refs-ptyt.registered", slotID: id, schedulable: slot.schedulable })
    return {
      id,
      unregister: () => {
        slots.delete(id)
      },
    }
  }

  export function touch(slotID?: string) {
    if (!slotID) return
    const now = Date.now()
    const slot = slots.get(slotID)
    if (slot) slot.touched = now
  }

  export function assign(input: AssignInput) {
    const id = chooseSlot([...slots.values()], input)
    if (!id) return
    const slot = slots.get(id)
    if (!slot) return
    slot.current = {
      asyncID: input.task.asyncID,
      executor: input.task.executor,
      scope: input.task.scope,
    }
    slot.touched = Date.now()
    deliver(slot, { type: "refs-ptyt.assign", task: input.task })
  }

  export function remove(input: RemoveInput) {
    for (const slot of slots.values()) {
      if (slot.current?.executor !== input.executor || slot.current.asyncID !== input.asyncID) continue
      if (slot.current.scope === "workspace" && slot.workspace !== input.workspace) continue
      if (slot.current.scope === "local" && slot.sessionID !== input.sessionID) continue
      slot.current = undefined
      deliver(slot, {
        type: "refs-ptyt.unassign",
        executor: input.executor,
        asyncID: input.asyncID,
      })
    }
  }

  export function reset() {
    slots.clear()
  }
}
