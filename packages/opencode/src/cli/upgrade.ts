import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"
import { Installation } from "@/installation"

export function action(input: {
  autoupdate?: boolean | "notify"
  disabled: boolean
  notify: boolean
  kind: Installation.ReleaseType
}) {
  if (input.notify) return "notify"
  if (input.disabled) return "skip"
  if (input.autoupdate === "notify") return "notify"
  if (input.autoupdate !== true) return "skip"
  if (input.kind !== "patch") return "notify"
  return "upgrade"
}

export async function upgrade() {
  const config = await Config.getGlobal()
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch(() => {})
  if (!latest) return

  if (Installation.VERSION === latest) return

  const kind = Installation.getReleaseType(Installation.VERSION, latest)
  const next = action({
    autoupdate: config.autoupdate,
    disabled: Flag.OPENCODE_DISABLE_AUTOUPDATE,
    notify: Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE,
    kind,
  })
  if (next === "skip") return
  if (next === "notify") {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (method === "unknown") return
  await Installation.upgrade(method, latest)
    .then(() => Bus.publish(Installation.Event.Updated, { version: latest }))
    .catch(() => {})
}
