import { describe, expect, test } from "bun:test"
import z from "zod"
import { jsonSchemaToZod } from "../../src/tool/refs-tools"

describe("tool.refs schema conversion", () => {
  test("converts MCP json schema into model-visible zod parameters", () => {
    const parameters = jsonSchemaToZod({
      type: "object",
      description: "Tool parameters",
      required: ["method"],
      properties: {
        method: {
          type: "string",
          description: "Operation selector",
          enum: ["list_executor", "connect_to_executor"],
        },
        timeout: {
          type: ["integer", "null"],
          description: "Timeout in milliseconds",
          default: null,
        },
        labels: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        mode: {
          const: "shell",
        },
        value: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
    })

    const jsonSchema = z.toJSONSchema(parameters) as Record<string, any>
    expect(jsonSchema.type).toBe("object")
    expect(jsonSchema.description).toBe("Tool parameters")
    expect(jsonSchema.required).toContain("method")
    expect(jsonSchema.properties.method.description).toBe("Operation selector")
    expect(jsonSchema.properties.method.enum).toEqual(["list_executor", "connect_to_executor"])

    const parsed = parameters.parse({
        method: "connect_to_executor",
        timeout: null,
        labels: { device: "remote" },
        mode: "shell",
        value: 8096,
        futureField: true,
    }) as Record<string, unknown>
    expect(parsed.futureField).toBe(true)

    expect(parameters.safeParse({ method: "missing" }).success).toBe(false)
    expect(parameters.safeParse({ method: "list_executor", mode: "run" }).success).toBe(false)
  })
})
