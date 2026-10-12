use crate::{analysis::fingerprint, model::*};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};

const CACHE_VERSION: i64 = 1;
#[derive(Clone)]
pub struct Store {
    pub path: PathBuf,
}
impl Store {
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p)?;
        }
        let s = Self { path };
        // SQLite's initial WAL mode transition can return BUSY immediately when
        // independent processes open a fresh database together. Retry with a new
        // connection so no reader retains the lock needed by the other opener.
        for attempt in 0..20 {
            let result = s.connection()?.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS analysis (path TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS session (key TEXT PRIMARY KEY, data TEXT NOT NULL);");
            match result {
                Ok(()) => break,
                Err(rusqlite::Error::SqliteFailure(ref code, _))
                    if attempt < 19
                        && matches!(
                            code.code,
                            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                        ) =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(50))
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(s)
    }
    fn connection(&self) -> Result<Connection> {
        let c = Connection::open(&self.path)?;
        c.busy_timeout(std::time::Duration::from_secs(10))?;
        Ok(c)
    }
    pub fn cached(&self, path: &Path) -> Result<Option<Analysis>> {
        let canonical = path.canonicalize()?;
        let fp = fingerprint(&canonical)?;
        let data: Option<String> = self
            .connection()?
            .query_row(
                "SELECT data FROM analysis WHERE path=? AND version=?",
                params![canonical.to_string_lossy(), CACHE_VERSION],
                |r| r.get(0),
            )
            .optional()?;
        Ok(data
            .and_then(|s| serde_json::from_str::<Analysis>(&s).ok())
            .filter(|a| a.fingerprint == fp))
    }
    pub fn cache(&self, a: &Analysis) -> Result<()> {
        self.connection()?.execute(
            "INSERT OR REPLACE INTO analysis VALUES (?1,?2,?3)",
            params![
                a.path.to_string_lossy(),
                CACHE_VERSION,
                serde_json::to_string(a)?
            ],
        )?;
        Ok(())
    }
    pub fn record(&self, op: &Operation) -> Result<()> {
        self.connection()?.execute(
            "INSERT OR REPLACE INTO operations VALUES (?1,?2,?3)",
            params![op.id, op.timestamp as i64, serde_json::to_string(op)?],
        )?;
        Ok(())
    }
    pub fn operation(&self, id: &str) -> Result<Option<Operation>> {
        let data: Option<String> = self
            .connection()?
            .query_row("SELECT data FROM operations WHERE id=?", [id], |r| r.get(0))
            .optional()?;
        data.map(|d| Ok(serde_json::from_str(&d)?)).transpose()
    }
    pub fn history(&self) -> Result<Vec<Operation>> {
        let c = self.connection()?;
        let mut s = c.prepare(
            "SELECT data FROM operations ORDER BY timestamp DESC, rowid DESC LIMIT 1000",
        )?;
        let rows = s.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn save_session(&self, paths: &[PathBuf]) -> Result<()> {
        self.connection()?.execute(
            "INSERT OR REPLACE INTO session VALUES ('paths', ?1)",
            [serde_json::to_string(paths)?],
        )?;
        Ok(())
    }
    pub fn session(&self) -> Result<Vec<PathBuf>> {
        let data: Option<String> = self
            .connection()?
            .query_row("SELECT data FROM session WHERE key='paths'", [], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(data
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default())
    }
}
