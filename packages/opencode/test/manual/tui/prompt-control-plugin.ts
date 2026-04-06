import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

const plugin: TuiPluginModule = {
  id: "prompt-control-plugin",
  async tui(api) {
    api.command.register(() => [
      {
        title: "Append Demo Prompt",
        value: "prompt.append.demo",
        description: "Append a visible demo prompt into the current TUI input.",
        onSelect: () => {
          void api.prompt.append("Hello from prompt-control-plugin")
        },
      },
      {
        title: "Submit Current Prompt",
        value: "prompt.submit.current",
        description: "Submit the current TUI prompt through the normal UI flow.",
        onSelect: () => {
          void api.prompt.submit()
        },
      },
      {
        title: "Clear Current Prompt",
        value: "prompt.clear.current",
        description: "Clear the current TUI prompt input.",
        onSelect: () => {
          void api.prompt.clear()
        },
      },
    ])
  },
}

export default plugin
