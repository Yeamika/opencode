export default {
  description: "Echo current directory for reload manual tests.",
  args: {},
  async execute(_args: unknown, context: { directory?: string }) {
    return context.directory || ""
  },
}
