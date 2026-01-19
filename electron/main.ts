import { app, BrowserWindow, dialog, ipcMain, shell, clipboard, protocol, Menu } from 'electron'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import { spawn, ChildProcess, exec } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as crypto from 'crypto'
import { initSettingsDb, getSetting, setSetting, getAllSettings } from './settings'
import * as matchesService from './matchesService'
import { isCS2PluginInstalled, getPluginInstallPath, isGameInfoModified } from './cs2-plugin'

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
let parserProcess: ChildProcess | null = null
let startupCleanupDeleted: Array<{ matchId: string; reason: string }> = []

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

function createSplashWindow() {
  const iconPath = path.join(__dirname, '../resources/logo.png')
  
  splashWindow = new BrowserWindow({
    width: 500,
    height: 400,
    icon: iconPath,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: false,
    show: false, // Don't show until ready
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // Allow loading local files
    },
    backgroundColor: '#1e2124',
  })
  
  // Show window when ready
  splashWindow.once('ready-to-show', () => {
    if (splashWindow) {
      splashWindow.show()
    }
  })

  // Load splash screen
  // In dev, __dirname is dist-electron, so go up two levels
  // In production, splash.html is in the app directory (not in app.asar)
  let splashPath: string
  if (isDev) {
    splashPath = path.join(__dirname, '../../splash.html')
  } else {
    // In production, files outside app.asar are in the app directory
    // Try multiple possible locations
    const appPath = app.getAppPath()
    const possiblePaths = [
      path.join(appPath, 'splash.html'), // If not in asar
      path.join(path.dirname(appPath), 'splash.html'), // Next to app.asar
      path.join(__dirname, '../splash.html'), // Relative to main.js
    ]
    
    splashPath = possiblePaths.find(p => fs.existsSync(p)) || possiblePaths[0]
    console.log('[Splash] Loading from:', splashPath)
    console.log('[Splash] App path:', appPath)
    console.log('[Splash] __dirname:', __dirname)
  }
  
  if (!fs.existsSync(splashPath)) {
    console.error('[Splash] File not found at:', splashPath)
    // Fallback: create a simple HTML content
    splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { 
              font-family: Arial, sans-serif; 
              background: #1e2124; 
              color: white; 
              display: flex; 
              align-items: center; 
              justify-content: center; 
              height: 100vh; 
              margin: 0;
            }
            .container { text-align: center; }
            h1 { margin: 20px 0; }
            .status { margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>CS2 Demo Analyzer</h1>
            <div class="status" id="status">Checking for updates...</div>
          </div>
          <script>
            const statusEl = document.getElementById('status');
            // Wait for electronAPI to be available
            function waitForElectronAPI(callback, maxAttempts = 50) {
              if (window.electronAPI) {
                callback();
              } else if (maxAttempts > 0) {
                setTimeout(() => waitForElectronAPI(callback, maxAttempts - 1), 100);
              }
            }
            waitForElectronAPI(() => {
              if (window.electronAPI?.onUpdateStatus) {
                window.electronAPI.onUpdateStatus((status, data) => {
                  if (status === 'checking') statusEl.textContent = 'Checking for updates...';
                  else if (status === 'available') statusEl.textContent = 'Update available: ' + (data?.version || '');
                  else if (status === 'not-available') statusEl.textContent = 'Starting application...';
                  else if (status === 'progress') statusEl.textContent = 'Downloading: ' + Math.round(data?.percent || 0) + '%';
                  else if (status === 'downloaded') statusEl.textContent = 'Update downloaded. Restarting...';
                  else if (status === 'error') statusEl.textContent = 'Error: ' + (data?.message || 'Unknown error');
                });
              }
            });
          </script>
        </body>
      </html>
    `)}`)
  } else {
    splashWindow.loadFile(splashPath)
  }

  splashWindow.on('closed', () => {
    splashWindow = null
  })
}

function createWindow() {
  // Get icon path - use logo.png from resources
  const iconPath = path.join(__dirname, '../resources/logo.png')
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: iconPath,
    autoHideMenuBar: !isDev, // Hide menu bar in production, show in dev
    show: false, // Don't show until ready
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#1e2124',
  })

  // Maximize the window
  mainWindow.maximize()

  // Remove menu bar completely in production builds
  if (!isDev) {
    Menu.setApplicationMenu(null)
  }

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show()
      // Close splash if it exists
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close()
        splashWindow = null
      }
      // Notify main window about cleanup if there were deleted databases
      if (startupCleanupDeleted.length > 0) {
        mainWindow.webContents.send('matches:cleanup', {
          deleted: startupCleanupDeleted.length,
          details: startupCleanupDeleted,
        })
      }
    }
  })

  // Enable DevTools in production with F12 or Ctrl+Shift+I
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!isDev) {
      // F12 to toggle DevTools
      if (input.key === 'F12') {
        if (mainWindow) {
          mainWindow.webContents.toggleDevTools()
        }
        event.preventDefault()
      }
      // Ctrl+Shift+I to toggle DevTools
      if (input.key === 'I' && input.control && input.shift) {
        if (mainWindow) {
          mainWindow.webContents.toggleDevTools()
        }
        event.preventDefault()
      }
    }
  })

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
  
  // IPC handler to get audio file as base64 (to avoid CORS/file protocol issues)
  ipcMain.handle('voice:getAudio', async (_, filePath: string) => {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Audio file not found' }
      }
      
      const audioBuffer = fs.readFileSync(filePath)
      const base64 = audioBuffer.toString('base64')
      // Determine MIME type from file extension
      const ext = path.extname(filePath).toLowerCase()
      const mimeType = ext === '.wav' ? 'audio/wav' : ext === '.mp3' ? 'audio/mpeg' : 'audio/wav'
      
      return { success: true, data: `data:${mimeType};base64,${base64}` }
    } catch (error) {
      console.error('Error loading audio file:', error)
      return { success: false, error: String(error) }
    }
  })

  // IPC handler to get logo image path
  ipcMain.handle('splash:getLogoPath', async () => {
    try {
      const logoPath = path.join(__dirname, '../resources/logo.png')
      if (fs.existsSync(logoPath)) {
        // Return file:// URL for splash window
        return `file://${logoPath.replace(/\\/g, '/')}`
      }
      return null
    } catch (error) {
      console.error('Error getting logo path:', error)
      return null
    }
  })

  // IPC handler to get logo image as base64 (for renderer process)
  ipcMain.handle('app:getLogoImage', async () => {
    try {
      const logoPath = path.join(__dirname, '../resources/logo.png')
      if (fs.existsSync(logoPath)) {
        const imageBuffer = fs.readFileSync(logoPath)
        const base64 = imageBuffer.toString('base64')
        return { success: true, data: `data:image/png;base64,${base64}` }
      }
      return { success: false, error: 'Logo image not found' }
    } catch (error) {
      console.error('Error loading logo image:', error)
      return { success: false, error: String(error) }
    }
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
  startupCleanupDeleted = await matchesService.performStartupIntegrityCheck()
  if (startupCleanupDeleted.length > 0) {
    console.log(`[Startup] Cleaned up ${startupCleanupDeleted.length} orphan/corrupt databases`)
  }
  
  // In production, show splash screen first and check for updates
  // In dev, just create the main window
  if (!isDev) {
    createSplashWindow()
    initializeAutoUpdater()
  } else {
    createWindow()
  }
  
  // Initialize auto-updater for production (runs before main window)
  function initializeAutoUpdater() {
    if (!splashWindow) return
    
    console.log('[AutoUpdater] Initializing auto-updater...')
    console.log('[AutoUpdater] App version:', app.getVersion())
    console.log('[AutoUpdater] Is packaged:', app.isPackaged)
    
    // Configure auto-updater BEFORE checking for updates
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false // We'll handle restart manually
    
    // Enable logging for electron-updater
    autoUpdater.logger = {
      info: (message: string) => console.log('[AutoUpdater]', message),
      warn: (message: string) => console.warn('[AutoUpdater]', message),
      error: (message: string) => console.error('[AutoUpdater]', message),
      debug: (message: string) => console.log('[AutoUpdater] DEBUG:', message),
    }
    
    // Store the update version for progress updates
    let updateVersion: string | null = null
    
    // Helper to send status to splash window
    const sendStatus = (status: string, data?: any) => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents.send('update:status', { status, ...data })
      }
    }
    
    // Listen for update events
    autoUpdater.on('checking-for-update', () => {
      console.log('[AutoUpdater] Checking for updates...')
      sendStatus('checking')
    })
    
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      console.log('[AutoUpdater] Update available:', info.version)
      console.log('[AutoUpdater] Downloading automatically...')
      updateVersion = info.version
      sendStatus('available', { version: info.version })
    })
    
    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      console.log('[AutoUpdater] Update not available. Current version is latest:', info.version)
      sendStatus('not-available')
      // Open main window after a brief delay
      setTimeout(() => {
        createWindow()
      }, 1000)
    })
    
    autoUpdater.on('download-progress', (progressObj) => {
      const percent = Math.round(progressObj.percent)
      console.log(`[AutoUpdater] Download progress: ${percent}%`)
      sendStatus('progress', { 
        percent: progressObj.percent,
        version: updateVersion || undefined
      })
    })
    
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      console.log('[AutoUpdater] Update downloaded:', info.version)
      sendStatus('downloaded', { version: info.version })
      // Will auto-restart via installUpdate handler
    })
    
    autoUpdater.on('error', (error: Error) => {
      console.error('[AutoUpdater] Error:', error)
      console.error('[AutoUpdater] Error message:', error.message)
      console.error('[AutoUpdater] Error stack:', error.stack)
      sendStatus('error', { message: error.message })
      // Open main window even on error
      setTimeout(() => {
        createWindow()
      }, 2000)
    })
    
    // Check for updates on startup (after a short delay to ensure splash is ready)
    setTimeout(() => {
      console.log('[AutoUpdater] Checking for updates on startup...')
      autoUpdater.checkForUpdatesAndNotify()
    }, 500)
  }

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
    // Prod: use resources/bin path (files are in resources/bin/)
    // process.resourcesPath already points to the resources directory in production
    // For example: C:\Users\Filip\AppData\Local\Programs\CS2 Demo Analyzer\resources
    const resourcesPath = process.resourcesPath || path.join(app.getAppPath(), '..', 'resources')
    const platform = process.platform
    let binaryName = 'parser'
    
    if (platform === 'win32') {
      binaryName = 'parser.exe'
    } else if (platform === 'darwin') {
      binaryName = 'parser-mac'
    } else if (platform === 'linux') {
      binaryName = 'parser-linux'
    }
    
    // Files are now in resources/bin/ directory
    return path.join(resourcesPath, 'bin', binaryName)
  }
}

// Helper to get audiowaveform executable path
function getAudiowaveformPath(): string {
  if (isDev) {
    // Dev: check for audiowaveform in bin
    const projectRoot = path.resolve(__dirname, '..')
    const defaultPath = path.join(projectRoot, 'bin', 'audiowaveform')
    const devPath = process.env.AUDIOWAVEFORM_PATH || defaultPath
    // Add .exe on Windows
    if (process.platform === 'win32') {
      return devPath + '.exe'
    }
    return devPath
  } else {
    // Prod: use resources/bin path (files are in resources/bin/)
    const resourcesPath = process.resourcesPath || path.join(app.getAppPath(), '..', 'resources')
    const platform = process.platform
    let binaryName = 'audiowaveform'
    
    if (platform === 'win32') {
      binaryName = 'audiowaveform.exe'
    } else if (platform === 'darwin') {
      binaryName = 'audiowaveform-mac'
    } else if (platform === 'linux') {
      binaryName = 'audiowaveform-linux'
    }
    
    return path.join(resourcesPath, 'bin', binaryName)
  }
}

// Helper to get voice extractor executable path
function getVoiceExtractorPath(): string {
  if (isDev) {
    // Dev: check for voice extractor in bin or resources
    const projectRoot = path.resolve(__dirname, '..')
    const defaultPath = path.join(projectRoot, 'bin', 'csgove')
    const devPath = process.env.VOICE_EXTRACTOR_PATH || defaultPath
    // Add .exe on Windows
    if (process.platform === 'win32') {
      return devPath + '.exe'
    }
    return devPath
  } else {
    // Prod: use resources/bin path (files are in resources/bin/)
    const resourcesPath = process.resourcesPath || path.join(app.getAppPath(), '..', 'resources')
    const platform = process.platform
    let binaryName = 'csgove'
    
    if (platform === 'win32') {
      binaryName = 'csgove.exe'
    }
    
    return path.join(resourcesPath, 'bin', binaryName)
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

  // Get position interval setting (default to 4 for 1/4th positions)
  const positionInterval = getSetting('position_extraction_interval', '4')
  
  // Spawn parser process
  parserProcess = spawn(parserPath, [
    '--demo', demoPath,
    '--out', dbPath,
    '--match-id', matchId,
    '--position-interval', positionInterval,
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

// Helper function to parse release notes from GitHub release body
function parseReleaseNotes(body: string): string[] {
  if (!body) return ['Bug fixes and improvements']
  
  // Split by common markdown list patterns
  const lines = body.split('\n')
  const items: string[] = []
  
  for (const line of lines) {
    // Match markdown list items: - item, * item, or numbered lists
    const match = line.match(/^[\s]*[-*]\s+(.+)$/) || line.match(/^[\s]*\d+\.\s+(.+)$/)
    if (match && match[1]) {
      const item = match[1].trim()
      // Skip empty items and headers
      if (item && !item.startsWith('#') && item.length > 0) {
        items.push(item)
      }
    }
  }
  
  // If no list items found, try to split by double newlines (paragraphs)
  if (items.length === 0) {
    const paragraphs = body.split(/\n\s*\n/).filter(p => p.trim().length > 0)
    if (paragraphs.length > 0) {
      return paragraphs.slice(0, 10) // Limit to 10 items
    }
  }
  
  return items.length > 0 ? items : ['Bug fixes and improvements']
}

// Helper function to get release notes for a specific version
async function getReleaseNotes(version: string): Promise<{ title: string; items: string[] } | null> {
  try {
    const repoOwner = 'weeklyvillain'
    const repoName = 'cs2-demo-analyzer'
    
    // Try to fetch the specific release by tag
    const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/tags/v${version}`
    
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CS2-Demo-Analyzer',
      },
    })
    
    if (!response.ok) {
      // If specific release not found, try latest
      const latestUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/latest`
      const latestResponse = await fetch(latestUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'CS2-Demo-Analyzer',
        },
      })
      
      if (!latestResponse.ok) {
        return null
      }
      
      const latestRelease = await latestResponse.json() as GitHubRelease
      const latestVersion = latestRelease.tag_name?.replace(/^v/, '') || ''
      
      // Only return if it matches the requested version
      if (latestVersion === version) {
        const items = parseReleaseNotes(latestRelease.body || '')
        return {
          title: latestRelease.name || `What's New in Version ${version}`,
          items,
        }
      }
      
      return null
    }
    
    const release = await response.json() as GitHubRelease
    const items = parseReleaseNotes(release.body || '')
    
    return {
      title: release.name || `What's New in Version ${version}`,
      items,
    }
  } catch (error) {
    console.error('[Release Notes] Error fetching release notes:', error)
    return null
  }
}

// What's New / Version tracking
ipcMain.handle('app:getLastSeenVersion', async () => {
  return getSetting('last_seen_version', '')
})

ipcMain.handle('app:setLastSeenVersion', async (_, version: string) => {
  setSetting('last_seen_version', version)
})

ipcMain.handle('app:shouldShowWhatsNew', async () => {
  const currentVersion = app.getVersion()
  const lastSeenVersion = getSetting('last_seen_version', '')
  
  // If no last seen version, don't show (first install)
  if (!lastSeenVersion) {
    // Set current version as last seen
    setSetting('last_seen_version', currentVersion)
    return false
  }
  
  // Compare versions (simple string comparison should work for semver)
  const compareVersions = (v1: string, v2: string): number => {
    const parts1 = v1.split('.').map(Number)
    const parts2 = v2.split('.').map(Number)
    
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0
      const part2 = parts2[i] || 0
      if (part1 > part2) return 1
      if (part1 < part2) return -1
    }
    return 0
  }
  
  // Show if current version is newer than last seen
  const isNewer = compareVersions(currentVersion, lastSeenVersion) > 0
  return isNewer
})

// Get release notes for a version
ipcMain.handle('app:getReleaseNotes', async (_, version: string) => {
  return await getReleaseNotes(version)
})

// GitHub API response type for releases
interface GitHubRelease {
  tag_name: string
  html_url: string
  body: string
  name: string | null
}

// Helper function to check for updates on GitHub
async function checkForUpdates(currentVersion: string): Promise<{ available: boolean; version: string | null; releaseUrl: string | null }> {
  try {
    // GitHub repository - update this if your repo is different
    const repoOwner = 'weeklyvillain'
    const repoName = 'cs2-demo-analyzer'
    const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/latest`
    
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CS2-Demo-Analyzer',
      },
    })
    
    if (!response.ok) {
      console.log(`[Update] GitHub API returned ${response.status}: ${response.statusText}`)
      return { available: false, version: null, releaseUrl: null }
    }
    
    const release = await response.json() as GitHubRelease
    const latestVersion = release.tag_name?.replace(/^v/, '') || null
    
    if (!latestVersion) {
      return { available: false, version: null, releaseUrl: null }
    }
    
    // Compare versions (simple string comparison, should work for semver)
    const compareVersions = (v1: string, v2: string): number => {
      const parts1 = v1.split('.').map(Number)
      const parts2 = v2.split('.').map(Number)
      
      for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const part1 = parts1[i] || 0
        const part2 = parts2[i] || 0
        if (part1 > part2) return 1
        if (part1 < part2) return -1
      }
      return 0
    }
    
    const isNewer = compareVersions(latestVersion, currentVersion) > 0
    
    return {
      available: isNewer,
      version: isNewer ? latestVersion : null,
      releaseUrl: isNewer ? release.html_url : null,
    }
  } catch (error) {
    console.error('[Update] Error checking for updates:', error)
    return { available: false, version: null, releaseUrl: null }
  }
}

// App info handler
ipcMain.handle('app:getInfo', async () => {
  const packageJson = require('../package.json')
  
  // Get app version
  const version = app.getVersion() || packageJson.version || '1.0.0'
  
  // Check for updates (only in production, skip in dev)
  let updateAvailable = false
  let updateVersion: string | null = null
  let updateReleaseUrl: string | null = null
  
  if (!isDev) {
    const updateCheck = await checkForUpdates(version)
    updateAvailable = updateCheck.available
    updateVersion = updateCheck.version
    updateReleaseUrl = updateCheck.releaseUrl
  }
  
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
    updateAvailable,
    updateVersion,
    updateReleaseUrl,
  }
})

// IPC handler to open external URLs
ipcMain.handle('app:openExternal', async (_, url: string) => {
  await shell.openExternal(url)
})

// Auto-updater IPC handlers (only in production)
if (!isDev) {
  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      return {
        updateInfo: result?.updateInfo ? {
          version: result.updateInfo.version,
          releaseDate: result.updateInfo.releaseDate,
        } : null,
      }
    } catch (error) {
      console.error('[AutoUpdater] Error checking for updates:', error)
      return { error: String(error) }
    }
  })
  
  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { success: true }
    } catch (error) {
      console.error('[AutoUpdater] Error downloading update:', error)
      return { success: false, error: String(error) }
    }
  })
  
  ipcMain.handle('update:install', () => {
    console.log('[AutoUpdater] Installing update silently and restarting...')
    // quitAndInstall(isSilent, isForceRunAfter)
    // isSilent=true: Silent install (no UI prompts)
    // isForceRunAfter=true: Run the app after installation
    autoUpdater.quitAndInstall(true, true)
  })
  
  // Splash window handlers
  ipcMain.handle('splash:getVersion', () => {
    return app.getVersion()
  })
  
  ipcMain.handle('splash:close', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close()
      splashWindow = null
    }
  })
}

// App restart handler (available in both dev and production)
ipcMain.handle('app:restart', () => {
  console.log('[App] Restarting application...')
  app.relaunch()
  app.quit()
})

// IPC handler to show file in folder
ipcMain.handle('file:showInFolder', async (_, filePath: string) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }
  shell.showItemInFolder(filePath)
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
  // Based on cs-demo-manager implementation
  const args: string[] = []
  args.push(`-insecure`)
  args.push(`-novid`)
  
  // Add demo path before window settings (matching cs-demo-manager order)
  args.push(`+playdemo`, demoPath)
  
  // Add window size (using -width/-height like cs-demo-manager)
  args.push(`-width`, windowWidth)
  args.push(`-height`, windowHeight)
  
  // Add window mode flag based on settings
  // These flags only apply to this launch and don't modify CS2's saved settings
  // CS2 uses -sw for windowed mode and -fullscreen for fullscreen (matching cs-demo-manager)
  if (windowMode === 'fullscreen') {
    args.push(`-fullscreen`)
  } else {
    // Default to windowed mode (has close/minimize buttons)
    // Use -sw flag (start windowed) for proper windowed mode
    args.push(`-sw`)
  }
  
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
  console.log('Window Mode Setting:', windowMode)
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
  console.log('--- Launch Arguments ---')
  console.log('Arguments Array:', JSON.stringify(args, null, 2))
  console.log('Full Command String:', fullCommand)
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

// Voice extraction IPC handler
ipcMain.handle('voice:extract', async (_, options: { demoPath: string; outputPath?: string; mode?: 'split-compact' | 'split-full' | 'single-full'; steamIds?: string[] }) => {
  const { demoPath, mode = 'split-compact', steamIds = [] } = options
  
  // Validate demo file exists
  if (!fs.existsSync(demoPath)) {
    throw new Error(`Demo file not found: ${demoPath}`)
  }
  
  // Use provided outputPath or create temp directory
  let outputPath = options.outputPath
  if (!outputPath) {
    const tempDir = app.getPath('temp')
    const outputDir = `cs2-voice-${Date.now()}`
    outputPath = path.join(tempDir, outputDir)
  }
  
  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true })
  }
  
  // Get voice extractor path
  const extractorPath = getVoiceExtractorPath()
  
  if (!fs.existsSync(extractorPath)) {
    throw new Error(`Voice extractor not found at: ${extractorPath}. Please install csgo-voice-extractor.`)
  }
  
  // Build command arguments (no quotes needed - spawn handles this automatically)
  const args: string[] = [
    '-exit-on-first-error',
    `-mode=${mode}`,
    `-output=${outputPath}`,
  ]
  
  // Add Steam IDs if specified
  if (steamIds.length > 0) {
    args.push(`-steam-ids=${steamIds.join(',')}`)
  }
  
  // Add demo path (must be last)
  args.push(demoPath)
  
  // Set library path for Linux/Mac
  const libraryPathVarName = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'
  const extractorDir = path.dirname(extractorPath)
  
  return new Promise<{ success: boolean; outputPath: string; files: string[]; filePaths: string[] }>((resolve, reject) => {
    console.log(`[Voice Extraction] Starting extractor: ${extractorPath}`)
    console.log(`[Voice Extraction] Args: ${args.join(' ')}`)
    
    // On Windows, handle paths with spaces properly
    // Quote all paths/args that contain spaces
    const quoteIfNeeded = (arg: string) => {
      return arg.includes(' ') && !arg.startsWith('"') ? `"${arg}"` : arg
    }
    
    let extractorProcess: ChildProcess
    
    if (process.platform === 'win32') {
      // On Windows with shell: true, build full command string to handle spaces
      const quotedExtractorPath = quoteIfNeeded(extractorPath)
      const quotedArgs = args.map(quoteIfNeeded).join(' ')
      const fullCommand = `${quotedExtractorPath} ${quotedArgs}`
      
      extractorProcess = exec(fullCommand, {
        cwd: extractorDir,
        env: {
          ...process.env,
          [libraryPathVarName]: extractorDir,
        },
        windowsHide: true,
      }) as ChildProcess
    } else {
      // On Unix, spawn works fine with array args
      extractorProcess = spawn(extractorPath, args, {
        cwd: extractorDir,
        env: {
          ...process.env,
          [libraryPathVarName]: extractorDir,
        },
        shell: false,
      })
    }
    
    let stdout = ''
    let stderr = ''
    
    extractorProcess.stdout?.on('data', (data) => {
      const output = data.toString()
      stdout += output
      console.log(`[Voice Extraction] ${output}`)
      
      // Notify renderer process of progress
      if (mainWindow) {
        mainWindow.webContents.send('voice:extractionLog', output)
      }
    })
    
    extractorProcess.stderr?.on('data', (data) => {
      const error = data.toString()
      stderr += error
      console.error(`[Voice Extraction Error] ${error}`)
      
      // Notify renderer process of errors
      if (mainWindow) {
        mainWindow.webContents.send('voice:extractionLog', error)
      }
    })
    
    extractorProcess.on('exit', (code) => {
      if (code === 0) {
        // List extracted files with full paths
        const files = fs.readdirSync(outputPath)
          .filter(file => file.endsWith('.wav'))
          .map(file => ({
            name: file,
            path: path.join(outputPath, file),
          }))
        console.log(`[Voice Extraction] Completed successfully. Extracted ${files.length} file(s).`)
        resolve({ success: true, outputPath, files: files.map(f => f.name), filePaths: files.map(f => f.path) })
      } else {
        console.error(`[Voice Extraction] Process exited with code ${code}`)
        console.error(`[Voice Extraction] stderr: ${stderr}`)
        reject(new Error(`Voice extraction failed with exit code ${code}. ${stderr || stdout}`))
      }
    })
    
    extractorProcess.on('error', (error) => {
      console.error(`[Voice Extraction] Process error:`, error)
      reject(new Error(`Failed to start voice extractor: ${error.message}`))
    })
  })
})

// Voice waveform generation IPC handler - generate waveform PNG using audiowaveform
ipcMain.handle('voice:generateWaveform', async (_, filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'Audio file not found' }
    }

    const audiowaveformPath = getAudiowaveformPath()
    if (!fs.existsSync(audiowaveformPath)) {
      return { success: false, error: `audiowaveform not found at: ${audiowaveformPath}` }
    }

    // Create temp directory for waveform output
    const tempDir = app.getPath('temp')
    const waveformDir = path.join(tempDir, 'cs2-waveforms')
    if (!fs.existsSync(waveformDir)) {
      fs.mkdirSync(waveformDir, { recursive: true })
    }

    // Generate unique filename based on audio file content hash
    // This ensures each unique audio file gets its own waveform
    const fileBuffer = fs.readFileSync(filePath)
    const audioHash = crypto.createHash('sha256').update(fileBuffer).digest('hex').substring(0, 32)
    const waveformPath = path.join(waveformDir, `waveform-${audioHash}.png`)

    // Check if waveform already exists (cache)
    if (fs.existsSync(waveformPath)) {
      const imageBuffer = fs.readFileSync(waveformPath)
      const base64 = imageBuffer.toString('base64')
      return { success: true, data: `data:image/png;base64,${base64}` }
    }

    // Build audiowaveform command
    // Colors: background #282b30, waveform #d07a2d, progress will be overlaid in React
    // Using bars style for better visual appeal
    // Higher resolution for better detail on voice comms
    const args: string[] = [
      '-i', filePath,
      '-o', waveformPath,
      '-w', '1200',  // Increased width for better detail
      '-h', '200',   // Increased height for better amplitude visibility
      '--waveform-style', 'bars',
      '--bar-width', '2',   // Slightly thinner bars for higher resolution
      '--bar-gap', '1',
      '--bar-style', 'rounded',
      '--background-color', '282b30',  // Dark background matching theme
      '--waveform-color', 'd07a2d',    // Orange waveform matching accent
      '--no-axis-labels',              // No axis labels for cleaner look
      '--amplitude-scale', '1.8',       // Lower fixed scale to preserve volume relationships
      '--pixels-per-second', '100',     // Higher time resolution for voice comms (was 50)
      // Higher resolution shows more detail in speech patterns and volume changes
    ]

    return new Promise<{ success: boolean; data?: string; error?: string }>((resolve) => {
      const audiowaveformProcess = spawn(audiowaveformPath, args, {
        cwd: path.dirname(audiowaveformPath),
        windowsHide: true,
      })

      let stderr = ''

      audiowaveformProcess.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      audiowaveformProcess.on('close', (code) => {
        if (code === 0 && fs.existsSync(waveformPath)) {
          try {
            const imageBuffer = fs.readFileSync(waveformPath)
            const base64 = imageBuffer.toString('base64')
            resolve({ success: true, data: `data:image/png;base64,${base64}` })
          } catch (error) {
            resolve({ success: false, error: `Failed to read waveform: ${error instanceof Error ? error.message : String(error)}` })
          }
        } else {
          resolve({ success: false, error: `audiowaveform failed with code ${code}: ${stderr}` })
        }
      })

      audiowaveformProcess.on('error', (error) => {
        resolve({ success: false, error: `Failed to spawn audiowaveform: ${error.message}` })
      })
    })
  } catch (error) {
    console.error('Error generating waveform:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// Voice extraction cleanup IPC handler - delete temp directory
ipcMain.handle('voice:cleanup', async (_, outputPath: string) => {
  if (!outputPath) {
    return { success: false, error: 'No output path provided' }
  }

  try {
    // Only delete if path is in temp directory (safety check)
    const tempDir = app.getPath('temp')
    const normalizedOutputPath = path.normalize(outputPath)
    const normalizedTempDir = path.normalize(tempDir)

    if (!normalizedOutputPath.startsWith(normalizedTempDir)) {
      console.warn(`[Voice Cleanup] Refusing to delete path outside temp directory: ${outputPath}`)
      return { success: false, error: 'Path is not in temp directory' }
    }

    // Check if directory exists
    if (!fs.existsSync(outputPath)) {
      console.log(`[Voice Cleanup] Directory does not exist: ${outputPath}`)
      return { success: true }
    }

    // Delete directory and all contents
    fs.rmSync(outputPath, { recursive: true, force: true })
    console.log(`[Voice Cleanup] Deleted temp directory: ${outputPath}`)
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[Voice Cleanup] Failed to delete directory ${outputPath}:`, errorMessage)
    return { success: false, error: errorMessage }
  }
})
