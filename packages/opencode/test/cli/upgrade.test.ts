import { expect, test } from "bun:test"

import { action } from "../../src/cli/upgrade"

test("upgrade is disabled by default", async () => {
  expect(action({ disabled: false, notify: false, kind: "patch" })).toBe("skip")
})

test("upgrade runs patch updates when explicitly enabled", async () => {
  expect(action({ autoupdate: true, disabled: false, notify: false, kind: "patch" })).toBe("upgrade")
})

test("upgrade notify mode only publishes update availability", async () => {
  expect(action({ autoupdate: "notify", disabled: false, notify: false, kind: "patch" })).toBe("notify")
})

test("upgrade notifies for non-patch updates when explicitly enabled", async () => {
  expect(action({ autoupdate: true, disabled: false, notify: false, kind: "minor" })).toBe("notify")
})

test("disable flag wins over enabled config", async () => {
  expect(action({ autoupdate: true, disabled: true, notify: false, kind: "patch" })).toBe("skip")
})
