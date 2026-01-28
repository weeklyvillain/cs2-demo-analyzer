import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
const initSqlJs = require('sql.js')

let statsDb: any = null

// Get stats database path
function getStatsDbPath(): string {
  const appDataPath = app.getPath('userData')
  return path.join(appDataPath, 'stats.sqlite')
}

// Initialize stats database
export async function initStatsDb(): Promise<void> {
  const dbPath = getStatsDbPath()
  const SQL = await initSqlJs()
  
  // Create database if it doesn't exist
  if (!fs.existsSync(dbPath)) {
    statsDb = new SQL.Database()
    // Create stats tables
    statsDb.run(`
      CREATE TABLE IF NOT EXISTS stats (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
    
    // Initialize default stats
    statsDb.run(`INSERT OR IGNORE INTO stats (key, value) VALUES ('total_demos_parsed', '0')`)
    statsDb.run(`INSERT OR IGNORE INTO stats (key, value) VALUES ('total_voices_extracted', '0')`)
    statsDb.run(`INSERT OR IGNORE INTO stats (key, value) VALUES ('largest_demo_parsed', '0')`)
    statsDb.run(`INSERT OR IGNORE INTO stats (key, value) VALUES ('smallest_demo_parsed', '0')`)
    statsDb.run(`INSERT OR IGNORE INTO stats (key, value) VALUES ('total_demo_size', '0')`)
    statsDb.run(`INSERT OR IGNORE INTO stats (key, value) VALUES ('total_parsing_time_ms', '0')`)
    statsDb.run(`INSERT OR IGNORE INTO stats (key, value) VALUES ('total_voice_extraction_ms', '0')`)
    statsDb.run(`INSERT OR IGNORE INTO stats (key, value) VALUES ('voice_files_generated', '0')`)
    
    // Save to file
    const data = statsDb.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(dbPath, buffer)
  } else {
    // Load existing database
    const buffer = fs.readFileSync(dbPath)
    statsDb = new SQL.Database(buffer)
    
    // Ensure default stats exist
    const checkStmt = statsDb.prepare('SELECT value FROM stats WHERE key = ?')
    checkStmt.bind(['total_demos_parsed'])
    if (!checkStmt.step()) {
      statsDb.run(`INSERT INTO stats (key, value) VALUES ('total_demos_parsed', '0')`)
    }
    checkStmt.free()
    
    const checkStmt2 = statsDb.prepare('SELECT value FROM stats WHERE key = ?')
    checkStmt2.bind(['total_voices_extracted'])
    if (!checkStmt2.step()) {
      statsDb.run(`INSERT INTO stats (key, value) VALUES ('total_voices_extracted', '0')`)
    }
    checkStmt2.free()
    
    // Save after ensuring defaults
    const data = statsDb.export()
    const buffer2 = Buffer.from(data)
    fs.writeFileSync(dbPath, buffer2)
  }
}

// Get a stat value
function getStat(key: string, defaultValue: string = '0'): string {
  if (!statsDb) {
    return defaultValue
  }
  
  try {
    const stmt = statsDb.prepare('SELECT value FROM stats WHERE key = ?')
    stmt.bind([key])
    
    if (stmt.step()) {
      const result = stmt.getAsObject()
      stmt.free()
      return result.value || defaultValue
    }
    stmt.free()
    return defaultValue
  } catch (err) {
    console.error(`Error getting stat ${key}:`, err)
    return defaultValue
  }
}

// Increment a stat value
export function incrementStat(key: string, amount: number = 1): void {
  if (!statsDb) {
    console.error('Stats database not initialized')
    return
  }
  
  try {
    const currentValue = parseInt(getStat(key, '0'), 10)
    const newValue = (currentValue + amount).toString()
    
    const stmt = statsDb.prepare('INSERT OR REPLACE INTO stats (key, value) VALUES (?, ?)')
    stmt.run([key, newValue])
    stmt.free()
    
    // Save to file
    const dbPath = getStatsDbPath()
    const data = statsDb.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(dbPath, buffer)
  } catch (err) {
    console.error(`Error incrementing stat ${key}:`, err)
  }
}

// Set a stat to a specific value
export function setStat(key: string, value: string): void {
  if (!statsDb) {
    console.error('Stats database not initialized')
    return
  }
  
  try {
    const stmt = statsDb.prepare('INSERT OR REPLACE INTO stats (key, value) VALUES (?, ?)')
    stmt.run([key, value])
    stmt.free()
    
    // Save to file
    const dbPath = getStatsDbPath()
    const data = statsDb.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(dbPath, buffer)
  } catch (err) {
    console.error(`Error setting stat ${key}:`, err)
  }
}

// Increment map parse count
export function incrementMapParseCount(mapName: string): void {
  if (!mapName) return
  const key = `map_parsed_${mapName.toLowerCase()}`
  incrementStat(key)
}

// Track demo parsing stats (size and time)
export function trackDemoParsed(demoSizeBytes: number, parsingTimeMs: number): void {
  try {
    // Increment total parsed count
    incrementStat('total_demos_parsed')
    
    // Update largest demo
    const largestCurrent = parseInt(getStat('largest_demo_parsed', '0'), 10)
    if (demoSizeBytes > largestCurrent) {
      setStat('largest_demo_parsed', demoSizeBytes.toString())
    }
    
    // Update smallest demo (if first time or smaller than current)
    const smallestCurrent = parseInt(getStat('smallest_demo_parsed', '0'), 10)
    if (smallestCurrent === 0 || demoSizeBytes < smallestCurrent) {
      setStat('smallest_demo_parsed', demoSizeBytes.toString())
    }
    
    // Add to total demo size
    incrementStat('total_demo_size', demoSizeBytes)
    
    // Add to total parsing time
    incrementStat('total_parsing_time_ms', parsingTimeMs)
    
    // Update fastest parsing time (if first time or faster than current)
    const fastestCurrent = parseInt(getStat('fastest_parsing_time_ms', '0'), 10)
    if (fastestCurrent === 0 || parsingTimeMs < fastestCurrent) {
      setStat('fastest_parsing_time_ms', parsingTimeMs.toString())
    }
    
    // Update slowest parsing time
    const slowestCurrent = parseInt(getStat('slowest_parsing_time_ms', '0'), 10)
    if (parsingTimeMs > slowestCurrent) {
      setStat('slowest_parsing_time_ms', parsingTimeMs.toString())
    }
  } catch (err) {
    console.error('Error tracking demo parsed:', err)
  }
}

// Track voice extraction stats
export function trackVoiceExtracted(durationMs: number, fileCount: number = 1): void {
  try {
    // Increment total voice files generated
    incrementStat('voice_files_generated', fileCount)
    
    // Add to total extraction time
    incrementStat('total_voice_extraction_ms', durationMs)
    
    // Increment total voices extracted (legacy counter)
    incrementStat('total_voices_extracted', fileCount)
    
    // Update shortest voice extraction time (if first time or shorter than current)
    const shortestCurrent = parseInt(getStat('shortest_voice_extraction_ms', '0'), 10)
    if (shortestCurrent === 0 || durationMs < shortestCurrent) {
      setStat('shortest_voice_extraction_ms', durationMs.toString())
    }
    
    // Update longest voice extraction time
    const longestCurrent = parseInt(getStat('longest_voice_extraction_ms', '0'), 10)
    if (durationMs > longestCurrent) {
      setStat('longest_voice_extraction_ms', durationMs.toString())
    }
  } catch (err) {
    console.error('Error tracking voice extracted:', err)
  }
}

// Get all stats
export function getAllStats(): Record<string, number> {
  if (!statsDb) {
    return {}
  }
  
  try {
    const stmt = statsDb.prepare('SELECT key, value FROM stats')
    const stats: Record<string, number> = {}
    
    while (stmt.step()) {
      const row = stmt.getAsObject()
      const value = parseInt(row.value, 10)
      stats[row.key] = isNaN(value) ? 0 : value
    }
    stmt.free()
    
    return stats
  } catch (err) {
    console.error('Error getting all stats:', err)
    return {}
  }
}

// Reset all stats
export function resetStats(): void {
  if (!statsDb) {
    console.error('Stats database not initialized')
    return
  }
  
  try {
    statsDb.run('DELETE FROM stats')
    
    // Reinitialize default stats
    statsDb.run(`INSERT INTO stats (key, value) VALUES ('total_demos_parsed', '0')`)
    statsDb.run(`INSERT INTO stats (key, value) VALUES ('total_voices_extracted', '0')`)
    statsDb.run(`INSERT INTO stats (key, value) VALUES ('largest_demo_parsed', '0')`)
    statsDb.run(`INSERT INTO stats (key, value) VALUES ('smallest_demo_parsed', '0')`)
    statsDb.run(`INSERT INTO stats (key, value) VALUES ('total_demo_size', '0')`)
    statsDb.run(`INSERT INTO stats (key, value) VALUES ('total_parsing_time_ms', '0')`)
    statsDb.run(`INSERT INTO stats (key, value) VALUES ('fastest_parsing_time_ms', '0')`)
    statsDb.run(`INSERT INTO stats (key, value) VALUES ('slowest_parsing_time_ms', '0')`)
    statsDb.run(`INSERT INTO stats (key, value) VALUES ('total_voice_extraction_ms', '0')`)
    statsDb.run(`INSERT INTO stats (key, value) VALUES ('shortest_voice_extraction_ms', '0')`)
    statsDb.run(`INSERT INTO stats (key, value) VALUES ('longest_voice_extraction_ms', '0')`)
    statsDb.run(`INSERT INTO stats (key, value) VALUES ('voice_files_generated', '0')`)
    
    // Save to file
    const dbPath = getStatsDbPath()
    const data = statsDb.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(dbPath, buffer)
  } catch (err) {
    console.error('Error resetting stats:', err)
  }
}
