import { Database, eq } from "@/storage/db"
import { SessionFileReadTable } from "./session.sql"
import type { SessionID } from "./schema"

export namespace SessionHashRef {
  export function clear(sessionID: SessionID) {
    Database.use((db) => db.delete(SessionFileReadTable).where(eq(SessionFileReadTable.session_id, sessionID)).run())
  }
}
