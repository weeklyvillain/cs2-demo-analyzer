import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { getSetting } from './settings'

const initSqlJs = require('sql.js')

export interface MatchInfo {
  id: string
  map: string
  startedAt: string | null
  playerCount: number
  demoPath: string | null
  isMissingDemo?: boolean
  createdAtIso?: string | null
}

export interface TableInfo {
  name: string
  rowCount: number
  schema: string
}

export interface QueryResult {
  columns: string[]
  rows: any[][]
}

/**
 * Get the matches directory path
 */
export function getMatchesDir(): string {
  const appDataPath = app.getPath('userData')
  return path.join(appDataPath, 'matches')
}

/**
 * Ensure matches directory exists
 */
export function ensureMatchesDir(): void {
  const matchesDir = getMatchesDir()
  if (!fs.existsSync(matchesDir)) {
    fs.mkdirSync(matchesDir, { recursive: true })
  }
}

/**
 * Get demo path from database meta table or matches.demo_path
 */
async function getDemoPathFromDb(dbPath: string): Promise<string | null> {
  try {
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)
    
    // Try meta table first
    try {
      const metaStmt = db.prepare('SELECT value FROM meta WHERE key = ?')
      metaStmt.bind(['demo_path'])
      if (metaStmt.step()) {
        const demoPath = metaStmt.get()[0]
        metaStmt.free()
        db.close()
        return demoPath || null
      }
      metaStmt.free()
    } catch {
      // Meta table might not exist or query failed
    }
    
    // Try matches.demo_path column (if it exists)
    try {
      const matchStmt = db.prepare('SELECT demo_path FROM matches LIMIT 1')
      if (matchStmt.step()) {
        const result = matchStmt.getAsObject()
        matchStmt.free()
        db.close()
        return result.demo_path || null
      }
      matchStmt.free()
    } catch {
      // Column might not exist
    }
    
    db.close()
    return null
  } catch (err) {
    console.error(`Failed to read demo_path from ${dbPath}:`, err)
    return null
  }
}

/**
 * Get created_at_iso from database meta table
 */
async function getCreatedAtIso(dbPath: string): Promise<string | null> {
  try {
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)
    
    try {
      const metaStmt = db.prepare('SELECT value FROM meta WHERE key = ?')
      metaStmt.bind(['created_at_iso'])
      if (metaStmt.step()) {
        const createdAt = metaStmt.get()[0]
        metaStmt.free()
        db.close()
        return createdAt || null
      }
      metaStmt.free()
    } catch {
      // Meta table might not exist
    }
    
    db.close()
    return null
  } catch (err) {
    return null
  }
}

/**
 * Check database integrity and return orphan status
 */
async function checkDbIntegrity(dbPath: string): Promise<{ isOrphan: boolean; demoPath: string | null; isCorrupt: boolean }> {
  let isCorrupt = false
  let demoPath: string | null = null
  
  try {
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)
    
    // Try to read demo_path
    demoPath = await getDemoPathFromDb(dbPath)
    
    db.close()
  } catch (err) {
    console.error(`Database ${dbPath} is corrupt or unreadable:`, err)
    isCorrupt = true
    return { isOrphan: true, demoPath: null, isCorrupt: true }
  }
  
  // Check if demo file exists
  const isOrphan = !demoPath || !fs.existsSync(demoPath)
  
  return { isOrphan, demoPath, isCorrupt: false }
}

/**
 * Perform startup integrity check
 * Returns list of orphaned/corrupt databases that were deleted
 */
export async function performStartupIntegrityCheck(): Promise<Array<{ matchId: string; reason: string }>> {
  const matchesDir = getMatchesDir()
  const deleted: Array<{ matchId: string; reason: string }> = []
  
  if (!fs.existsSync(matchesDir)) {
    return deleted
  }
  
  const files = fs.readdirSync(matchesDir)
  const autoCleanup = getSetting('auto_cleanup_missing_demos', 'true') === 'true'
  
  for (const file of files) {
    if (!file.endsWith('.sqlite')) continue
    
    const matchId = path.basename(file, '.sqlite')
    const dbPath = path.join(matchesDir, file)
    
    const { isOrphan, isCorrupt } = await checkDbIntegrity(dbPath)
    
    if (isCorrupt) {
      // Always delete corrupt databases
      try {
        fs.unlinkSync(dbPath)
        deleted.push({ matchId, reason: 'corrupt database' })
        console.log(`[Integrity] Deleted corrupt database: ${matchId}`)
      } catch (err) {
        console.error(`[Integrity] Failed to delete corrupt database ${matchId}:`, err)
      }
    } else if (isOrphan && autoCleanup) {
      // Delete orphan if auto cleanup is enabled
      try {
        fs.unlinkSync(dbPath)
        deleted.push({ matchId, reason: 'missing demo file' })
        console.log(`[Integrity] Deleted orphan database (missing demo): ${matchId}`)
      } catch (err) {
        console.error(`[Integrity] Failed to delete orphan database ${matchId}:`, err)
      }
    }
  }
  
  return deleted
}

/**
 * List all matches with integrity status
 */
export async function listMatches(): Promise<MatchInfo[]> {
  const matchesDir = getMatchesDir()
  
  if (!fs.existsSync(matchesDir)) {
    return []
  }
  
  const files = fs.readdirSync(matchesDir)
  const matches: MatchInfo[] = []
  const SQL = await initSqlJs()
  
  for (const file of files) {
    if (!file.endsWith('.sqlite')) continue
    
    const matchId = path.basename(file, '.sqlite')
    const dbPath = path.join(matchesDir, file)
    
    try {
      const buffer = fs.readFileSync(dbPath)
      const db = new SQL.Database(buffer)
      
      // Get match info
      const matchStmt = db.prepare('SELECT map, started_at FROM matches WHERE id = ?')
      matchStmt.bind([matchId])
      const matchResult = matchStmt.step() ? {
        map: matchStmt.get()[0],
        started_at: matchStmt.get()[1]
      } : null
      matchStmt.free()
      
      // Get player count
      const playerStmt = db.prepare('SELECT COUNT(*) FROM players WHERE match_id = ?')
      playerStmt.bind([matchId])
      const playerCount = playerStmt.step() ? playerStmt.get()[0] : 0
      playerStmt.free()
      
      // Get demo path and created_at
      const demoPath = await getDemoPathFromDb(dbPath)
      const createdAtIso = await getCreatedAtIso(dbPath)
      
      // Check if demo is missing
      const isMissingDemo = !demoPath || !fs.existsSync(demoPath)
      
      db.close()
      
      matches.push({
        id: matchId,
        map: matchResult?.map || matchId,
        startedAt: matchResult?.started_at || null,
        playerCount: playerCount || 0,
        demoPath: demoPath || null,
        isMissingDemo,
        createdAtIso: createdAtIso || null,
      })
    } catch (err) {
      // Skip corrupted databases (they should be cleaned up by integrity check)
      console.error(`Failed to read match ${matchId}:`, err)
    }
  }
  
  // Sort by created_at_iso descending, or started_at, or id
  return matches.sort((a, b) => {
    if (a.createdAtIso && b.createdAtIso) {
      return new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime()
    }
    if (a.startedAt && b.startedAt) {
      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    }
    return b.id.localeCompare(a.id)
  })
}

/**
 * Delete specific matches by their IDs
 */
export async function deleteMatches(matchIds: string[]): Promise<number> {
  const matchesDir = getMatchesDir()
  
  if (!fs.existsSync(matchesDir)) {
    return 0
  }
  
  let deleted = 0
  
  for (const matchId of matchIds) {
    const dbPath = path.join(matchesDir, `${matchId}.sqlite`)
    if (fs.existsSync(dbPath)) {
      try {
        fs.unlinkSync(dbPath)
        deleted++
        console.log(`Deleted match: ${matchId}`)
      } catch (err) {
        console.error(`Failed to delete ${matchId}:`, err)
      }
    }
  }
  
  return deleted
}

/**
 * Delete all matches
 */
export async function deleteAllMatches(): Promise<number> {
  const matchesDir = getMatchesDir()
  
  if (!fs.existsSync(matchesDir)) {
    return 0
  }
  
  const files = fs.readdirSync(matchesDir)
  let deleted = 0
  
  for (const file of files) {
    if (!file.endsWith('.sqlite')) continue
    
    const dbPath = path.join(matchesDir, file)
    try {
      fs.unlinkSync(dbPath)
      deleted++
    } catch (err) {
      console.error(`Failed to delete ${dbPath}:`, err)
    }
  }
  
  // Also delete demo_paths.json if it exists
  const demoPathsFile = path.join(matchesDir, 'demo_paths.json')
  if (fs.existsSync(demoPathsFile)) {
    try {
      fs.unlinkSync(demoPathsFile)
    } catch (err) {
      console.error(`Failed to delete ${demoPathsFile}:`, err)
    }
  }
  
  return deleted
}

/**
 * Trim matches to keep only N most recent (by created_at_iso)
 */
export async function trimMatchesToCap(cap: number): Promise<Array<{ matchId: string; reason: string }>> {
  const matches = await listMatches()
  const deleted: Array<{ matchId: string; reason: string }> = []
  
  if (matches.length <= cap) {
    return deleted
  }
  
  // Sort by created_at_iso ascending (oldest first)
  const sorted = [...matches].sort((a, b) => {
    if (a.createdAtIso && b.createdAtIso) {
      return new Date(a.createdAtIso).getTime() - new Date(b.createdAtIso).getTime()
    }
    if (a.startedAt && b.startedAt) {
      return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
    }
    return a.id.localeCompare(b.id)
  })
  
  // Delete oldest matches until we're at cap
  const toDelete = sorted.slice(0, sorted.length - cap)
  const matchesDir = getMatchesDir()
  
  for (const match of toDelete) {
    const dbPath = path.join(matchesDir, `${match.id}.sqlite`)
    try {
      fs.unlinkSync(dbPath)
      deleted.push({ matchId: match.id, reason: 'match cap limit' })
      console.log(`[Cap] Deleted old match: ${match.id}`)
    } catch (err) {
      console.error(`[Cap] Failed to delete ${match.id}:`, err)
    }
  }
  
  return deleted
}

/**
 * Get list of tables in a match database
 */
export async function listTables(matchId: string): Promise<string[]> {
  const matchesDir = getMatchesDir()
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)
  
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }
  
  try {
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)
    
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    const tables: string[] = []
    
    while (stmt.step()) {
      const row = stmt.getAsObject()
      tables.push(row.name as string)
    }
    
    stmt.free()
    db.close()
    
    return tables
  } catch (err) {
    throw new Error(`Failed to list tables: ${err}`)
  }
}

/**
 * Get table schema and row count
 */
export async function getTableInfo(matchId: string, tableName: string): Promise<TableInfo> {
  const matchesDir = getMatchesDir()
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)
  
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }
  
  try {
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)
    
    // Get schema
    const schemaStmt = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    schemaStmt.bind([tableName])
    const schema = schemaStmt.step() ? schemaStmt.get()[0] : ''
    schemaStmt.free()
    
    // Get row count
    const countStmt = db.prepare(`SELECT COUNT(*) FROM ${tableName}`)
    const rowCount = countStmt.step() ? countStmt.get()[0] : 0
    countStmt.free()
    
    db.close()
    
    return {
      name: tableName,
      rowCount: rowCount as number,
      schema: schema as string || '',
    }
  } catch (err) {
    throw new Error(`Failed to get table info: ${err}`)
  }
}

/**
 * Sanitize SQL query - only allow SELECT and PRAGMA table_info
 */
function sanitizeQuery(sql: string): { isValid: boolean; sanitized: string } {
  const trimmed = sql.trim()
  const upper = trimmed.toUpperCase()
  
  // Only allow SELECT and PRAGMA table_info
  if (!upper.startsWith('SELECT') && !upper.startsWith('PRAGMA TABLE_INFO')) {
    return { isValid: false, sanitized: '' }
  }
  
  // Block dangerous keywords
  const dangerous = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'EXEC', 'EXECUTE']
  for (const keyword of dangerous) {
    if (upper.includes(keyword)) {
      return { isValid: false, sanitized: '' }
    }
  }
  
  // Auto-inject LIMIT if not present
  let sanitized = trimmed
  if (upper.startsWith('SELECT') && !upper.includes('LIMIT')) {
    // Check if there's already a semicolon
    if (trimmed.endsWith(';')) {
      sanitized = trimmed.slice(0, -1) + ' LIMIT 200;'
    } else {
      sanitized = trimmed + ' LIMIT 200'
    }
  }
  
  return { isValid: true, sanitized }
}

/**
 * Run a SELECT query (read-only)
 */
export async function runSelectQuery(matchId: string, sql: string): Promise<QueryResult> {
  const { isValid, sanitized } = sanitizeQuery(sql)
  
  if (!isValid) {
    throw new Error('Only SELECT and PRAGMA table_info queries are allowed')
  }
  
  const matchesDir = getMatchesDir()
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)
  
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }
  
  try {
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)
    
    // Use exec to get both column names and rows
    const result = db.exec(sanitized)
    
    if (result.length === 0) {
      db.close()
      return { columns: [], rows: [] }
    }
    
    const firstResult = result[0]
    const columns = firstResult.columns
    const rows = firstResult.values
    
    db.close()
    
    return { columns, rows }
  } catch (err) {
    throw new Error(`Query failed: ${err}`)
  }
}
