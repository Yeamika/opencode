import z from "zod"
import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Preview } from "@/session/preview"
import { SessionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage/db"

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: (type, data) => {
      if (type === "session.updated") {
        const id = (data as z.infer<typeof Session.Event.Updated.schema>).sessionID
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())

        if (!row) return data

        return {
          sessionID: id,
          info: Session.fromRow(row),
        }
      }
      if (type === MessageV2.Event.PartUpdated.type) {
        const evt = data as z.infer<typeof MessageV2.Event.PartUpdated.schema>
        return {
          ...evt,
          part: Preview.part(evt.part),
        }
      }
      return data
    },
  })
}

initProjectors()
