import { Database, and, desc, eq } from "@/storage/db"
import { Hash } from "@/util/hash"
import type { RemoteExecutor } from "@/tool/remote_executor"
import { SessionFileReadTable } from "./session.sql"
import type { SessionID } from "./schema"

export namespace SessionFileRead {
  const MAX = 64

  export type Entry = {
    sessionID: SessionID
    fileKeyRef: string
    filename: string
    filePath: string
    hashCode: string
    smallHashCode: string
    readTime: number
  }

  export function clear(sessionID: SessionID) {
    Database.use((db) => db.delete(SessionFileReadTable).where(eq(SessionFileReadTable.session_id, sessionID)).run())
  }

  function basename(input: string) {
    return input.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || input
  }

  export function key(input: { executor?: string; file: Pick<RemoteExecutor.FileStamp, "fileKey"> }) {
    return `${input.executor?.trim() || "local"}:${input.file.fileKey}`
  }

  export function small(input: { fileKeyRef: string; hashCode: string }) {
    return Hash.fast(`${input.fileKeyRef}:${input.hashCode}`).slice(0, 4).toUpperCase()
  }

  function row(input: typeof SessionFileReadTable.$inferSelect): Entry {
    return {
      sessionID: input.session_id,
      fileKeyRef: input.file_key_ref,
      filename: input.filename,
      filePath: input.file_path,
      hashCode: input.hash_code,
      smallHashCode: input.small_hash_code,
      readTime: input.read_time,
    }
  }

  function prune(sessionID: SessionID) {
    const extra = Database.use((db) =>
      db
        .select({ fileKeyRef: SessionFileReadTable.file_key_ref })
        .from(SessionFileReadTable)
        .where(eq(SessionFileReadTable.session_id, sessionID))
        .orderBy(desc(SessionFileReadTable.read_time))
        .all(),
    ).slice(MAX)
    for (const item of extra) {
      Database.use((db) =>
        db
          .delete(SessionFileReadTable)
          .where(
            and(
              eq(SessionFileReadTable.session_id, sessionID),
              eq(SessionFileReadTable.file_key_ref, item.fileKeyRef),
            ),
          )
          .run(),
      )
    }
  }

  export function touch(input: {
    sessionID: SessionID
    executor?: string
    file: RemoteExecutor.FileStamp
    hashCode: string
    filePath?: string
  }) {
    const fileKeyRef = key(input)
    const filePath = input.file.canonicalPath || input.filePath || input.file.fileKey
    const filename = basename(filePath)
    const readTime = Date.now()
    const smallHashCode = small({ fileKeyRef, hashCode: input.hashCode })
    Database.use((db) =>
      db
        .insert(SessionFileReadTable)
        .values({
          session_id: input.sessionID,
          file_key_ref: fileKeyRef,
          filename,
          file_path: filePath,
          hash_code: input.hashCode,
          small_hash_code: smallHashCode,
          read_time: readTime,
        })
        .onConflictDoUpdate({
          target: [SessionFileReadTable.session_id, SessionFileReadTable.file_key_ref],
          set: {
            filename,
            file_path: filePath,
            hash_code: input.hashCode,
            small_hash_code: smallHashCode,
            read_time: readTime,
          },
        })
        .run(),
    )
    prune(input.sessionID)
    return { sessionID: input.sessionID, fileKeyRef, filename, filePath, hashCode: input.hashCode, smallHashCode, readTime }
  }

  export function retouch(input: { sessionID: SessionID; fileKeyRef: string; hashCode: string }) {
    const existing = Database.use((db) =>
      db
        .select()
        .from(SessionFileReadTable)
        .where(
          and(
            eq(SessionFileReadTable.session_id, input.sessionID),
            eq(SessionFileReadTable.file_key_ref, input.fileKeyRef),
          ),
        )
        .get(),
    )
    if (!existing) return undefined
    const smallHashCode = small({ fileKeyRef: input.fileKeyRef, hashCode: input.hashCode })
    const readTime = Date.now()
    Database.use((db) =>
      db
        .update(SessionFileReadTable)
        .set({ hash_code: input.hashCode, small_hash_code: smallHashCode, read_time: readTime })
        .where(
          and(
            eq(SessionFileReadTable.session_id, input.sessionID),
            eq(SessionFileReadTable.file_key_ref, input.fileKeyRef),
          ),
        )
        .run(),
    )
    prune(input.sessionID)
    return { ...row(existing), hashCode: input.hashCode, smallHashCode, readTime }
  }

  export function parseTarget(target: string) {
    const match = /^(.+)\s+#([0-9a-fA-F]{4})$/.exec(target.trim())
    if (!match) return undefined
    return { filename: match[1]!.trim(), smallHashCode: match[2]!.toUpperCase() }
  }

  export function resolve(input: { sessionID: SessionID; target: string }) {
    const parsed = parseTarget(input.target)
    if (!parsed) throw new Error(`File target must be formatted as "filename #ABCD": ${input.target}`)
    const rows = Database.use((db) =>
      db
        .select()
        .from(SessionFileReadTable)
        .where(
          and(
            eq(SessionFileReadTable.session_id, input.sessionID),
            eq(SessionFileReadTable.filename, parsed.filename),
            eq(SessionFileReadTable.small_hash_code, parsed.smallHashCode),
          ),
        )
        .all(),
    ).map(row)
    if (rows.length === 0) throw new Error(`No recently read file matches ${input.target}. Read the file again.`)
    if (rows.length > 1) throw new Error(`File target ${input.target} is ambiguous. Read the intended file again.`)
    return rows[0]!
  }

  export function executor(entry: Pick<Entry, "fileKeyRef">) {
    return entry.fileKeyRef.slice(0, entry.fileKeyRef.indexOf(":")) || "local"
  }

  export function label(entry: Pick<Entry, "filename" | "smallHashCode">) {
    return `${entry.filename} #${entry.smallHashCode}`
  }
}
