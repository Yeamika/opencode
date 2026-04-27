## Server plugin host rule

- The server plugin host must use `@opencode-ai/sdk/v2`.
- Do not import `createOpencodeClient` for server plugin host code from `@opencode-ai/sdk` root.
- Display-targeted TUI control features (`selectSession`, `attachToRunningSession`, `ack`, display-scoped toasts/events) must be verified against v2 SDK exports.
- If server route shapes change, regenerate the JS SDK before merging:

```bash
./packages/sdk/js/script/build.ts
```

- Treat stale SDK codegen as a blocking issue.
