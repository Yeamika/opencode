import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { ConfigPaths } from "../../config/paths"
import { Provider } from "../../provider/provider"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import path from "path"
import { applyEdits, modify } from "jsonc-parser"
import { existsSync } from "fs"

const log = Log.create({ service: "server" })
const McpChecks = z.object({
  global: z.record(z.string(), z.boolean()),
  local: z.record(z.string(), z.enum(["yes", "no", "follow"])),
})
const McpCheckUpdate = z.object({
  scope: z.enum(["global", "local"]),
  name: z.string(),
  value: z.enum(["yes", "no", "follow"]),
})

function rec(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function on(value: unknown) {
  const item = rec(value)
  if (!Object.keys(item).length) return false
  if (typeof item.enabled === "boolean") return item.enabled
  return true
}

async function file(file: string) {
  const text = await ConfigPaths.readFile(file)
  if (!text) return {}
  const data = await ConfigPaths.parseText(text, file, "empty").catch(() => undefined)
  return rec(rec(data).mcp)
}

function edit(input: string, keys: string[], value: unknown) {
  return applyEdits(
    input,
    modify(input, keys, value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    }),
  )
}

function globalFile() {
  const files = ["opencode.jsonc", "opencode.json", "config.json"].map((name) => path.join(Global.Path.config, name))
  for (const file of files) {
    if (existsSync(file)) return file
  }
  return files[0]
}

function localFile() {
  return path.join(Instance.directory, "config.json")
}

async function write(input: z.infer<typeof McpCheckUpdate>) {
  const filePath = input.scope === "global" ? globalFile() : localFile()
  let text = (await ConfigPaths.readFile(filePath)) ?? "{}"
  if (!text.trim()) text = "{}"
  text = edit(text, ["$schema"], "https://opencode.ai/config.json")
  const data = await ConfigPaths.parseText(text, filePath, "empty").catch(() => ({}))
  const item = rec(rec(rec(data).mcp)[input.name])

  if (input.scope === "global" && input.value === "follow") {
    throw new Error("global check does not support follow")
  }

  if (input.scope === "local" && input.value === "follow") {
    text = edit(text, ["mcp", input.name], undefined)
  } else {
    text = edit(text, ["mcp", input.name], { ...item, enabled: input.value === "yes" })
  }

  await Bun.write(filePath, text)
}

async function checks() {
  const g = await file(globalFile())
  const l = await file(localFile())
  const cfg = rec((await Config.get()).mcp)
  const names = [...new Set([...Object.keys(cfg), ...Object.keys(g), ...Object.keys(l)])].sort((a, b) => a.localeCompare(b))
  return {
    global: Object.fromEntries(names.map((name) => [name, on(g[name])])),
    local: Object.fromEntries(
      names.map((name) => [name, name in l ? (on(l[name]) ? "yes" : "no") : "follow"]),
    ),
  }
}

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.get())
      },
    )
    .get(
      "/mcp/checks",
      describeRoute({
        summary: "Get MCP config checks",
        description: "Get global and local MCP configuration state for the current instance.",
        operationId: "config.mcp.checks",
        responses: {
          200: {
            description: "MCP config checks",
            content: {
              "application/json": {
                schema: resolver(McpChecks),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await checks())
      },
    )
    .post(
      "/mcp/checks",
      describeRoute({
        summary: "Update MCP config checks",
        description: "Update global or local MCP configuration state for the current instance.",
        operationId: "config.mcp.checks.update",
        responses: {
          200: {
            description: "Updated MCP config checks",
            content: {
              "application/json": {
                schema: resolver(McpChecks),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", McpCheckUpdate),
      async (c) => {
        const input = c.req.valid("json")
        await write(input)
        return c.json(await checks())
      },
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        await Config.update(config)
        return c.json(config)
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        using _ = log.time("providers")
        const providers = await Provider.list().then((x) => mapValues(x, (item) => item))
        return c.json({
          providers: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
        })
      },
    )
    .get(
      "/plugins",
      describeRoute({
        summary: "List config plugins",
        description: "Get plugin display information prepared by the current OpenCode server.",
        operationId: "config.plugins",
        responses: {
          200: {
            description: "List of configured plugins",
            content: {
              "application/json": {
                schema: resolver(Config.PluginInfo.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(
          (await Config.get()).plugin?.map(Config.pluginInfo).toSorted((a, b) => a.name.localeCompare(b.name)) ?? [],
        )
      },
    ),
)
