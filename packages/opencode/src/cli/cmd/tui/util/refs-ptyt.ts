import fs from "fs"
import path from "path"
import { spawn, spawnSync } from "child_process"

function real(file: string) {
  try {
    return path.dirname(fs.realpathSync.native(file))
  } catch {
    return undefined
  }
}

function exists(cmd: string) {
  return (
    spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [cmd] : ["-v", cmd], {
      shell: process.platform !== "win32",
      stdio: "ignore",
    }).status === 0
  )
}

function quote(arg: string) {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(arg)) return arg
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

function psquote(arg: string) {
  return `'${arg.replaceAll("'", "''")}'`
}

function psline(args: string[]) {
  return `& ${args.map(psquote).join(" ")}`
}

function windowCommand(args: string[]) {
  if (process.platform === "darwin") {
    return ["osascript", "-e", `tell application "Terminal" to do script ${JSON.stringify(command(args))}`]
  }
  if (process.platform === "win32") {
    return ["cmd.exe", "/c", "start", "", "powershell.exe", "-NoProfile", "-Command", psline(args)]
  }
  if (process.env.OPENCODE_TERMINAL) return [process.env.OPENCODE_TERMINAL, "-e", ...args]
  return [
    ["gnome-terminal", "--", ...args],
    ["konsole", "--new-tab", "-p", "tabtitle=opencode refs-ptyt", "-e", ...args],
    ["xfce4-terminal", "--title", "opencode refs-ptyt", "-e", ...args],
    ["mate-terminal", "--title", "opencode refs-ptyt", "-e", ...args],
    ["tilix", "--title", "opencode refs-ptyt", "-e", ...args],
    ["kitty", "--title", "opencode refs-ptyt", ...args],
    ["alacritty", "--title", "opencode refs-ptyt", "-e", ...args],
    ["wezterm", "start", "--", ...args],
    ["xterm", "-T", "opencode refs-ptyt", "-e", ...args],
    ["x-terminal-emulator", "-e", ...args],
  ].find((item) => exists(item[0]!))
}

export function bin() {
  const exe = process.platform === "win32" ? "refs-ptyt.exe" : "refs-ptyt"
  const roots = [process.env.OPENCODE_BIN_DIR, path.dirname(process.execPath), real(process.execPath)]
    .flatMap((file) => (file ? [file] : []))
    .filter((item, index, all) => all.indexOf(item) === index)
  return (
    roots.flatMap((root) => [exe, `.${exe}`].map((name) => path.join(root, name))).find((file) => fs.existsSync(file)) ??
    exe
  )
}

export function refsUrl(serverUrl: string, sessionID: string) {
  const url = new URL(`/session/${sessionID}/refs-mcp`, serverUrl)
  if (url.protocol === "http:") url.protocol = "ws:"
  else if (url.protocol === "https:") url.protocol = "wss:"
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`refs-ptyt attach requires an http(s) or ws(s) server URL: ${serverUrl}`)
  }
  url.search = ""
  url.hash = ""
  return url.toString()
}

export function args(input: { serverUrl: string; sessionID: string }) {
  return [bin(), "--server-url", refsUrl(input.serverUrl, input.sessionID), "--session", input.sessionID]
}

export function command(args: string[]) {
  if (process.platform === "win32") return psline(args)
  return args.map(quote).join(" ")
}

export function open(args: string[]) {
  const cmdline = windowCommand(args)
  if (!cmdline) throw new Error("No terminal window launcher found for refs-ptyt attach")
  const proc = spawn(cmdline[0]!, cmdline.slice(1), { detached: true, stdio: "ignore", windowsHide: false })
  proc.unref()
}
