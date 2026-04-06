import * as fs from 'fs'
import type { TranscriptSegment, WhisperModelSize } from './transcriptionService'

const initSqlJs = require('sql.js')

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS voice_transcripts (
    steam_id TEXT NOT NULL,
    audio_filename TEXT NOT NULL,
    model TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT '',
    segments TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (steam_id, audio_filename)
  )
`

/**
 * Ensure the voice_transcripts table exists in the given match database.
 * Writes the database back to disk only if we actually ran a migration.
 */
export async function ensureTranscriptTable(dbPath: string): Promise<void> {
  const SQL = await initSqlJs()
  const buffer = fs.readFileSync(dbPath)
  const db = new SQL.Database(buffer)
  try {
    db.run(CREATE_TABLE_SQL)
    const data = db.export()
    fs.writeFileSync(dbPath, Buffer.from(data))
  } finally {
    db.close()
  }
}

/**
 * Look up a cached transcript from the database.
 * Returns null if not found.
 */
export async function getCachedTranscript(
  dbPath: string,
  steamId: string,
  audioFilename: string,
  model: string
): Promise<{ segments: TranscriptSegment[]; model: string; language: string } | null> {
  if (!fs.existsSync(dbPath)) return null

  const SQL = await initSqlJs()
  const buffer = fs.readFileSync(dbPath)
  const db = new SQL.Database(buffer)
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='voice_transcripts'")
    if (!tables.length || !tables[0].values.length) return null

    const stmt = db.prepare('SELECT segments, model, language FROM voice_transcripts WHERE steam_id = ? AND audio_filename = ? AND model = ?')
    stmt.bind([steamId, audioFilename, model])
    if (stmt.step()) {
      const row = stmt.getAsObject() as { segments: string; model: string; language: string }
      stmt.free()
      return {
        segments: JSON.parse(row.segments) as TranscriptSegment[],
        model: row.model,
        language: row.language,
      }
    }
    stmt.free()
    return null
  } finally {
    db.close()
  }
}

/**
 * Save transcript segments to the database.
 */
export async function saveTranscript(
  dbPath: string,
  steamId: string,
  audioFilename: string,
  model: WhisperModelSize,
  language: string,
  segments: TranscriptSegment[]
): Promise<void> {
  await ensureTranscriptTable(dbPath)

  const SQL = await initSqlJs()
  const buffer = fs.readFileSync(dbPath)
  const db = new SQL.Database(buffer)
  try {
    db.run(
      `INSERT OR REPLACE INTO voice_transcripts
         (steam_id, audio_filename, model, language, segments, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [steamId, audioFilename, model, language, JSON.stringify(segments), Date.now()]
    )
    const data = db.export()
    fs.writeFileSync(dbPath, Buffer.from(data))
  } finally {
    db.close()
  }
}
