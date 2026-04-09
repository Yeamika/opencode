export default {
  description: "Echo current directory for reload manual tests.",
  args: {},
  async execute(_args, context) {
    return context.directory || ""
  },
}
