import { describe, expect, test } from "bun:test"
import { shellinput } from "../../../src/cli/cmd/tui/routes/session/shellinput"

describe("shellinput", () => {
  test("keeps exec_timeout_async command details", () => {
    expect(
      shellinput(
        {
          mode: "exec_timeout_async",
          command: "python script.py",
          description: "Wait and detach",
          workdir: "packages/opencode",
        },
        (value) => value ?? "",
      ),
    ).toEqual({
      icon: "$",
      mode: "exec_timeout_async",
      command: "python script.py",
      description: "Wait and detach",
      workdir: "packages/opencode",
    })
  })

  test("formats async input details", () => {
    expect(
      shellinput(
        {
          mode: "input",
          asyncID: "run_123",
          filePath: "/tmp/input.txt",
        },
        (value) => value?.replace("/tmp/", "tmp/") ?? "",
      ),
    ).toEqual({
      icon: "<==",
      mode: "input",
      command: "[file] tmp/input.txt",
      description: "Send async file input",
    })
  })

  test("formats async list details", () => {
    expect(
      shellinput(
        {
          mode: "list",
          scope: "workspace",
          asyncID: "run_123",
        },
        (value) => value ?? "",
      ),
    ).toEqual({
      icon: "≡",
      mode: "list",
      command: "workspace · run_123",
      description: "List async runs",
    })
  })

  test("formats async control details", () => {
    expect(
      shellinput(
        {
          mode: "control",
          action: "stop",
          asyncID: "run_123",
        },
        (value) => value ?? "",
      ),
    ).toEqual({
      icon: "■",
      mode: "control",
      command: "run_123",
      description: "Async stop",
    })
  })

  test("formats async text input details", () => {
    expect(
      shellinput(
        {
          mode: "input",
          asyncID: "run_123",
          text: "hello   world",
        },
        (value) => value ?? "",
      ),
    ).toEqual({
      icon: "<==",
      mode: "input",
      command: "hello world",
      description: "Send async text input",
    })
  })
})
