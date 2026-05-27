import { describe, expect, test } from "bun:test"
import { shellinput } from "../../../src/cli/cmd/tui/routes/session/shellinput"

describe("shellinput", () => {
  test("keeps run command details", () => {
    expect(
      shellinput(
        {
          mode: "run",
          command: "python script.py",
          description: "Wait and detach",
          workdir: "packages/opencode",
        },
        (value) => value ?? "",
      ),
    ).toEqual({
      icon: "$",
      mode: "run",
      command: "python script.py",
      description: "Wait and detach",
      workdir: "packages/opencode",
    })
  })

  test("formats async attach details", () => {
    expect(
      shellinput(
        {
          mode: "attach",
          asyncID: "run_123",
          filePath: "/tmp/input.txt",
        },
        (value) => value?.replace("/tmp/", "tmp/") ?? "",
      ),
    ).toEqual({
      icon: "<==",
      mode: "attach",
      command: "[file] tmp/input.txt",
      description: "Attach async file input",
    })
  })

  test("formats runexe command details", () => {
    expect(
      shellinput(
        {
          mode: "runexe",
          command: "python --version",
        },
        (value) => value ?? "",
      ),
    ).toEqual({
      icon: "▶",
      mode: "runexe",
      command: "python --version",
      description: "Run executable",
      workdir: undefined,
    })
  })

  test("formats async list details", () => {
    expect(
      shellinput(
        {
          mode: "list",
          asyncID: "run_123",
        },
        (value) => value ?? "",
      ),
    ).toEqual({
      icon: "≡",
      mode: "list",
      command: "run_123",
      description: "List async runs",
    })
  })

  test("formats async stop details", () => {
    expect(
      shellinput(
        {
          mode: "stop",
          asyncID: "run_123",
        },
        (value) => value ?? "",
      ),
    ).toEqual({
      icon: "■",
      mode: "stop",
      command: "run_123",
      description: "Stop async task",
    })
  })

  test("formats async remove details", () => {
    expect(
      shellinput(
        {
          mode: "remove",
          asyncID: "run_123",
        },
        (value) => value ?? "",
      ),
    ).toEqual({
      icon: "✕",
      mode: "remove",
      command: "run_123",
      description: "Remove async task",
    })
  })

  test("formats async text input details", () => {
    expect(
      shellinput(
        {
          mode: "attach",
          asyncID: "run_123",
          text: "hello   world",
        },
        (value) => value ?? "",
      ),
    ).toEqual({
      icon: "<==",
      mode: "attach",
      command: "hello world",
      description: "Attach async text input",
    })
  })
})
