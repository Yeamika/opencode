import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

const plugin: TuiPluginModule = {
  id: "display-control-plugin",
  async tui(api) {
    const reports = new Map<string, { displayID: string; directory?: string; sessionID?: string }>()

    api.event.on("tui.display.report", (evt) => {
      reports.set(evt.properties.displayID, evt.properties)
    })

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
      {
        title: "Attach To Current Session",
        value: "display.attach.current",
        description:
          "Attach the current display to its current running session via the attach-to-running-session chain.",
        enabled: !!api.display.sessionID,
        onSelect: () => {
          if (!api.display.sessionID) return
          void api.display.attachToRunningSession({
            sessionID: api.display.sessionID,
          })
        },
      },
      ...Array.from(reports.values())
        .filter((report) => report.displayID !== api.display.id && report.sessionID)
        .map((report) => ({
          title: `Focus ${report.displayID}`,
          value: `display.select.${report.displayID}`,
          description: `Switch ${report.displayID} to ${report.directory ?? "/"}`,
          onSelect: () => {
            if (!report.sessionID) return
            void api.display.selectSession({
              displayID: report.displayID,
              sessionID: report.sessionID,
              directory: report.directory,
            })
          },
        })),
      ...Array.from(reports.values())
        .filter((report) => report.displayID !== api.display.id && report.sessionID)
        .map((report) => ({
          title: `Attach ${report.displayID}`,
          value: `display.attach.${report.displayID}`,
          description: `Attach ${report.displayID} to its current running session using the attach chain.`,
          onSelect: () => {
            if (!report.sessionID) return
            void api.display.attachToRunningSession({
              displayID: report.displayID,
              sessionID: report.sessionID,
            })
          },
        })),
    ])
  },
}

export default plugin
