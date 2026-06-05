import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Snapshot } from "../snapshot"
import { Config } from "../config/config"
import { Flag } from "../flag/flag"
import { Project } from "./project"
import { Vcs } from "./vcs"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Log } from "@/util/log"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  const config = await Config.get()
  Format.init()
  if (config.lsp !== undefined && config.lsp !== false) {
    await LSP.init()
  }
  File.init()
  FileWatcher.init()
  if (!Flag.OPENCODE_DISABLE_VCS) {
    Vcs.init()
    if (config.snapshot === true) {
      Snapshot.init()
    }
  }

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      Project.setInitialized(Instance.project.id)
    }
  })
}
