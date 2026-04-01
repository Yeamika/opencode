import z from "zod"
import { Tool } from "./tool"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Session } from "@/session"

export const CurrentOCSystemInfoTool = Tool.define("CurrentOCSystemInfo", {
  description: "Get current OpenCode system info, including current session directory and active config location.",
  parameters: z.object({}),
  async execute(_args, ctx) {
    const cfg = Flag.OPENCODE_CONFIG
      ? { path: Flag.OPENCODE_CONFIG, source: "OPENCODE_CONFIG" }
      : Flag.OPENCODE_CONFIG_DIR
        ? { path: Flag.OPENCODE_CONFIG_DIR, source: "OPENCODE_CONFIG_DIR" }
        : { path: Global.Path.config, source: "Global.Path.config" }
    const session = await Session.get(ctx.sessionID)
    const info = {
      sessionID: ctx.sessionID,
      sessionDir: session.directory,
      instanceDir: Instance.directory,
      configPath: cfg.path,
      configSource: cfg.source,
    }

    return {
      title: "Retrieved current OpenCode system info",
      output: JSON.stringify(info, null, 2),
      metadata: info,
    }
  },
})
