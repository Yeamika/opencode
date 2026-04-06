## TUI Display Manual Plugins

These examples are intended for manual attach validation.

- `display-report-plugin.ts`
  - reads `api.display.id`, `api.display.directory`, and `api.display.sessionID`
  - publishes a `tui.display.report` event back to the server event bus

- `display-control-plugin.ts`
  - subscribes to `tui.display.report` through the plugin event hook
  - keeps an in-memory list of other displays reported through the event bus
  - adds commands that call `api.display.report()` and `api.display.selectSession(...)` for the chosen display

Related server routes:

- `POST /tui/select-session`
  - targets a specific `displayID` and optionally changes directory before navigation

Notes:

- the server only relays `tui.display.report` through the normal event stream
- any display registry or aggregation should live in plugins or external controllers, not in the server
- plugin-side control can target another display by passing `displayID` into `api.display.selectSession(...)`
