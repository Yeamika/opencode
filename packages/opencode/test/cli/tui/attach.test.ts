import { afterEach, expect, mock, spyOn, test } from "bun:test"

import { tmpdir } from "../../fixture/fixture"
import * as App from "../../../src/cli/cmd/tui/app"
import * as Win32 from "../../../src/cli/cmd/tui/win32"
import { TuiConfig } from "../../../src/config/tui"
import { Instance } from "../../../src/project/instance"

const stop = new Error("stop")

afterEach(() => {
  mock.restore()
})

test("attach loads tui config through a detached instance", async () => {
  await using tmp = await tmpdir()
  const cwd = process.cwd()
  const seen = {
    detached: "",
    tui: "",
  }

  spyOn(App, "tui").mockImplementation(async (input) => {
    seen.tui = input.url
    throw stop
  })
  spyOn(Win32, "win32DisableProcessedInput").mockImplementation(() => {})
  spyOn(Win32, "win32InstallCtrlCGuard").mockReturnValue(undefined)
  spyOn(TuiConfig, "get").mockResolvedValue({})
  spyOn(Instance, "detached").mockImplementation(async (input) => {
    seen.detached = input.directory
    return input.fn()
  })
  const provide = spyOn(Instance, "provide").mockImplementation(async () => {
    throw new Error("attach should not create a database-backed instance")
  })

  try {
    const { AttachCommand } = await import("../../../src/cli/cmd/tui/attach")
    const args: Parameters<NonNullable<typeof AttachCommand.handler>>[0] = {
      _: [],
      $0: "opencode",
      url: "http://127.0.0.1:9521",
      dir: tmp.path,
      continue: false,
      session: undefined,
      fork: false,
      password: undefined,
    }

    await expect(AttachCommand.handler(args)).rejects.toBe(stop)
    expect(seen.detached).toBe(tmp.path)
    expect(seen.tui).toBe("http://127.0.0.1:9521")
    expect(provide).not.toHaveBeenCalled()
  } finally {
    process.chdir(cwd)
  }
})
