import { app, BrowserWindow, dialog, ipcMain, shell, clipboard, protocol } from 'electron'
import { spawn, ChildProcess, exec } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { initSettingsDb, getSetting, setSetting, getAllSettings } from './settings'
import * as matchesService from './matchesService'
import { isCS2PluginInstalled, getPluginInstallPath, isGameInfoModified } from './cs2-plugin'

let mainWindow: BrowserWindow | null = null
let parserProcess: ChildProcess | null = null

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

function createWindow() {
  // Get icon path - use logo.png from resources
  const iconPath = path.join(__dirname, '../resources/logo.png')
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#1e2124',
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  // Register protocol to serve map images (thumbnails for cards)
  protocol.registerFileProtocol('map', (request, callback) => {
    const url = request.url.replace('map://', '')
    const mapPath = path.join(__dirname, '../resources/maps', url)
    callback({ path: mapPath })
  })
  
  // Register protocol to serve radar images (for 2D viewer)
  protocol.registerFileProtocol('radar', (request, callback) => {
    const url = request.url.replace('radar://', '')
    const radarPath = path.join(__dirname, '../resources/radars', url)
    callback({ path: radarPath })
  })
  
  // IPC handler to get radar image as base64 (to avoid CORS issues)
  ipcMain.handle('radar:getImage', async (_, mapName: string) => {
    try {
      const normalizedMapName = mapName.toLowerCase()
      const mapFileName = normalizedMapName.endsWith('.png') ? normalizedMapName : `${normalizedMapName}.png`
      const radarPath = path.join(__dirname, '../resources/radars', mapFileName)
      
      if (fs.existsSync(radarPath)) {
        const imageBuffer = fs.readFileSync(radarPath)
        const base64 = imageBuffer.toString('base64')
        return { success: true, data: `data:image/png;base64,${base64}` }
      } else {
        // Try without de_ prefix
        const withoutPrefix = normalizedMapName.replace(/^de_/, '')
        const altFileName = `${withoutPrefix}.png`
        const altRadarPath = path.join(__dirname, '../resources/radars', altFileName)
        if (fs.existsSync(altRadarPath)) {
          const imageBuffer = fs.readFileSync(altRadarPath)
          const base64 = imageBuffer.toString('base64')
          return { success: true, data: `data:image/png;base64,${base64}` }
        }
        return { success: false, error: 'Radar image not found' }
      }
    } catch (error) {
      console.error('Error loading radar image:', error)
      return { success: false, error: String(error) }
    }
  })

  // Initialize settings database
  await initSettingsDb()
  
  // Ensure matches directory exists
  matchesService.ensureMatchesDir()
  
  // Perform startup integrity check
  const deleted = await matchesService.performStartupIntegrityCheck()
  if (deleted.length > 0) {
    console.log(`[Startup] Cleaned up ${deleted.length} orphan/corrupt databases`)
    // Notify renderer if window is ready
    if (mainWindow) {
      mainWindow.webContents.send('matches:cleanup', {
        deleted: deleted.length,
        details: deleted,
      })
    }
  }
  
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // Kill parser process if running
  if (parserProcess) {
    parserProcess.kill()
    parserProcess = null
  }
})

// Helper to get parser executable path
function getParserPath(): string {
  if (isDev) {
    // Dev: use configurable path or default to bin/parser
    // __dirname in dev is dist-electron, so go up one level to project root
    const projectRoot = path.resolve(__dirname, '..')
    const defaultPath = path.join(projectRoot, 'bin', 'parser')
    const devPath = process.env.PARSER_PATH || defaultPath
    // Add .exe on Windows
    if (process.platform === 'win32') {
      return devPath + '.exe'
    }
    return devPath
  } else {
    // Prod: use resources path
    const resourcesPath = process.resourcesPath || app.getAppPath()
    const platform = process.platform
    let binaryName = 'parser'
    
    if (platform === 'win32') {
      binaryName = 'parser.exe'
    } else if (platform === 'darwin') {
      binaryName = 'parser-mac'
    } else if (platform === 'linux') {
      binaryName = 'parser-linux'
    }
    
    return path.join(resourcesPath, 'resources', binaryName)
  }
}

// IPC Handlers

ipcMain.handle('dialog:openFile', async (_, allowMultiple: boolean = false) => {
  if (!mainWindow) return null

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: allowMultiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [
      { name: 'CS2 Demo Files', extensions: ['dem'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return allowMultiple ? result.filePaths : result.filePaths[0]
})

ipcMain.handle('parser:parse', async (_, { demoPath }: { demoPath: string }) => {
  // Force stop any existing parser process before starting a new one
  if (parserProcess) {
    console.log('[Parser] Stopping existing parser process before starting new one')
    const process = parserProcess
    parserProcess = null
    
    // Remove all event listeners to prevent exit/error events from being sent
    // This prevents the UI from showing errors for intentionally killed processes
    process.removeAllListeners('exit')
    process.removeAllListeners('error')
    process.stdout?.removeAllListeners('data')
    process.stderr?.removeAllListeners('data')
    
    // Force kill the existing process
    try {
      process.kill('SIGKILL')
    } catch (err) {
      console.error('[Parser] Error killing existing process:', err)
    }
    
    // Don't wait - the process is killed immediately and will be cleaned up by the OS
  }

  if (!mainWindow) {
    throw new Error('Main window not available')
  }

  // Generate match ID from filename
  const matchId = path.basename(demoPath, path.extname(demoPath))
  
  // Get app data directory
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  
  // Ensure matches directory exists
  if (!fs.existsSync(matchesDir)) {
    fs.mkdirSync(matchesDir, { recursive: true })
  }

  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)
  const parserPath = getParserPath()
  
  // Note: demo_path and created_at_iso will be stored in meta table by the Go parser
  
  // Debug: log the path being used (only in dev)
  if (isDev) {
    console.log(`[Parser] Looking for parser at: ${parserPath}`)
    console.log(`[Parser] __dirname: ${__dirname}`)
    console.log(`[Parser] Project root: ${path.resolve(__dirname, '..')}`)
  }

  // Check if parser exists
  if (!fs.existsSync(parserPath)) {
    throw new Error(`Parser not found at: ${parserPath}`)
  }

  // Spawn parser process
  parserProcess = spawn(parserPath, [
    '--demo', demoPath,
    '--out', dbPath,
    '--match-id', matchId,
  ])

  // Handle stdout (NDJSON)
  parserProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(line => line.trim())
    for (const line of lines) {
      mainWindow?.webContents.send('parser:message', line)
    }
  })

  // Handle stderr (log lines)
  parserProcess.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(line => line.trim())
    for (const line of lines) {
      mainWindow?.webContents.send('parser:log', line)
    }
  })

  // Handle process exit
  parserProcess.on('exit', async (code, signal) => {
    parserProcess = null
    mainWindow?.webContents.send('parser:exit', { code, signal })
    
    // If parsing succeeded, apply match cap if enabled
    if (code === 0) {
      const capEnabled = getSetting('match_cap_enabled', 'false') === 'true'
      if (capEnabled) {
        const capValue = parseInt(getSetting('match_cap_value', '10'), 10)
        if (!isNaN(capValue) && capValue > 0) {
          const deleted = await matchesService.trimMatchesToCap(capValue)
          if (deleted.length > 0) {
            console.log(`[Cap] Trimmed ${deleted.length} matches to cap of ${capValue}`)
            if (mainWindow) {
              mainWindow.webContents.send('matches:trimmed', {
                deleted: deleted.length,
                details: deleted,
              })
            }
          }
        }
      }
    }
  })

  // Handle errors
  parserProcess.on('error', (error) => {
    parserProcess = null
    mainWindow?.webContents.send('parser:error', error.message)
  })

  return { matchId, dbPath }
})

ipcMain.handle('parser:stop', async () => {
  if (parserProcess) {
    return new Promise<void>((resolve) => {
      const process = parserProcess
      if (!process) {
        resolve()
        return
      }

      // Set parserProcess to null immediately to prevent new parses
      parserProcess = null

      // Try graceful shutdown first
      process.kill('SIGTERM')

      // Wait for process to exit, with timeout
      const timeout = setTimeout(() => {
        // Force kill if still running after 2 seconds
        if (process && !process.killed) {
          try {
            process.kill('SIGKILL')
          } catch (err) {
            console.error('Error force killing parser:', err)
          }
        }
        resolve()
      }, 2000)

      // Resolve when process exits
      process.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })

      // Also handle error case
      process.once('error', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
})

// Matches IPC handlers
ipcMain.handle('matches:list', async () => {
  return await matchesService.listMatches()
})

ipcMain.handle('matches:summary', async (_, matchId: string) => {
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)
  
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }

  try {
    const initSqlJs = require('sql.js')
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)
    
    // Get player scores
    const stmt = db.prepare(`
      SELECT ps.match_id, ps.steamid, p.name, ps.team_kills, ps.team_damage, 
             ps.team_flash_seconds, ps.afk_seconds, ps.body_block_seconds, ps.grief_score
      FROM player_scores ps
      JOIN players p ON ps.match_id = p.match_id AND ps.steamid = p.steamid
      WHERE ps.match_id = ?
      ORDER BY ps.grief_score DESC
    `)
    stmt.bind([matchId])
    
    const players = []
    while (stmt.step()) {
      const row = stmt.getAsObject()
      players.push({
        matchId: row.match_id,
        steamId: row.steamid,
        name: row.name || row.steamid,
        teamKills: row.team_kills,
        teamDamage: row.team_damage,
        teamFlashSeconds: row.team_flash_seconds,
        afkSeconds: row.afk_seconds,
        bodyBlockSeconds: row.body_block_seconds,
        griefScore: row.grief_score,
      })
    }
    stmt.free()
    db.close()

    return {
      matchId,
      players,
    }
  } catch (err) {
    throw new Error(`Failed to get match summary: ${err}`)
  }
})

ipcMain.handle('matches:events', async (_, matchId: string, filters?: { type?: string; steamid?: string; round?: number }) => {
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)
  
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }

  try {
    const initSqlJs = require('sql.js')
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)
    
    let query = 'SELECT match_id, round_index, type, start_tick, end_tick, actor_steamid, victim_steamid, severity, confidence, meta_json FROM events WHERE match_id = ?'
    const params: any[] = [matchId]
    
    if (filters?.type) {
      query += ' AND type = ?'
      params.push(filters.type)
    }
    if (filters?.steamid) {
      query += ' AND actor_steamid = ?'
      params.push(filters.steamid)
    }
    if (filters?.round !== undefined) {
      query += ' AND round_index = ?'
      params.push(filters.round)
    }
    
    query += ' ORDER BY round_index, start_tick'
    
    const stmt = db.prepare(query)
    stmt.bind(params)
    
    const events = []
    while (stmt.step()) {
      const row = stmt.getAsObject()
      events.push({
        matchId: row.match_id,
        roundIndex: row.round_index,
        type: row.type,
        startTick: row.start_tick,
        endTick: row.end_tick,
        actorSteamId: row.actor_steamid,
        victimSteamId: row.victim_steamid,
        severity: row.severity,
        confidence: row.confidence,
        meta: row.meta_json ? JSON.parse(row.meta_json) : null,
      })
    }
    stmt.free()
    db.close()

    return {
      matchId,
      events,
    }
  } catch (err) {
    throw new Error(`Failed to get match events: ${err}`)
  }
})

ipcMain.handle('matches:players', async (_, matchId: string) => {
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)
  
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }

  try {
    const initSqlJs = require('sql.js')
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)
    
    // Get all players (not just those with scores)
    const stmt = db.prepare(`
      SELECT steamid, name
      FROM players
      WHERE match_id = ?
      ORDER BY name
    `)
    stmt.bind([matchId])
    
    const players: Array<{ steamId: string; name: string }> = []
    while (stmt.step()) {
      const row = stmt.getAsObject()
      players.push({
        steamId: row.steamid as string,
        name: (row.name as string) || (row.steamid as string),
      })
    }
    stmt.free()
    db.close()

    return {
      matchId,
      players,
    }
  } catch (err) {
    throw new Error(`Failed to get match players: ${err}`)
  }
})

ipcMain.handle('matches:rounds', async (_, matchId: string) => {
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)
  
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }

  try {
    const initSqlJs = require('sql.js')
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)
    
    // Get tick rate from matches table
    const tickRateStmt = db.prepare('SELECT tick_rate FROM matches WHERE id = ?')
    tickRateStmt.bind([matchId])
    let tickRate = 64 // Default
    if (tickRateStmt.step()) {
      const row = tickRateStmt.getAsObject()
      tickRate = (row.tick_rate as number) || 64
    }
    tickRateStmt.free()
    
    const stmt = db.prepare('SELECT match_id, round_index, start_tick, end_tick, freeze_end_tick, t_wins, ct_wins, winner FROM rounds WHERE match_id = ? ORDER BY round_index')
    stmt.bind([matchId])
    
    const rounds = []
    while (stmt.step()) {
      const row = stmt.getAsObject()
      rounds.push({
        matchId: row.match_id,
        roundIndex: row.round_index,
        startTick: row.start_tick,
        endTick: row.end_tick,
        freezeEndTick: row.freeze_end_tick,
        tWins: row.t_wins,
        ctWins: row.ct_wins,
        winner: row.winner,
      })
    }
    stmt.free()
    db.close()

    return {
      matchId,
      rounds,
      tickRate,
    }
  } catch (err) {
    throw new Error(`Failed to get match rounds: ${err}`)
  }
})

ipcMain.handle('matches:positionsForRound', async (_, matchId: string, roundIndex: number) => {
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }

  try {
    const initSqlJs = require('sql.js')
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)

    // Ensure player_positions table exists
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS player_positions (
          match_id TEXT NOT NULL,
          round_index INTEGER NOT NULL,
          tick INTEGER NOT NULL,
          steamid TEXT NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          z REAL NOT NULL,
          yaw REAL,
          team TEXT,
          health INTEGER,
          armor INTEGER,
          weapon TEXT,
          PRIMARY KEY(match_id, round_index, tick, steamid),
          FOREIGN KEY(match_id) REFERENCES matches(id),
          FOREIGN KEY(match_id, steamid) REFERENCES players(match_id, steamid)
        )
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_player_positions_match_round ON player_positions(match_id, round_index)
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_player_positions_tick ON player_positions(match_id, round_index, tick)
      `)
    } catch (schemaErr) {
      console.warn('Failed to ensure player_positions table exists:', schemaErr)
    }

    // Get all positions for the round
    const query = `
      SELECT pp.tick, pp.steamid, pp.x, pp.y, pp.z, pp.yaw, pp.team, pp.health, pp.armor, pp.weapon, p.name
      FROM player_positions pp
      LEFT JOIN players p ON pp.match_id = p.match_id AND pp.steamid = p.steamid
      WHERE pp.match_id = ? AND pp.round_index = ?
      ORDER BY pp.tick ASC, pp.steamid ASC
    `

    const stmt = db.prepare(query)
    stmt.bind([matchId, roundIndex])

    const positions: Array<{
      tick: number
      steamid: string
      x: number
      y: number
      z: number
      yaw: number | null
      team: string | null
      name: string | null
      health: number | null
      armor: number | null
      weapon: string | null
    }> = []

    while (stmt.step()) {
      const row = stmt.getAsObject()
      positions.push({
        tick: row.tick as number,
        steamid: row.steamid as string,
        x: row.x as number,
        y: row.y as number,
        z: row.z as number,
        yaw: row.yaw as number | null,
        team: row.team as string | null,
        name: (row.name as string) || row.steamid,
        health: row.health as number | null,
        armor: row.armor as number | null,
        weapon: row.weapon as string | null,
      })
    }
    stmt.free()
    db.close()

    return {
      matchId,
      roundIndex,
      positions,
    }
  } catch (err) {
    throw new Error(`Failed to get player positions: ${err}`)
  }
})

ipcMain.handle('matches:grenadePositionsForRound', async (_, matchId: string, roundIndex: number) => {
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }

  try {
    const initSqlJs = require('sql.js')
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)

    // Ensure grenade_positions table exists
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS grenade_positions (
          match_id TEXT NOT NULL,
          round_index INTEGER NOT NULL,
          tick INTEGER NOT NULL,
          projectile_id INTEGER NOT NULL,
          grenade_name TEXT NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          z REAL NOT NULL,
          thrower_steamid TEXT,
          thrower_name TEXT,
          thrower_team TEXT,
          PRIMARY KEY(match_id, round_index, tick, projectile_id),
          FOREIGN KEY(match_id) REFERENCES matches(id)
        )
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_grenade_positions_match_round ON grenade_positions(match_id, round_index)
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_grenade_positions_tick ON grenade_positions(match_id, round_index, tick)
      `)
    } catch (schemaErr) {
      console.warn('Failed to ensure grenade_positions table exists:', schemaErr)
    }

    // Get all grenade positions for the round
    const query = `
      SELECT tick, projectile_id, grenade_name, x, y, z, thrower_steamid, thrower_name, thrower_team
      FROM grenade_positions
      WHERE match_id = ? AND round_index = ?
      ORDER BY tick ASC, projectile_id ASC
    `

    const stmt = db.prepare(query)
    stmt.bind([matchId, roundIndex])

    const positions: Array<{
      tick: number
      projectileId: number
      grenadeName: string
      x: number
      y: number
      z: number
      throwerSteamId: string | null
      throwerName: string | null
      throwerTeam: string | null
    }> = []

    while (stmt.step()) {
      const row = stmt.getAsObject()
      positions.push({
        tick: row.tick as number,
        projectileId: row.projectile_id as number,
        grenadeName: row.grenade_name as string,
        x: row.x as number,
        y: row.y as number,
        z: row.z as number,
        throwerSteamId: (row.thrower_steamid as string) || null,
        throwerName: (row.thrower_name as string) || null,
        throwerTeam: (row.thrower_team as string) || null,
      })
    }
    stmt.free()
    db.close()

    return {
      matchId,
      roundIndex,
      positions,
    }
  } catch (err) {
    throw new Error(`Failed to get grenade positions: ${err}`)
  }
})

ipcMain.handle('matches:grenadeEventsForRound', async (_, matchId: string, roundIndex: number) => {
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }

  try {
    const initSqlJs = require('sql.js')
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)

    // Ensure grenade_events table exists
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS grenade_events (
          match_id TEXT NOT NULL,
          round_index INTEGER NOT NULL,
          tick INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          projectile_id INTEGER NOT NULL,
          grenade_name TEXT NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          z REAL NOT NULL,
          thrower_steamid TEXT,
          thrower_name TEXT,
          thrower_team TEXT,
          FOREIGN KEY(match_id) REFERENCES matches(id)
        )
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_grenade_events_match_round ON grenade_events(match_id, round_index)
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_grenade_events_tick ON grenade_events(match_id, round_index, tick)
      `)
    } catch (schemaErr) {
      console.warn('Failed to ensure grenade_events table exists:', schemaErr)
    }

    // Get all grenade events for the round
    const query = `
      SELECT tick, event_type, projectile_id, grenade_name, x, y, z, thrower_steamid, thrower_name, thrower_team
      FROM grenade_events
      WHERE match_id = ? AND round_index = ?
      ORDER BY tick ASC
    `

    const stmt = db.prepare(query)
    stmt.bind([matchId, roundIndex])

    const events: Array<{
      tick: number
      eventType: string
      projectileId: number
      grenadeName: string
      x: number
      y: number
      z: number
      throwerSteamId: string | null
      throwerName: string | null
      throwerTeam: string | null
    }> = []

    while (stmt.step()) {
      const row = stmt.getAsObject()
      events.push({
        tick: row.tick as number,
        eventType: row.event_type as string,
        projectileId: row.projectile_id as number,
        grenadeName: row.grenade_name as string,
        x: row.x as number,
        y: row.y as number,
        z: row.z as number,
        throwerSteamId: (row.thrower_steamid as string) || null,
        throwerName: (row.thrower_name as string) || null,
        throwerTeam: (row.thrower_team as string) || null,
      })
    }
    stmt.free()
    db.close()

    return {
      matchId,
      roundIndex,
      events,
    }
  } catch (err) {
    throw new Error(`Failed to get grenade events: ${err}`)
  }
})

ipcMain.handle('matches:shotsForRound', async (_, matchId: string, roundIndex: number) => {
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }

  try {
    const initSqlJs = require('sql.js')
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)

    // Ensure shots table exists
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS shots (
          match_id TEXT NOT NULL,
          round_index INTEGER NOT NULL,
          tick INTEGER NOT NULL,
          steamid TEXT NOT NULL,
          weapon_name TEXT NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          z REAL NOT NULL,
          yaw REAL NOT NULL,
          pitch REAL,
          team TEXT,
          FOREIGN KEY(match_id) REFERENCES matches(id),
          FOREIGN KEY(match_id, steamid) REFERENCES players(match_id, steamid)
        )
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_shots_match_round ON shots(match_id, round_index)
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_shots_tick ON shots(match_id, round_index, tick)
      `)
    } catch (schemaErr) {
      console.warn('Failed to ensure shots table exists:', schemaErr)
    }

    // Get all shots for the round
    const query = `
      SELECT tick, steamid, weapon_name, x, y, z, yaw, pitch, team
      FROM shots
      WHERE match_id = ? AND round_index = ?
      ORDER BY tick ASC
    `

    const stmt = db.prepare(query)
    stmt.bind([matchId, roundIndex])

    const shots: Array<{
      tick: number
      steamId: string
      weaponName: string
      x: number
      y: number
      z: number
      yaw: number
      pitch: number | null
      team: string | null
    }> = []

    while (stmt.step()) {
      const row = stmt.getAsObject()
      shots.push({
        tick: row.tick as number,
        steamId: row.steamid as string,
        weaponName: row.weapon_name as string,
        x: row.x as number,
        y: row.y as number,
        z: row.z as number,
        yaw: row.yaw as number,
        pitch: (row.pitch as number) || null,
        team: (row.team as string) || null,
      })
    }
    stmt.free()
    db.close()

    return {
      matchId,
      roundIndex,
      shots,
    }
  } catch (err) {
    throw new Error(`Failed to get shots: ${err}`)
  }
})

ipcMain.handle('matches:positions', async (_, matchId: string, roundIndex: number, tick: number) => {
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }

  try {
    const initSqlJs = require('sql.js')
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)

    // Ensure player_positions table exists (for databases created before this feature)
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS player_positions (
          match_id TEXT NOT NULL,
          round_index INTEGER NOT NULL,
          tick INTEGER NOT NULL,
          steamid TEXT NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          z REAL NOT NULL,
          team TEXT,
          PRIMARY KEY(match_id, round_index, tick, steamid),
          FOREIGN KEY(match_id) REFERENCES matches(id),
          FOREIGN KEY(match_id, steamid) REFERENCES players(match_id, steamid)
        )
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_player_positions_match_round ON player_positions(match_id, round_index)
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_player_positions_tick ON player_positions(match_id, round_index, tick)
      `)
    } catch (schemaErr) {
      console.warn('Failed to ensure player_positions table exists:', schemaErr)
      // Continue anyway, might fail if table already exists with different schema
    }

    // Get positions at the specified tick (or closest tick)
    // We'll get positions within a small range around the target tick
    const tickRange = 32 // ±32 ticks (~0.5 seconds)
    const minTick = Math.max(0, tick - tickRange)
    const maxTick = tick + tickRange

    const query = `
      SELECT pp.tick, pp.steamid, pp.x, pp.y, pp.z, pp.team, p.name
      FROM player_positions pp
      LEFT JOIN players p ON pp.match_id = p.match_id AND pp.steamid = p.steamid
      WHERE pp.match_id = ? AND pp.round_index = ? AND pp.tick >= ? AND pp.tick <= ?
      ORDER BY ABS(pp.tick - ?), pp.tick
    `

    const stmt = db.prepare(query)
    stmt.bind([matchId, roundIndex, minTick, maxTick, tick])

    const positions: Array<{
      tick: number
      steamid: string
      x: number
      y: number
      z: number
      team: string | null
      name: string | null
    }> = []

    // Group by steamid to get closest tick for each player
    const playerMap = new Map<string, any>()
    while (stmt.step()) {
      const row = stmt.getAsObject()
      const steamid = row.steamid as string
      const rowTick = row.tick as number
      
      if (!playerMap.has(steamid) || Math.abs(rowTick - tick) < Math.abs((playerMap.get(steamid).tick as number) - tick)) {
        playerMap.set(steamid, {
          tick: rowTick,
          steamid: steamid,
          x: row.x as number,
          y: row.y as number,
          z: row.z as number,
          team: row.team as string | null,
          name: (row.name as string) || steamid,
        })
      }
    }
    stmt.free()

    // Convert map to array
    positions.push(...Array.from(playerMap.values()))

    db.close()

    return {
      matchId,
      roundIndex,
      tick,
      positions,
    }
  } catch (err) {
    throw new Error(`Failed to get player positions: ${err}`)
  }
})

ipcMain.handle('matches:chat', async (_, matchId: string, steamid?: string) => {
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  const dbPath = path.join(matchesDir, `${matchId}.sqlite`)
  
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Match ${matchId} not found`)
  }

  try {
    const initSqlJs = require('sql.js')
    const SQL = await initSqlJs()
    const buffer = fs.readFileSync(dbPath)
    const db = new SQL.Database(buffer)
    
    // Check if name and team columns exist in chat_messages table
    let hasNameColumn = false
    let hasTeamColumn = false
    try {
      const pragmaStmt = db.prepare("PRAGMA table_info(chat_messages)")
      while (pragmaStmt.step()) {
        const col = pragmaStmt.getAsObject()
        if (col.name === 'name') hasNameColumn = true
        if (col.name === 'team') hasTeamColumn = true
      }
      pragmaStmt.free()
    } catch {
      // If pragma fails, assume columns don't exist
    }
    
    // Build query based on available columns
    let query = 'SELECT cm.match_id, cm.round_index, cm.tick, cm.steamid, cm.message, cm.is_team_chat'
    if (hasNameColumn) {
      query += ', cm.name'
    } else {
      query += ', p.name'
    }
    if (hasTeamColumn) {
      query += ', cm.team'
    }
    
    query += ' FROM chat_messages cm'
    if (!hasNameColumn) {
      query += ' LEFT JOIN players p ON cm.match_id = p.match_id AND cm.steamid = p.steamid'
    }
    query += ' WHERE cm.match_id = ? AND cm.is_team_chat = 0'
    
    const params: any[] = [matchId]
    
    if (steamid) {
      query += ' AND cm.steamid = ?'
      params.push(steamid)
    }
    
    query += ' ORDER BY cm.tick ASC'
    
    const stmt = db.prepare(query)
    stmt.bind(params)
    
    const messages = []
    while (stmt.step()) {
      const row = stmt.getAsObject()
      messages.push({
        matchId: row.match_id,
        roundIndex: row.round_index,
        tick: row.tick,
        steamid: row.steamid,
        name: row.name || row.steamid,
        team: hasTeamColumn ? (row.team || null) : null,
        message: row.message,
        isTeamChat: row.is_team_chat === 1,
      })
    }
    stmt.free()
    db.close()

    return {
      matchId,
      messages,
    }
  } catch (err) {
    throw new Error(`Failed to get chat messages: ${err}`)
  }
})

ipcMain.handle('matches:delete', async (_, matchIds: string[]) => {
  const deleted = await matchesService.deleteMatches(matchIds)
  return { deleted }
})

ipcMain.handle('matches:deleteAll', async () => {
  const deleted = await matchesService.deleteAllMatches()
  return { deleted }
})

ipcMain.handle('matches:trimToCap', async (_, cap: number) => {
  const deleted = await matchesService.trimMatchesToCap(cap)
  return { deleted }
})

// DB Viewer IPC handlers
ipcMain.handle('db:listTables', async (_, matchId: string) => {
  return await matchesService.listTables(matchId)
})

ipcMain.handle('db:getTableInfo', async (_, matchId: string, tableName: string) => {
  return await matchesService.getTableInfo(matchId, tableName)
})

ipcMain.handle('db:runQuery', async (_, matchId: string, sql: string) => {
  return await matchesService.runSelectQuery(matchId, sql)
})

// Settings handlers
ipcMain.handle('settings:get', async (_, key: string, defaultValue?: string) => {
  return getSetting(key, defaultValue || '')
})

ipcMain.handle('settings:set', async (_, key: string, value: string) => {
  setSetting(key, value)
  return { success: true }
})

ipcMain.handle('settings:getAll', async () => {
  return getAllSettings()
})

// App info handler
ipcMain.handle('app:getInfo', async () => {
  const packageJson = require('../package.json')
  
  // Get app version
  const version = app.getVersion() || packageJson.version || '1.0.0'
  
  // Get storage info
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  const settingsDbPath = path.join(appDataPath, 'settings.sqlite')
  
  let matchesStorageBytes = 0
  let settingsStorageBytes = 0
  let matchCount = 0
  
  // Calculate matches storage
  if (fs.existsSync(matchesDir)) {
    const files = fs.readdirSync(matchesDir)
    for (const file of files) {
      if (file.endsWith('.sqlite')) {
        const filePath = path.join(matchesDir, file)
        try {
          const stats = fs.statSync(filePath)
          matchesStorageBytes += stats.size
          matchCount++
        } catch (err) {
          console.error(`Error getting stats for ${filePath}:`, err)
        }
      }
    }
  }
  
  // Calculate settings storage
  if (fs.existsSync(settingsDbPath)) {
    try {
      const stats = fs.statSync(settingsDbPath)
      settingsStorageBytes = stats.size
    } catch (err) {
      console.error(`Error getting stats for settings DB:`, err)
    }
  }
  
  const totalStorageBytes = matchesStorageBytes + settingsStorageBytes
  
  // Format bytes to human readable
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
  }
  
  return {
    version,
    platform: process.platform,
    arch: process.arch,
    osVersion: os.release(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    storage: {
      matches: {
        bytes: matchesStorageBytes,
        formatted: formatBytes(matchesStorageBytes),
        count: matchCount,
      },
      settings: {
        bytes: settingsStorageBytes,
        formatted: formatBytes(settingsStorageBytes),
      },
      total: {
        bytes: totalStorageBytes,
        formatted: formatBytes(totalStorageBytes),
      },
    },
    // TODO: Add update check in the future
    updateAvailable: false,
    updateVersion: null,
  }
})

// Helper function to check if CS2 is running
function isCS2Running(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('tasklist /FI "IMAGENAME eq cs2.exe"', (error, stdout) => {
        if (error) {
          resolve(false)
          return
        }
        resolve(stdout.toLowerCase().includes('cs2.exe'))
      })
    } else {
      // For non-Windows, use ps command
      exec('ps aux | grep -i cs2 | grep -v grep', (error, stdout) => {
        resolve(!error && stdout.trim().length > 0)
      })
    }
  })
}

// CS2 Launch handler
ipcMain.handle('cs2:launch', async (_, demoPath: string, startTick?: number, playerName?: string) => {
  if (!fs.existsSync(demoPath)) {
    throw new Error(`Demo file not found: ${demoPath}`)
  }

  // Get CS2 path from settings, fallback to common paths
  let cs2Exe = getSetting('cs2_path', '')
  
  if (!cs2Exe || !fs.existsSync(cs2Exe)) {
    // Try common CS2 installation paths
    const cs2Paths = [
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
      'C:\\Program Files\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cs2.exe',
      'C:\\Program Files\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cs2.exe',
      process.env.CS2_PATH || '',
    ]

    for (const cs2Path of cs2Paths) {
      if (cs2Path && fs.existsSync(cs2Path)) {
        cs2Exe = cs2Path
        // Save to settings for next time
        setSetting('cs2_path', cs2Exe)
        break
      }
    }
  }

  if (!cs2Exe || !fs.existsSync(cs2Exe)) {
    throw new Error('CS2 executable not found. Please set the CS2 path in Settings.')
  }

  // Check if CS2 is already running
  const cs2Running = await isCS2Running()

  // Get window settings from settings
  const windowWidth = getSetting('cs2_window_width', '1920')
  const windowHeight = getSetting('cs2_window_height', '1080')
  const windowMode = getSetting('cs2_window_mode', 'windowed')

  // Calculate tick to start at (5 seconds before event, or at start if not specified)
  const tickRate = 64 // Default tick rate
  const previewSeconds = 5
  const previewTicks = previewSeconds * tickRate
  const targetTick = startTick ? Math.max(0, startTick - previewTicks) : 0

  // Build console commands to copy to clipboard
  // Format: demo_gototick <tick>; spec_player "playername"
  const consoleCommands: string[] = []
  
  if (targetTick > 0) {
    consoleCommands.push(`demo_gototick ${targetTick}`) // Jump to tick
  }
  
  // Add spectate player command if playerName is provided
  if (playerName) {
    // spec_player takes the player's name, wrap in quotes if it contains spaces
    const playerNameQuoted = playerName.includes(' ') ? `"${playerName}"` : playerName
    consoleCommands.push(`spec_player ${playerNameQuoted}`) // Spectate the player
  }

  const commandsToCopy = consoleCommands.join('; ')
  
  // Copy console commands to clipboard (always available as fallback)
  clipboard.writeText(commandsToCopy)

  // Check if CS Demo Analyzer plugin is installed
  const pluginInstalled = isCS2PluginInstalled(cs2Exe)
  const gameInfoModified = isGameInfoModified(cs2Exe)
  const pluginReady = pluginInstalled && gameInfoModified

  // Create JSON actions file next to demo (CS Demo Analyzer format)
  // This works automatically if CS Demo Analyzer's server plugin is installed
  let jsonActionsFilePath: string | null = null
  if (consoleCommands.length > 0) {
    try {
      // Create JSON file next to demo file (same name + .json extension)
      // Format: [{ "actions": [{ "tick": number, "cmd": string }] }]
      const demoDir = path.dirname(demoPath)
      const demoName = path.basename(demoPath, path.extname(demoPath))
      jsonActionsFilePath = path.join(demoDir, `${demoName}.json`)
      
      const actions: Array<{ tick: number; cmd: string }> = []
      
      // Add skip ahead command if we have a target tick
      if (targetTick > 0) {
        actions.push({
          tick: 0, // Execute at tick 0 (start of demo)
          cmd: `demo_gototick ${targetTick}`
        })
      }
      
      // Add spec_player command if we have a player name
      // Note: CS Demo Analyzer uses player slot numbers, but we'll use player name
      // The plugin should handle this, or user can paste from clipboard
      if (playerName) {
        const playerNameQuoted = playerName.includes(' ') ? `"${playerName}"` : playerName
        // Execute spec_player a few ticks after demo_gototick to ensure it works
        // CS Demo Analyzer adds a delay for this reason
        actions.push({
          tick: targetTick > 0 ? targetTick + 4 : 0,
          cmd: `spec_player ${playerNameQuoted}`
        })
      }
      
      if (actions.length > 0) {
        const jsonContent = JSON.stringify([{ actions }], null, 2)
        fs.writeFileSync(jsonActionsFilePath, jsonContent, 'utf8')
        console.log('Created JSON actions file (CS Demo Analyzer format):', jsonActionsFilePath)
        if (pluginReady) {
          console.log('✓ CS Demo Analyzer plugin detected - commands will execute automatically!')
        } else if (pluginInstalled && !gameInfoModified) {
          console.log('⚠ Plugin binary found but gameinfo.gi not modified - plugin may not load')
        } else {
          console.log('ℹ CS Demo Analyzer plugin not detected - install it for automatic command execution')
          console.log('  Plugin location:', getPluginInstallPath(cs2Exe)?.binaryPath || 'unknown')
        }
      }
    } catch (err) {
      console.warn('Failed to create JSON actions file:', err)
      // Continue without JSON file - other methods still work
    }
  }

  // Create a config file for automatic execution (if we have commands to run)
  let configFilePath: string | null = null
  if (consoleCommands.length > 0 && !cs2Running) {
    try {
      // Create config file in userData directory
      const appDataPath = app.getPath('userData')
      const configsDir = path.join(appDataPath, 'cs2_configs')
      if (!fs.existsSync(configsDir)) {
        fs.mkdirSync(configsDir, { recursive: true })
      }
      
      // Create a unique config file name
      const configFileName = `demo_commands_${Date.now()}.cfg`
      configFilePath = path.join(configsDir, configFileName)
      
      // Write commands to config file
      // Note: CS2 executes +exec configs when the game starts, which might be before demo loads
      // So we add a comment and the commands - if demo isn't loaded, commands will fail silently
      // The user can still paste from clipboard after demo loads
      const configContent = [
        '// Auto-generated CS2 demo commands',
        '// These commands will execute when CS2 starts',
        '// If the demo hasn\'t loaded yet, paste the commands from clipboard after demo loads',
        '',
        ...consoleCommands.map(cmd => cmd)
      ].join('\n')
      
      fs.writeFileSync(configFilePath, configContent, 'utf8')
      console.log('Created CS2 config file:', configFilePath)
    } catch (err) {
      console.warn('Failed to create CS2 config file:', err)
      // Continue without config file - clipboard is still available
    }
  }

  // If CS2 is already running, just copy commands and return
  if (cs2Running) {
    console.log('=== CS2 Already Running ===')
    console.log('Demo Path:', demoPath)
    console.log('Start Tick:', startTick)
    console.log('Target Tick:', targetTick)
    console.log('Player Name:', playerName)
    console.log('Console Commands (copied to clipboard):', commandsToCopy)
    if (jsonActionsFilePath) {
      console.log('JSON Actions File (CS Demo Analyzer format):', jsonActionsFilePath)
      if (pluginReady) {
        console.log('✓ Plugin ready - commands will execute automatically!')
      } else {
        console.log('ℹ Install CS Demo Analyzer plugin for automatic execution')
      }
    }
    console.log('Paste these commands into CS2 console (press ~)')
    console.log('========================')
    
    return { success: true, tick: targetTick, commands: commandsToCopy, alreadyRunning: true }
  }

  // Build command line arguments for launching CS2
  const args: string[] = []
  args.push(`-console`)
  args.push(`-novid`)
  args.push(`-insecure`)
  
  // Add window mode flag based on settings
  if (windowMode === 'fullscreen') {
    args.push(`-fullscreen`)
  } else if (windowMode === 'fullscreen_windowed') {
    args.push(`-fullscreen-windowed`)
  } else {
    // Default to windowed mode (has close/minimize buttons)
    // Use -window flag for proper windowed mode with controls
    args.push(`-window`)
  }
  
  args.push(`-w`, windowWidth)
  args.push(`-h`, windowHeight)
  args.push(`+playdemo`, demoPath) // Use original path, spawn handles quoting
  
  // Add +exec to automatically execute commands if config file was created
  // Note: This executes when CS2 starts, which might be before demo loads
  // If demo isn't loaded, commands will fail but user can paste from clipboard
  if (configFilePath) {
    // Use forward slashes for CS2 config paths (works on Windows too)
    const configPathForCS2 = configFilePath.replace(/\\/g, '/')
    args.push(`+exec`, configPathForCS2)
    console.log('Added +exec parameter:', configPathForCS2)
  }

  // Log the command for debugging
  const fullCommand = `"${cs2Exe}" ${args.map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ')}`
  console.log('=== CS2 Launch Command ===')
  console.log('CS2 Executable:', cs2Exe)
  console.log('Demo Path:', demoPath)
  console.log('Start Tick:', startTick)
  console.log('Target Tick:', targetTick)
  console.log('Player Name:', playerName)
    console.log('Window Size:', `${windowWidth}x${windowHeight}`)
    console.log('Console Commands (copied to clipboard):', commandsToCopy)
    if (jsonActionsFilePath) {
      console.log('JSON Actions File (CS Demo Analyzer format):', jsonActionsFilePath)
      if (pluginReady) {
        console.log('✓ Plugin ready - commands will execute automatically!')
      } else {
        console.log('ℹ Install CS Demo Analyzer plugin for automatic execution')
      }
    }
    if (configFilePath) {
      console.log('Config File (for +exec):', configFilePath)
    }
  console.log('Full Command (for spawn):', fullCommand)
  console.log('Arguments Array (for spawn):', JSON.stringify(args, null, 2))
  console.log('========================')

  try {
    // Use spawn to launch CS2 directly with arguments
    const cs2Process = spawn(cs2Exe, args, {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(cs2Exe), // Set working directory to CS2 directory
    })

    cs2Process.unref()
    
    return { success: true, tick: targetTick, commands: commandsToCopy, alreadyRunning: false }
  } catch (err) {
    throw new Error(`Failed to launch CS2: ${err instanceof Error ? err.message : String(err)}`)
  }
})

// CS2 Copy Commands handler (generates and copies commands without launching)
ipcMain.handle('cs2:copyCommands', async (_, demoPath: string, startTick?: number, playerName?: string) => {
  if (!fs.existsSync(demoPath)) {
    throw new Error(`Demo file not found: ${demoPath}`)
  }

  // Calculate tick to start at (5 seconds before event, or at start if not specified)
  const tickRate = 64 // Default tick rate
  const previewSeconds = 5
  const previewTicks = previewSeconds * tickRate
  const targetTick = startTick ? Math.max(0, startTick - previewTicks) : 0

  // Build console commands to copy to clipboard
  // Format: demo_gototick <tick>; spec_player "playername"
  const consoleCommands: string[] = []
  
  if (targetTick > 0) {
    consoleCommands.push(`demo_gototick ${targetTick}`) // Jump to tick
  }
  
  // Add spectate player command if playerName is provided
  if (playerName) {
    // spec_player takes the player's name, wrap in quotes if it contains spaces
    const playerNameQuoted = playerName.includes(' ') ? `"${playerName}"` : playerName
    consoleCommands.push(`spec_player ${playerNameQuoted}`) // Spectate the player
  }

  const commandsToCopy = consoleCommands.join('; ')
  
  // Copy console commands to clipboard
  clipboard.writeText(commandsToCopy)

  return { success: true, commands: commandsToCopy }
})

