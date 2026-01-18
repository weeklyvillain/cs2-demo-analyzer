import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
const initSqlJs = require('sql.js')

let settingsDb: any = null

// Get settings database path
function getSettingsDbPath(): string {
  const appDataPath = app.getPath('userData')
  return path.join(appDataPath, 'settings.sqlite')
}

// Initialize settings database
export async function initSettingsDb(): Promise<void> {
  const dbPath = getSettingsDbPath()
  const SQL = await initSqlJs()
  
  // Create database if it doesn't exist
  if (!fs.existsSync(dbPath)) {
    settingsDb = new SQL.Database()
    // Create settings table
    settingsDb.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
    
    // Save to file
    const data = settingsDb.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(dbPath, buffer)
  } else {
    // Load existing database
    const buffer = fs.readFileSync(dbPath)
    settingsDb = new SQL.Database(buffer)
  }
}

// Get a setting value
export function getSetting(key: string, defaultValue: string = ''): string {
  if (!settingsDb) {
    return defaultValue
  }
  
  try {
    const stmt = settingsDb.prepare('SELECT value FROM settings WHERE key = ?')
    stmt.bind([key])
    
    if (stmt.step()) {
      const result = stmt.getAsObject()
      stmt.free()
      return result.value || defaultValue
    }
    stmt.free()
    return defaultValue
  } catch (err) {
    console.error(`Error getting setting ${key}:`, err)
    return defaultValue
  }
}

// Set a setting value
export function setSetting(key: string, value: string): void {
  if (!settingsDb) {
    console.error('Settings database not initialized')
    return
  }
  
  try {
    const stmt = settingsDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    stmt.run([key, value])
    stmt.free()
    
    // Save to file
    const dbPath = getSettingsDbPath()
    const data = settingsDb.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(dbPath, buffer)
  } catch (err) {
    console.error(`Error setting ${key}:`, err)
  }
}

// Get all settings
export function getAllSettings(): Record<string, string> {
  if (!settingsDb) {
    return {}
  }
  
  try {
    const stmt = settingsDb.prepare('SELECT key, value FROM settings')
    const settings: Record<string, string> = {}
    
    while (stmt.step()) {
      const row = stmt.getAsObject()
      settings[row.key] = row.value
    }
    stmt.free()
    
    return settings
  } catch (err) {
    console.error('Error getting all settings:', err)
    return {}
  }
}

