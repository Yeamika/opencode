import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import type { Permission } from "../../src/permission"
import type { Tool } from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.skill", () => {
  test("description points agents to list and read modes without injecting skills", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "tool-skill", "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()

          expect(tool.description).toContain('mode "list"')
          expect(tool.description).toContain('mode "read"')
          expect(tool.description).not.toContain("tool-skill")
          expect(tool.description).not.toContain("Skill for tool tests.")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("list returns visible local skill summaries filtered by regex", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          await Bun.write(
            path.join(dir, ".opencode", "skill", name, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const result = await tool.execute(
            { mode: "list", name: "alpha|middle" },
            {
              ...baseCtx,
              ask: async () => {},
            },
          )

          expect(result.output).toContain("name: alpha-skill")
          expect(result.output).toContain("description: Alpha skill.")
          expect(result.output).toContain("name: middle-skill")
          expect(result.output).not.toContain("zeta-skill")
          expect(result.output).not.toContain("# alpha-skill")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("read loads one local skill through REFS", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const root = path.join(dir, ".opencode", "skill", "tool-skill")
        await Bun.write(
          path.join(root, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
        )
        await Bun.write(path.join(root, "scripts", "demo.txt"), "demo")
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async (req) => {
              requests.push(req)
            },
          }

          const result = await tool.execute({ mode: "read", name: "^tool-skill$" }, ctx)
          const root = path.join(tmp.path, ".opencode", "skill", "tool-skill")

          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toContain("tool-skill")
          expect(requests[0].always).toContain("tool-skill")

          expect(result.metadata.dir).toBe(root)
          expect(result.output).toContain(`<skill_content name="tool-skill">`)
          expect(result.output).toContain(`Base directory for this skill: ${root}`)
          expect(result.output).toContain("Use this skill.")
          expect(result.output).toContain("scripts/demo.txt")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
