## Server plugin SDK rule

- Server plugin APIs must use `@opencode-ai/sdk/v2` only.
- Do not import client or types for server plugin host code from `@opencode-ai/sdk` root.
- When adding or changing TUI control features (`selectSession`, `attachToRunningSession`, `ack`, display-targeted events), verify the v2 SDK exports and generated files stay in sync.
- If server routes or OpenAPI shapes change, regenerate the JavaScript SDK with:

```bash
./packages/sdk/js/script/build.ts
```

- Treat stale generated SDK files as a blocking issue for plugin changes.
