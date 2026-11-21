//! DB viewer backend (Electron `listTables` / `getTableInfo` / `runSelectQuery`).
//!
//! Databases are opened read-only, so nothing a query does can change a match file;
//! the Electron keyword check and auto `LIMIT 200` are kept on top so the viewer
//! accepts and rejects the same queries.

use anyhow::{Result, bail};
use rusqlite::types::ValueRef;

use crate::matches::open_match;
use crate::paths;

/// Row limit added to SELECTs that have none.
pub const AUTO_LIMIT: u32 = 200;
/// Rows shown in the table preview.
pub const PREVIEW_ROWS: u32 = 100;

#[derive(Debug, Clone)]
pub struct TableInfo {
    pub name: String,
    pub row_count: i64,
    pub schema: String,
}

/// Query results with every cell as display text; `None` is SQL NULL.
#[derive(Debug, Clone, Default)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}

fn open(match_id: &str) -> Result<rusqlite::Connection> {
    let path = paths::match_db(match_id);
    if !path.exists() {
        bail!("Match {match_id} not found");
    }
    open_match(&path)
}

pub fn list_tables(match_id: &str) -> Result<Vec<String>> {
    let conn = open(match_id)?;
    let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?;
    let tables = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(tables)
}

/// Electron only accepts plain identifiers as table names in the viewer.
pub fn is_valid_table_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn table_info(match_id: &str, table: &str) -> Result<TableInfo> {
    if !is_valid_table_name(table) {
        bail!("Invalid table name");
    }
    let conn = open(match_id)?;
    let schema: String = conn
        .query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name=?1", [table], |r| {
            r.get::<_, Option<String>>(0)
        })
        .ok()
        .flatten()
        .unwrap_or_default();
    let row_count: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| r.get(0))?;
    Ok(TableInfo { name: table.to_string(), row_count, schema })
}

/// First rows of a table, like the Electron preview (`SELECT * … LIMIT 100`).
pub fn preview_rows(match_id: &str, table: &str) -> Result<QueryResult> {
    if !is_valid_table_name(table) {
        bail!("Invalid table name");
    }
    let conn = open(match_id)?;
    execute(&conn, &format!("SELECT * FROM \"{table}\" LIMIT {PREVIEW_ROWS}"))
}

/// Electron's `sanitizeQuery`: only SELECT and `PRAGMA table_info`, no write keywords,
/// and `LIMIT 200` appended to a SELECT without one. `None` when the query is refused.
pub fn sanitize(sql: &str) -> Option<String> {
    let trimmed = sql.trim();
    let upper = trimmed.to_uppercase();
    if !upper.starts_with("SELECT") && !upper.starts_with("PRAGMA TABLE_INFO") {
        return None;
    }
    const DANGEROUS: [&str; 9] =
        ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE", "EXEC", "EXECUTE"];
    if DANGEROUS.iter().any(|k| upper.contains(k)) {
        return None;
    }
    if upper.starts_with("SELECT") && !upper.contains("LIMIT") {
        return Some(match trimmed.strip_suffix(';') {
            Some(body) => format!("{body} LIMIT {AUTO_LIMIT};"),
            None => format!("{trimmed} LIMIT {AUTO_LIMIT}"),
        });
    }
    Some(trimmed.to_string())
}

pub fn run_query(match_id: &str, sql: &str) -> Result<QueryResult> {
    let Some(sql) = sanitize(sql) else {
        bail!("Only SELECT and PRAGMA table_info queries are allowed");
    };
    let conn = open(match_id)?;
    execute(&conn, &sql).map_err(|e| anyhow::anyhow!("Query failed: {e}"))
}

fn execute(conn: &rusqlite::Connection, sql: &str) -> Result<QueryResult> {
    // sql.js `exec` runs only the first statement's results that matter here.
    let sql = sql.trim().trim_end_matches(';');
    let mut stmt = conn.prepare(sql)?;
    let columns: Vec<String> = stmt.column_names().into_iter().map(str::to_string).collect();
    let n = columns.len();
    let mut rows = Vec::new();
    let mut query = stmt.query([])?;
    while let Some(row) = query.next()? {
        let mut cells = Vec::with_capacity(n);
        for i in 0..n {
            cells.push(match row.get_ref(i)? {
                ValueRef::Null => None,
                ValueRef::Integer(v) => Some(v.to_string()),
                ValueRef::Real(v) => Some(v.to_string()),
                ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(b) => Some(format!("<{} bytes>", b.len())),
            });
        }
        rows.push(cells);
    }
    Ok(QueryResult { columns, rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_matches_electron() {
        assert_eq!(sanitize("select * from players").as_deref(), Some("select * from players LIMIT 200"));
        assert_eq!(sanitize("SELECT 1;").as_deref(), Some("SELECT 1 LIMIT 200;"));
        assert_eq!(sanitize("SELECT * FROM t LIMIT 5").as_deref(), Some("SELECT * FROM t LIMIT 5"));
        assert_eq!(sanitize("PRAGMA table_info(players)").as_deref(), Some("PRAGMA table_info(players)"));
        assert!(sanitize("DELETE FROM players").is_none());
        assert!(sanitize("SELECT 1; DROP TABLE players").is_none());
        assert!(sanitize("PRAGMA journal_mode").is_none());
    }

    #[test]
    fn reads_a_real_match() {
        let Ok(matches) = crate::matches::list_matches() else { return };
        let Some(m) = matches.first() else { return };
        let tables = list_tables(&m.id).unwrap();
        assert!(tables.iter().any(|t| t == "players"));
        let info = table_info(&m.id, "players").unwrap();
        assert!(info.schema.contains("CREATE TABLE"));
        let preview = preview_rows(&m.id, "players").unwrap();
        assert_eq!(preview.rows.len() as i64, info.row_count.min(PREVIEW_ROWS as i64));
        let r = run_query(&m.id, "SELECT steamid, name FROM players").unwrap();
        assert_eq!(r.columns, vec!["steamid", "name"]);
        assert!(run_query(&m.id, "UPDATE players SET name = 'x'").is_err());
        assert!(table_info(&m.id, "players; --").is_err());
    }
}
