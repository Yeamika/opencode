import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

const plugin: TuiPluginModule = {
  id: "display-report-plugin",
  async tui(api) {
    const safeReport = () => api.display.report().catch(() => {})

    safeReport()

    api.event.on("session.updated", safeReport)
    api.event.on("session.idle", safeReport)
    api.event.on("session.deleted", safeReport)
  },
}

export default plugin
