use async_trait::async_trait;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use remote_executor_for_session::host::{
    ExbashSessionStore, ExbashSyncInput, ExbashWorkdirStore, HashRefSessionStore,
    RemoteExecutorConfigStore, SessionWorkdirProvider, EXBASH_TASK_STACK_FULL_MESSAGE,
};
use remote_executor_for_session::refs::{
    basename, make_entry_parts, parse_hash_ref, small_hash_code,
};
use remote_executor_for_session::types::{
    ExbashTaskSnapshot, FileRefEntry, FileRefUpdate, RemoteExecutorConfigSnapshot,
};

/// SQLite-backed SessionHost that reads/writes the same database as OpenCode.
///
/// Table schemas (copied from OpenCode `session.sql.ts`):
///
/// ```sql
/// session_file_read (
///   session_id TEXT NOT NULL,
///   file_key_ref TEXT NOT NULL,
///   filename TEXT NOT NULL,
///   file_path TEXT NOT NULL,
///   hash_code TEXT NOT NULL,
///   small_hash_code TEXT NOT NULL,
///   read_time INTEGER NOT NULL,
///   PRIMARY KEY (session_id, file_key_ref)
/// )
///
/// exbash_task (
///   async_id TEXT NOT NULL,
///   session_id TEXT NOT NULL,
///   workspace TEXT NOT NULL,
///   scope TEXT NOT NULL,
///   executor TEXT NOT NULL DEFAULT 'local',
///   description TEXT NOT NULL,
///   command TEXT NOT NULL,
///   cwd TEXT NOT NULL,
///   time_start INTEGER NOT NULL,
///   time_end INTEGER,
///   exit_code TEXT,
///   time_created INTEGER NOT NULL,
///   time_updated INTEGER NOT NULL,
///   PRIMARY KEY (session_id, workspace, executor, async_id)
/// )
/// ```
pub struct SqliteSessionHost {
    workdir: String,
    conn: Mutex<Connection>,
    exbash_changed: Mutex<Option<ThreadsafeFunction<String, ErrorStrategy::Fatal>>>,
}

const EXBASH_TASK_LIMIT: i64 = 10;

impl SqliteSessionHost {
    pub fn new(_session_id: String, workdir: String, db_path: PathBuf) -> anyhow::Result<Self> {
        let conn =
            Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")?;
        Ok(Self {
            workdir,
            conn: Mutex::new(conn),
            exbash_changed: Mutex::new(None),
        })
    }

    pub fn set_exbash_changed_callback(
        &self,
        callback: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
    ) {
        *self.exbash_changed.lock().unwrap() = Some(callback);
    }

    fn notify_exbash_changed(&self, session_id: &str, workdir: &str) {
        let payload = json!({
            "sessionID": session_id,
            "workspace": workdir,
        })
        .to_string();
        if let Some(callback) = self.exbash_changed.lock().unwrap().as_ref() {
            let _ = callback.call(payload, ThreadsafeFunctionCallMode::NonBlocking);
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

// ─── SessionWorkdirProvider ───

#[async_trait]
impl SessionWorkdirProvider for SqliteSessionHost {
    type Error = String;
    async fn session_workdir(&self, session_id: &str) -> Result<String, Self::Error> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT directory FROM session WHERE id = ?1 LIMIT 1")
        else {
            return Ok(self.workdir.clone());
        };
        let directory = stmt
            .query_row(rusqlite::params![session_id], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(directory.unwrap_or_else(|| self.workdir.clone()))
    }
}

// ─── HashRefSessionStore ───

#[async_trait]
impl HashRefSessionStore for SqliteSessionHost {
    type Error = String;

    fn is_hash_ref(&self, target: &str) -> bool {
        parse_hash_ref(target).is_some()
    }

    async fn resolve_hash_ref(
        &self,
        session_id: &str,
        target: &str,
    ) -> Result<FileRefEntry, Self::Error> {
        let parsed = parse_hash_ref(target).ok_or_else(|| format!("invalid hashRef: {target}"))?;
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT file_key_ref, file_path, hash_code
                 FROM session_file_read
                 WHERE session_id = ?1
                   AND (filename = ?2 OR filename = ?3)
                   AND small_hash_code = ?4
                 ORDER BY read_time DESC
                 LIMIT 1",
            )
            .map_err(|e| e.to_string())?;
        let filename = basename(&parsed.filename);
        let entry = stmt
            .query_row(
                rusqlite::params![
                    session_id,
                    parsed.filename,
                    filename,
                    parsed.small_hash_code
                ],
                |row| {
                    let fkr: String = row.get(0)?;
                    let executor = fkr[..fkr.find(':').unwrap_or(0)].to_string();
                    Ok(FileRefEntry {
                        executor,
                        file_path: row.get(1)?,
                        hash_code: row.get(2)?,
                        file_key_ref: fkr,
                    })
                },
            )
            .map_err(|e| format!("hashRef not found: {target} ({e})"))?;
        conn.execute(
            "UPDATE session_file_read
             SET read_time = ?1
             WHERE session_id = ?2 AND file_key_ref = ?3",
            rusqlite::params![now_ms(), session_id, entry.file_key_ref],
        )
        .map_err(|e| e.to_string())?;
        Ok(entry)
    }

    async fn store_hash_ref(
        &self,
        session_id: &str,
        update: FileRefUpdate,
    ) -> Result<FileRefEntry, Self::Error> {
        let (file_key_ref, filename, small_hash, _label) = make_entry_parts(
            Some(&update.executor),
            &update.file.file_key,
            &update.file.canonical_path,
            &update.hash_code,
        );
        let file_path = &update.file.canonical_path;
        let read_time = now_ms();

        let conn = self.conn.lock().unwrap();
        // Delete old entry with same file_key_ref (handles rename)
        conn.execute(
            "DELETE FROM session_file_read WHERE session_id = ?1 AND file_key_ref = ?2",
            rusqlite::params![session_id, file_key_ref],
        )
        .map_err(|e| e.to_string())?;
        // Insert new
        conn.execute(
            "INSERT INTO session_file_read
                (session_id, file_key_ref, filename, file_path, hash_code, small_hash_code, read_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                session_id,
                file_key_ref,
                filename,
                file_path,
                update.hash_code,
                small_hash,
                read_time
            ],
        )
        .map_err(|e| e.to_string())?;
        // Keep the latest 64 hash refs for this session by access time.
        conn.execute(
            "DELETE FROM session_file_read
             WHERE session_id = ?1 AND file_key_ref NOT IN (
                SELECT file_key_ref FROM session_file_read
                WHERE session_id = ?1
                ORDER BY read_time DESC LIMIT 64
             )",
            rusqlite::params![session_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(FileRefEntry {
            executor: update.executor,
            file_path: file_path.clone(),
            hash_code: update.hash_code,
            file_key_ref,
        })
    }

    async fn retouch_hash_ref(
        &self,
        session_id: &str,
        file_key_ref: &str,
        hash_code: &str,
    ) -> Result<Option<FileRefEntry>, Self::Error> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<(String, String, String)> = conn
            .prepare(
                "SELECT file_key_ref, file_path, hash_code
                 FROM session_file_read
                 WHERE session_id = ?1 AND file_key_ref = ?2",
            )
            .map_err(|e| e.to_string())?
            .query_row(rusqlite::params![session_id, file_key_ref], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .ok();

        let Some((_fkr, _fp, _old_hash)) = existing else {
            return Ok(None);
        };

        let new_small = small_hash_code(file_key_ref, hash_code);
        let read_time = now_ms();

        conn.execute(
            "UPDATE session_file_read
             SET hash_code = ?1, small_hash_code = ?2, read_time = ?3
             WHERE session_id = ?4 AND file_key_ref = ?5",
            rusqlite::params![hash_code, new_small, read_time, session_id, file_key_ref],
        )
        .map_err(|e| e.to_string())?;

        let entry = conn
            .prepare(
                "SELECT file_key_ref, file_path, hash_code
                 FROM session_file_read
                 WHERE session_id = ?1 AND file_key_ref = ?2",
            )
            .map_err(|e| e.to_string())?
            .query_row(rusqlite::params![session_id, file_key_ref], |row| {
                let fkr: String = row.get(0)?;
                Ok(FileRefEntry {
                    executor: fkr[..fkr.find(':').unwrap_or(0)].to_string(),
                    file_path: row.get(1)?,
                    hash_code: row.get(2)?,
                    file_key_ref: fkr,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(Some(entry))
    }
}

// ─── ExbashSessionStore ───

/// Columns: async_id(0), executor(1), session_id(2), scope(3), state(4),
///          exit_code(5), time_start(6), time_end(7), command(8), description(9), workspace(10)
fn exbash_row_to_snapshot(row: &rusqlite::Row) -> rusqlite::Result<ExbashTaskSnapshot> {
    let async_id: String = row.get(0)?;
    let executor: String = row.get(1)?;
    let session_id: String = row.get(2)?;
    let _scope: String = row.get(3)?;
    let _state: Option<String> = row.get(4)?;
    let exit_code_str: Option<String> = row.get(5)?;
    let time_start: i64 = row.get(6)?;
    let time_end: Option<i64> = row.get(7)?;
    let state = exbash_state(time_end, exit_code_str.as_deref());
    let exit_code: Option<i32> = exit_code_str.as_deref().and_then(|s| s.parse().ok());
    let command: String = row.get(8)?;
    let description: String = row.get(9)?;
    let workspace: String = row.get(10)?;

    Ok(ExbashTaskSnapshot {
        async_id,
        executor,
        session_id: Some(session_id),
        workdir: Some(workspace),
        state,
        pid: None,
        exit_code,
        started_at: Some(time_start),
        ended_at: time_end,
        command: Some(command),
        description: Some(description),
        total_output: None,
    })
}

fn exbash_state(time_end: Option<i64>, exit_code: Option<&str>) -> Option<String> {
    if time_end.is_none() {
        return Some("running".into());
    }
    let Some(value) = exit_code.map(str::trim).filter(|value| !value.is_empty()) else {
        return Some("unknown".into());
    };
    match value {
        "timeout" => Some("timeout".into()),
        "stop" | "stopped" => Some("stop".into()),
        other => other
            .parse::<i32>()
            .map(|code| format!("exit:{code}"))
            .ok()
            .or_else(|| Some("unknown".into())),
    }
}

fn exbash_exit_storage(input: &ExbashSyncInput) -> Option<String> {
    if let Some(code) = input.exit_code {
        return Some(code.to_string());
    }
    let state = input.state.as_deref()?.trim();
    match state {
        "timeout" => Some("timeout".into()),
        "stop" | "stopped" => Some("stop".into()),
        value if value.starts_with("exit:") => value
            .trim_start_matches("exit:")
            .parse::<i32>()
            .map(|code| code.to_string())
            .ok(),
        _ => None,
    }
}

fn exbash_exit_storage_is_terminal(exit_code: Option<&str>) -> bool {
    exit_code
        .map(|value| {
            let value = value.trim();
            value == "timeout"
                || value == "stop"
                || value == "stopped"
                || value.parse::<i32>().is_ok()
        })
        .unwrap_or(false)
}

fn exbash_time_end(input: &ExbashSyncInput, exit_code: Option<&str>) -> Option<i64> {
    input
        .ended_at
        .or_else(|| exbash_exit_storage_is_terminal(exit_code).then(now_ms))
}

#[async_trait]
impl ExbashSessionStore for SqliteSessionHost {
    type Error = String;

    async fn check_session_exbash_create(
        &self,
        session_id: &str,
        input: &ExbashSyncInput,
    ) -> Result<(), Self::Error> {
        let executor = input.executor.as_deref().unwrap_or("local");
        let conn = self.conn.lock().unwrap();
        if let Some(async_id) = input.async_id.as_deref().filter(|value| !value.is_empty()) {
            let existing: i64 = conn
                .query_row(
                    "SELECT COUNT(*)
                     FROM exbash_task
                     WHERE session_id = ?1 AND executor = ?2 AND async_id = ?3 AND scope = 'local'",
                    rusqlite::params![session_id, executor, async_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if existing > 0 {
                return Ok(());
            }
        }
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM exbash_task
                 WHERE session_id = ?1 AND scope = 'local'",
                rusqlite::params![session_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count >= EXBASH_TASK_LIMIT {
            return Err(EXBASH_TASK_STACK_FULL_MESSAGE.to_string());
        }
        Ok(())
    }

    async fn session_exbash_snapshot(
        &self,
        session_id: &str,
        async_id: &str,
        executor: &str,
    ) -> Result<Option<ExbashTaskSnapshot>, Self::Error> {
        let conn = self.conn.lock().unwrap();
        let result = conn
            .prepare(
                "SELECT async_id, executor, session_id, scope,
                        NULL as state,
                        exit_code, time_start, time_end, command, description, workspace
                 FROM exbash_task
                 WHERE session_id = ?1 AND async_id = ?2 AND executor = ?3 AND scope = 'local'",
            )
            .map_err(|e| e.to_string())?
            .query_row(
                rusqlite::params![session_id, async_id, executor],
                exbash_row_to_snapshot,
            )
            .ok();
        Ok(result)
    }

    async fn upsert_session_exbash(
        &self,
        session_id: &str,
        input: ExbashSyncInput,
    ) -> Result<ExbashTaskSnapshot, Self::Error> {
        let session_id = input
            .session_id
            .clone()
            .unwrap_or_else(|| session_id.to_string());
        let workdir = input
            .workdir
            .clone()
            .unwrap_or_else(|| self.workdir.clone());
        let async_id = input.async_id.clone().unwrap_or_default();
        let executor = input.executor.clone().unwrap_or_else(|| "local".into());
        let command = input.command.clone().unwrap_or_default();
        let description = input.description.clone().unwrap_or_default();
        let time_start = input.started_at.unwrap_or_else(now_ms);
        let exit_code = exbash_exit_storage(&input);
        let time_end = exbash_time_end(&input, exit_code.as_deref());
        let ts = now_ms();

        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO exbash_task
                (async_id, session_id, workspace, scope, executor, description, command, cwd,
                 time_start, time_end, exit_code, time_created, time_updated)
             VALUES (?1, ?2, ?3, 'local', ?4, ?5, ?6, ?3, ?7, ?8, ?9, ?10, ?10)
             ON CONFLICT(session_id, workspace, executor, async_id)
             DO UPDATE SET description = CASE
                             WHEN excluded.description <> '' THEN excluded.description
                             ELSE exbash_task.description
                           END,
                           command = CASE
                             WHEN excluded.command <> '' THEN excluded.command
                             ELSE exbash_task.command
                           END,
                           cwd = CASE
                             WHEN excluded.cwd <> '' THEN excluded.cwd
                             ELSE exbash_task.cwd
                           END,
                           time_start = MIN(exbash_task.time_start, excluded.time_start),
                           time_end = COALESCE(excluded.time_end, exbash_task.time_end),
                           exit_code = COALESCE(excluded.exit_code, exbash_task.exit_code),
                           time_updated = excluded.time_updated",
            rusqlite::params![
                async_id,
                session_id,
                workdir,
                executor,
                description,
                command,
                time_start,
                time_end,
                exit_code,
                ts
            ],
        )
        .map_err(|e| e.to_string())?;

        self.notify_exbash_changed(&session_id, &workdir);

        Ok(ExbashTaskSnapshot {
            async_id,
            executor,
            session_id: Some(session_id),
            workdir: Some(workdir),
            state: exbash_state(time_end, exit_code.as_deref()),
            pid: input.pid,
            exit_code: input.exit_code,
            started_at: Some(time_start),
            ended_at: time_end,
            command: Some(command),
            description: Some(description),
            total_output: input.total_output,
        })
    }

    async fn list_session_exbash(
        &self,
        session_id: &str,
        executor: Option<&str>,
    ) -> Result<Vec<ExbashTaskSnapshot>, Self::Error> {
        let conn = self.conn.lock().unwrap();
        let sql = if executor.is_some() {
            "SELECT async_id, executor, session_id, scope,
                    NULL as state,
                    exit_code, time_start, time_end, command, description, workspace
             FROM exbash_task
             WHERE session_id = ?1 AND executor = ?2 AND scope = 'local'
             ORDER BY time_start ASC"
        } else {
            "SELECT async_id, executor, session_id, scope,
                    NULL as state,
                    exit_code, time_start, time_end, command, description, workspace
             FROM exbash_task
             WHERE session_id = ?1 AND scope = 'local'
             ORDER BY time_start ASC"
        };
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = if let Some(executor) = executor {
            stmt.query_map(
                rusqlite::params![session_id, executor],
                exbash_row_to_snapshot,
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
        } else {
            stmt.query_map(rusqlite::params![session_id], exbash_row_to_snapshot)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
        }
        .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    async fn remove_session_exbash(
        &self,
        session_id: &str,
        async_id: &str,
        executor: &str,
    ) -> Result<bool, Self::Error> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .execute(
                "DELETE FROM exbash_task
                 WHERE session_id = ?1 AND async_id = ?2 AND executor = ?3 AND scope = 'local'",
                rusqlite::params![session_id, async_id, executor],
            )
            .map_err(|e| e.to_string())?;
        if rows > 0 {
            self.notify_exbash_changed(session_id, &self.workdir);
        }
        Ok(rows > 0)
    }
}

// ─── ExbashWorkdirStore ───

#[async_trait]
impl ExbashWorkdirStore for SqliteSessionHost {
    type Error = String;

    async fn check_workdir_exbash_create(
        &self,
        _session_id: &str,
        workdir: &str,
        input: &ExbashSyncInput,
    ) -> Result<(), Self::Error> {
        let executor = input.executor.as_deref().unwrap_or("local");
        let conn = self.conn.lock().unwrap();
        if let Some(async_id) = input.async_id.as_deref().filter(|value| !value.is_empty()) {
            let existing: i64 = conn
                .query_row(
                    "SELECT COUNT(*)
                     FROM exbash_task
                     WHERE workspace = ?1 AND executor = ?2 AND async_id = ?3 AND scope = 'workspace'",
                    rusqlite::params![workdir, executor, async_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if existing > 0 {
                return Ok(());
            }
        }
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM exbash_task
                 WHERE workspace = ?1 AND scope = 'workspace'",
                rusqlite::params![workdir],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count >= EXBASH_TASK_LIMIT {
            return Err(EXBASH_TASK_STACK_FULL_MESSAGE.to_string());
        }
        Ok(())
    }

    async fn workdir_exbash_snapshot(
        &self,
        _session_id: &str,
        workdir: &str,
        async_id: &str,
        executor: &str,
    ) -> Result<Option<ExbashTaskSnapshot>, Self::Error> {
        let conn = self.conn.lock().unwrap();
        let result = conn
            .prepare(
                "SELECT async_id, executor, session_id, scope,
                        NULL as state,
                        exit_code, time_start, time_end, command, description, workspace
                 FROM exbash_task
                 WHERE workspace = ?1 AND async_id = ?2 AND executor = ?3 AND scope = 'workspace'",
            )
            .map_err(|e| e.to_string())?
            .query_row(
                rusqlite::params![workdir, async_id, executor],
                exbash_row_to_snapshot,
            )
            .ok();
        Ok(result)
    }

    async fn upsert_workdir_exbash(
        &self,
        session_id: &str,
        workdir: &str,
        input: ExbashSyncInput,
    ) -> Result<ExbashTaskSnapshot, Self::Error> {
        let async_id = input.async_id.clone().unwrap_or_default();
        let executor = input.executor.clone().unwrap_or_else(|| "local".into());
        let command = input.command.clone().unwrap_or_default();
        let description = input.description.clone().unwrap_or_default();
        let time_start = input.started_at.unwrap_or_else(now_ms);
        let exit_code = exbash_exit_storage(&input);
        let time_end = exbash_time_end(&input, exit_code.as_deref());
        let session_id = input
            .session_id
            .clone()
            .unwrap_or_else(|| session_id.to_string());
        let ts = now_ms();

        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM exbash_task
             WHERE workspace = ?1 AND executor = ?2 AND async_id = ?3 AND scope = 'workspace'",
            rusqlite::params![workdir, executor, async_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO exbash_task
                (async_id, session_id, workspace, scope, executor, description, command, cwd,
                 time_start, time_end, exit_code, time_created, time_updated)
             VALUES (?1, ?2, ?3, 'workspace', ?4, ?5, ?6, ?3, ?7, ?8, ?9, ?10, ?10)
             ON CONFLICT(session_id, workspace, executor, async_id)
             DO UPDATE SET description = CASE
                             WHEN excluded.description <> '' THEN excluded.description
                             ELSE exbash_task.description
                           END,
                           command = CASE
                             WHEN excluded.command <> '' THEN excluded.command
                             ELSE exbash_task.command
                           END,
                           cwd = CASE
                             WHEN excluded.cwd <> '' THEN excluded.cwd
                             ELSE exbash_task.cwd
                           END,
                           time_start = MIN(exbash_task.time_start, excluded.time_start),
                           time_end = COALESCE(excluded.time_end, exbash_task.time_end),
                           exit_code = COALESCE(excluded.exit_code, exbash_task.exit_code),
                           time_updated = excluded.time_updated",
            rusqlite::params![
                async_id,
                session_id,
                workdir,
                executor,
                description,
                command,
                time_start,
                time_end,
                exit_code,
                ts
            ],
        )
        .map_err(|e| e.to_string())?;

        self.notify_exbash_changed(&session_id, workdir);

        Ok(ExbashTaskSnapshot {
            async_id,
            executor,
            session_id: Some(session_id),
            workdir: Some(workdir.to_string()),
            state: exbash_state(time_end, exit_code.as_deref()),
            pid: input.pid,
            exit_code: input.exit_code,
            started_at: Some(time_start),
            ended_at: time_end,
            command: Some(command),
            description: Some(description),
            total_output: input.total_output,
        })
    }

    async fn list_workdir_exbash(
        &self,
        _session_id: &str,
        workdir: &str,
        executor: Option<&str>,
    ) -> Result<Vec<ExbashTaskSnapshot>, Self::Error> {
        let conn = self.conn.lock().unwrap();
        let sql = if executor.is_some() {
            "SELECT async_id, executor, session_id, scope,
                    NULL as state,
                    exit_code, time_start, time_end, command, description, workspace
             FROM exbash_task
             WHERE workspace = ?1 AND executor = ?2 AND scope = 'workspace'
             ORDER BY time_start ASC"
        } else {
            "SELECT async_id, executor, session_id, scope,
                    NULL as state,
                    exit_code, time_start, time_end, command, description, workspace
             FROM exbash_task
             WHERE workspace = ?1 AND scope = 'workspace'
             ORDER BY time_start ASC"
        };
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = if let Some(executor) = executor {
            stmt.query_map(rusqlite::params![workdir, executor], exbash_row_to_snapshot)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
        } else {
            stmt.query_map(rusqlite::params![workdir], exbash_row_to_snapshot)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
        }
        .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    async fn remove_workdir_exbash(
        &self,
        _session_id: &str,
        workdir: &str,
        async_id: &str,
        executor: &str,
    ) -> Result<bool, Self::Error> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .execute(
                "DELETE FROM exbash_task
                 WHERE workspace = ?1 AND async_id = ?2 AND executor = ?3 AND scope = 'workspace'",
                rusqlite::params![workdir, async_id, executor],
            )
            .map_err(|e| e.to_string())?;
        if rows > 0 {
            self.notify_exbash_changed(_session_id, workdir);
        }
        Ok(rows > 0)
    }
}

// ─── RemoteExecutorConfigStore ───

const EXECUTOR_CONFIG_FILE: &str = "remote_executor_infos.json";

fn workspace_executor_config_path(workdir: &str) -> PathBuf {
    Path::new(workdir)
        .join(".opencode")
        .join(EXECUTOR_CONFIG_FILE)
}

fn read_json_config(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&text).unwrap_or_else(|_| json!({})))
}

fn read_remote_executor_config_value(workdir: &str) -> Result<Value, String> {
    let user = crate::opencode_config_path(EXECUTOR_CONFIG_FILE);
    let user = if user.exists() {
        read_json_config(&user)?
    } else {
        json!({})
    };
    let workspace = workspace_executor_config_path(workdir);
    if !workspace.exists() {
        return Ok(user);
    }
    Ok(merge_executor_configs(user, read_json_config(&workspace)?))
}

fn merge_executor_configs(user: Value, workspace: Value) -> Value {
    let mut executors = executor_entries(user);
    for entry in executor_entries(workspace) {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty());
        if let Some(id) = id {
            if let Some(existing) = executors
                .iter_mut()
                .find(|existing| existing.get("id").and_then(Value::as_str) == Some(id))
            {
                *existing = entry;
                continue;
            }
        }
        executors.push(entry);
    }
    json!({ "executors": executors })
}

fn workspace_overlay_config(config: Value) -> Result<Value, String> {
    let mut overlay = Vec::new();
    let user = crate::opencode_config_path(EXECUTOR_CONFIG_FILE);
    let users = if user.exists() {
        executor_entries(read_json_config(&user)?)
    } else {
        Vec::new()
    };
    for entry in executor_entries(config) {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let unchanged = id
            .and_then(|id| {
                users
                    .iter()
                    .find(|user| user.get("id").and_then(Value::as_str) == Some(id))
            })
            .is_some_and(|user| user == &entry);
        if !unchanged {
            overlay.push(entry);
        }
    }
    Ok(json!({ "executors": overlay }))
}

fn executor_entries(value: Value) -> Vec<Value> {
    match value {
        Value::Array(entries) => entries,
        Value::Object(mut object) => object
            .remove("executors")
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

#[async_trait]
impl RemoteExecutorConfigStore for SqliteSessionHost {
    type Error = String;

    async fn read_remote_executor_config(
        &self,
        workdir: &str,
    ) -> Result<RemoteExecutorConfigSnapshot, Self::Error> {
        let config = read_remote_executor_config_value(workdir)?;
        Ok(RemoteExecutorConfigSnapshot {
            workdir: workdir.to_string(),
            config,
        })
    }

    async fn update_remote_executor_config(
        &self,
        workdir: &str,
        patch: Value,
    ) -> Result<RemoteExecutorConfigSnapshot, Self::Error> {
        let config_path = workspace_executor_config_path(workdir);
        let patch = workspace_overlay_config(patch)?;
        if patch
            .get("executors")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            if config_path.exists() {
                std::fs::remove_file(&config_path).map_err(|e| e.to_string())?;
            }
            return Ok(RemoteExecutorConfigSnapshot {
                workdir: workdir.to_string(),
                config: patch,
            });
        }
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&config_path, serde_json::to_string_pretty(&patch).unwrap())
            .map_err(|e| e.to_string())?;
        Ok(RemoteExecutorConfigSnapshot {
            workdir: workdir.to_string(),
            config: patch,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::Mutex as StdMutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    struct EnvGuard {
        key: &'static str,
        old: Option<OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &Path) -> Self {
            let old = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, old }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(old) = self.old.as_ref() {
                std::env::set_var(self.key, old);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "refs-opencode-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn remote_executor_config_merges_user_and_workspace_config() {
        let _guard = ENV_LOCK.lock().unwrap();
        let root = temp_root("executor-config-fallback");
        let user = root.join("user");
        let workdir = root.join("workspace");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        let _env = EnvGuard::set("OPENCODE_CONFIG_DIR", &user);

        std::fs::write(
            user.join(EXECUTOR_CONFIG_FILE),
            json!({"executors":[
                {"id":"user-exec","url":"ws://user"},
                {"id":"shared-exec","url":"ws://user-shared","system":"user-system"}
            ]})
            .to_string(),
        )
        .unwrap();
        let value = read_remote_executor_config_value(workdir.to_str().unwrap()).unwrap();
        assert_eq!(value["executors"][0]["id"], "user-exec");
        assert_eq!(value["executors"][1]["id"], "shared-exec");

        let workspace_config = workspace_executor_config_path(workdir.to_str().unwrap());
        std::fs::create_dir_all(workspace_config.parent().unwrap()).unwrap();
        std::fs::write(
            workspace_config,
            json!({"executors":[
                {"id":"shared-exec","url":"ws://workspace-shared","device":"workspace-device"},
                {"id":"workspace-exec","url":"ws://workspace"}
            ]})
            .to_string(),
        )
        .unwrap();
        let value = read_remote_executor_config_value(workdir.to_str().unwrap()).unwrap();
        assert_eq!(value["executors"][0]["id"], "user-exec");
        assert_eq!(value["executors"][1]["id"], "shared-exec");
        assert_eq!(value["executors"][1]["url"], "ws://workspace-shared");
        assert!(value["executors"][1]["system"].is_null());
        assert_eq!(value["executors"][1]["device"], "workspace-device");
        assert_eq!(value["executors"][2]["id"], "workspace-exec");

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn remote_executor_config_write_keeps_only_workspace_overlay() {
        let _guard = ENV_LOCK.lock().unwrap();
        let root = temp_root("executor-config-overlay");
        let user = root.join("user");
        let workdir = root.join("workspace");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();
        let _env = EnvGuard::set("OPENCODE_CONFIG_DIR", &user);

        let user_config = json!({"executors":[
            {"id":"user-exec","url":"ws://user"},
            {"id":"shared-exec","url":"ws://user-shared"}
        ]});
        std::fs::write(user.join(EXECUTOR_CONFIG_FILE), user_config.to_string()).unwrap();

        let overlay = workspace_overlay_config(json!({"executors":[
            {"id":"user-exec","url":"ws://user"},
            {"id":"shared-exec","url":"ws://workspace-shared"},
            {"id":"workspace-exec","url":"ws://workspace"}
        ]}))
        .unwrap();
        assert_eq!(overlay["executors"].as_array().unwrap().len(), 2);
        assert_eq!(overlay["executors"][0]["id"], "shared-exec");
        assert_eq!(overlay["executors"][1]["id"], "workspace-exec");

        let overlay = workspace_overlay_config(user_config).unwrap();
        assert!(overlay["executors"].as_array().unwrap().is_empty());

        std::fs::remove_dir_all(root).ok();
    }
}
