import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

const plugin: TuiPluginModule = {
  id: "display-control-plugin",
  async tui(api) {
    api.command.register(() => [
      {
        title: "Report Display",
        value: "display.report",
        description: "Publish current displayID, directory, and session to the server event stream.",
        onSelect: () => {
          void api.display.report()
        },
      },
      {
        title: "Switch To Current Session",
        value: "display.select.current",
        description: "Re-send the current session and directory through the display selection route.",
        enabled: !!api.display.sessionID,
        onSelect: () => {
          if (!api.display.sessionID) return
          void api.display.selectSession({
            sessionID: api.display.sessionID,
            directory: api.display.directory,
          })
        },
      },
    ])
  },
}

export default plugin
