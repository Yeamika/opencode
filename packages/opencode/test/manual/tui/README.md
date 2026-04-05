## TUI Display Manual Plugins

These examples are intended for manual attach validation.

- `display-report-plugin.ts`
  - reads `api.display.id`, `api.display.directory`, and `api.display.sessionID`
  - publishes a `tui.display.report` event back to the server

- `display-control-plugin.ts`
  - adds simple commands that call `api.display.report()` and `api.display.selectSession(...)`

Related server routes:

- `GET /tui/display`
  - lists display reports published by TUI-side plugins
- `POST /tui/select-session`
  - targets a specific `displayID` and optionally changes directory before navigation
