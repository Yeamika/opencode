const aiSdkGlobal = globalThis as typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: false | ((options: unknown) => void)
}

aiSdkGlobal.AI_SDK_LOG_WARNINGS = false

if (typeof process !== "undefined") {
  process.env.AI_SDK_LOG_WARNINGS = "false"
}
