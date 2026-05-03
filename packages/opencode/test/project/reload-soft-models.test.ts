import { afterEach, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { Reload } from "../../src/project/reload"
import { Provider } from "../../src/provider/provider"
import { ProviderID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
  await Auth.remove("https://reload.example.com").catch(() => undefined)
})

test("soft reload refreshes local models without reloading plugins", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const root = path.join(dir, ".opencode", "plugin")
      const cfg = path.join(dir, ".opencode")
      const file = path.join(dir, "plugin-count.txt")
      await fs.mkdir(root, { recursive: true })
      await fs.mkdir(path.join(cfg, "node_modules", "@opencode-ai", "plugin"), { recursive: true })
      await Bun.write(file, "")
      await Bun.write(
        path.join(cfg, "package.json"),
        JSON.stringify({
          dependencies: {
            "@opencode-ai/plugin": "*",
          },
        }),
      )
      await Bun.write(path.join(cfg, ".gitignore"), "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n")
      await Bun.write(
        path.join(cfg, "node_modules", "@opencode-ai", "plugin", "package.json"),
        JSON.stringify({ name: "@opencode-ai/plugin", version: "1.0.0" }),
      )
      await Bun.write(
        path.join(root, "count.ts"),
        [
          "export default async () => {",
          `  const file = Bun.file(${JSON.stringify(file)})`,
          '  const text = await file.text().catch(() => "")',
          `  await Bun.write(${JSON.stringify(file)}, text + "1")`,
          "  return {}",
          "}",
          "",
        ].join("\n"),
      )
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            apu: {
              name: "APU",
              api: "https://apu.example/v1",
              models: {
                one: {
                  name: "One",
                  limit: { context: 1, output: 1 },
                  modalities: { input: ["text"], output: ["text"] },
                },
              },
            },
          },
        }),
      )
      return { file }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const prev = await Provider.list()
      expect(prev[ProviderID.make("apu")]?.models.one).toBeDefined()
      expect(await Bun.file(tmp.extra.file).text()).toBe("1")

      await Bun.write(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            apu: {
              name: "APU",
              api: "https://apu.example/v1",
              models: {
                two: {
                  name: "Two",
                  limit: { context: 2, output: 2 },
                  modalities: { input: ["text"], output: ["text"] },
                },
              },
            },
          },
        }),
      )

      await Reload.request(Instance.directory)

      const next = await Provider.list()
      expect(next[ProviderID.make("apu")]?.models.one).toBeUndefined()
      expect(next[ProviderID.make("apu")]?.models.two).toBeDefined()
      expect(await Bun.file(tmp.extra.file).text()).toBe("1")
    },
  })
})

test("soft reload refreshes well-known models and auth tokens", async () => {
  const prev = globalThis.fetch
  let turn = 0
  globalThis.fetch = mock((url: string | URL | Request) => {
    const text = url.toString()
    if (!text.includes(".well-known/opencode")) return prev(url)
    turn += 1
    const model = turn === 1 ? "one" : "two"
    const name = turn === 1 ? "One" : "Two"
    return Promise.resolve(
      new Response(
        JSON.stringify({
          config: {
            provider: {
              apu: {
                name: "APU",
                api: "https://apu.example/v1",
                options: { apiKey: "{env:WK_TOKEN}" },
                models: {
                  [model]: {
                    name,
                    limit: { context: 1, output: 1 },
                    modalities: { input: ["text"], output: ["text"] },
                  },
                },
              },
            },
          },
        }),
        { status: 200 },
      ),
    )
  }) as unknown as typeof fetch

  try {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.set("https://reload.example.com", {
          type: "wellknown",
          key: "WK_TOKEN",
          token: "first-token",
        })

        const a = await Provider.list()
        expect(a[ProviderID.make("apu")]?.models.one).toBeDefined()
        expect(a[ProviderID.make("apu")]?.options.apiKey).toBe("first-token")

        await Auth.set("https://reload.example.com", {
          type: "wellknown",
          key: "WK_TOKEN",
          token: "second-token",
        })

        await Reload.request(Instance.directory)

        const b = await Provider.list()
        expect(b[ProviderID.make("apu")]?.models.one).toBeUndefined()
        expect(b[ProviderID.make("apu")]?.models.two).toBeDefined()
        expect(b[ProviderID.make("apu")]?.options.apiKey).toBe("second-token")
      },
    })
  } finally {
    globalThis.fetch = prev
  }
})
