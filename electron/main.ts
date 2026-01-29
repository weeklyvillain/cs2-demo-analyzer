import { app, BrowserWindow, dialog, ipcMain, shell, clipboard, protocol, Menu, globalShortcut, screen } from 'electron'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import { spawn, ChildProcess, exec } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as crypto from 'crypto'
import * as net from 'net'
import { pathToFileURL } from 'url'
import { initSettingsDb, getSetting, setSetting, getAllSettings } from './settings'
import { initStatsDb, incrementStat, incrementMapParseCount, getAllStats, resetStats, trackDemoParsed, trackVoiceExtracted } from './stats'
import * as matchesService from './matchesService'

import { pushCommand, getCommandLog } from './commandLog'
import { cs2OverlayTracker } from './cs2OverlayTracker'
import { overlayHoverController } from './overlayHoverController'
import { ClipExportService, ExportOptions } from './clipExportService'

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let parserProcess: ChildProcess | null = null
let extractorProcess: ChildProcess | null = null // Track voice extractor process
let audiowaveformProcess: ChildProcess | null = null // Track audiowaveform process
let startupCleanupDeleted: Array<{ matchId: string; reason: string }> = []
let overlayInteractive: boolean = false
let overlayExplicitlyShown: boolean = false // Track if user explicitly toggled overlay visibility
let currentDemoPath: string | null = null // Track currently loaded demo in CS2
let currentHotkey: string = 'CommandOrControl+Shift+O'
let currentIncident: {
  matchId?: string
  tick: number
  eventType?: string
  offender: { name: string; steamId?: string; userId?: number; entityIndex?: number }
  victim: { name: string; steamId?: string; userId?: number; entityIndex?: number }
  meta?: any
  endTick?: number | null
} | null = null
// Store timeout IDs for pause timers so we can cancel them
let pauseTimerTimeout: NodeJS.Timeout | null = null

// File watcher for demo folders
let demoFolderWatchers: Map<string, fs.FSWatcher> = new Map()
let demoFileDebounce: Map<string, NodeJS.Timeout> = new Map()
let watchedDemoFolders: Set<string> = new Set()

// Command delay constant (ms)
const COMMAND_DELAY_MS = 150

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
    frame: false, // Use custom title bar
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

  // Listen for window maximize/unmaximize to update title bar
  mainWindow.on('maximize', () => {
    if (mainWindow) {
      mainWindow.webContents.send('window:maximized', true)
    }
  })

  mainWindow.on('unmaximize', () => {
    if (mainWindow) {
      mainWindow.webContents.send('window:maximized', false)
    }
  })
}

// Helper function to update overlay opacity based on interactive state
function updateOverlayOpacity(isClickThrough: boolean) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return
  }
  
  // When click-through: higher opacity (more visible) - 0.95
  // When interactive: lower opacity (less intrusive) - 0.85
  const opacity = isClickThrough ? 0.95 : 0.85
  overlayWindow.setOpacity(opacity)
}

// Helper function to set overlay interactive state with proper handoff sequence
// IMPORTANT: Handoff to CS2 only happens when CLOSING interactive mode (turning OFF),
// NOT when opening it (turning ON)
function setOverlayInteractiveState(value: boolean) {
  const wasInteractive = overlayInteractive
  
  // Only perform handoff when CLOSING (was ON, now OFF)
  const isClosing = wasInteractive && !value
  
  // Update tracker first - this will handle handoff if closing
  if (process.platform === 'win32') {
    cs2OverlayTracker.setOverlayInteractive(value)
  }
  
  // Update local state
  overlayInteractive = value
  
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // Make overlay click-through when not interactive
    overlayWindow.setIgnoreMouseEvents(!value, { forward: true })
    // Make overlay non-focusable when not interactive
    overlayWindow.setFocusable(value)
    // Update opacity: click-through (not interactive) = more opaque
    updateOverlayOpacity(!value)
    // Notify overlay window of state change
    overlayWindow.webContents.send('overlay:interactiveChanged', value)
  }
  
  if (isClosing) {
    console.log('[Overlay] Interactive mode closed - handoff to CS2 performed')
  }
}

// Create overlay window for CS2 demo playback
function createOverlayWindow() {
  // Check if overlay is enabled
  const overlayEnabled = getSetting('overlayEnabled', 'false') !== 'false'
  if (!overlayEnabled) {
    console.log('[Overlay] Overlay is disabled in settings, skipping creation')
    return null
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize

  overlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
    backgroundColor: '#00000000', // Fully transparent
  })

  // Set overlay to stay on top with highest level
  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  
  // Set click-through by default
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })

  // Load overlay route
  if (isDev) {
    overlayWindow.loadURL('http://localhost:5173/#/overlay')
  } else {
    // Use loadURL with file:// protocol to properly set the hash
    const indexPath = path.join(__dirname, '../dist/index.html')
    const fileUrl = pathToFileURL(indexPath).href + '#/overlay'
    overlayWindow.loadURL(fileUrl)
  }

  overlayWindow.on('closed', () => {
    // Stop overlay tracking before closing
    if (overlayWindow) {
      cs2OverlayTracker.stopTrackingCs2(overlayWindow)
    }
    overlayHoverController.setOverlayWindow(null)
    overlayWindow = null
  })

  overlayWindow.once('ready-to-show', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.showInactive() // Use showInactive to prevent stealing focus
      // Set initial opacity based on interactive state (click-through = more opaque)
      updateOverlayOpacity(!overlayInteractive)
      // Register overlay window with hover controller
      overlayHoverController.setOverlayWindow(overlayWindow)
    }
  })

  // Overlay tracking will be started when demo playback begins
  // (via cs2OverlayTracker.startTrackingCs2ForDemo)

  return overlayWindow
}

// Wrapper function to send CS2 commands (for overlay use)
function sendCsCmd(cmd: string): void {
  // Log command if debug mode is enabled
  const debugMode = getSetting('debugMode', 'false') === 'true'
  if (debugMode) {
    pushCommand(cmd)
    // Send updated command log to overlay
    sendCommandLogToOverlay()
  }
  
  const netconPort = getSetting('cs2_netconport', '2121')
  if (netconPort) {
    sendCS2CommandsSequentially(parseInt(netconPort), [cmd]).catch(err => {
      console.error('[overlay] Failed to send CS2 command:', err)
    })
  }
}

// Function to send command log to overlay
function sendCommandLogToOverlay(): void {
  const debugMode = getSetting('debugMode', 'false') === 'true'
  if (!debugMode || !overlayWindow || overlayWindow.isDestroyed()) {
    return
  }
  
  const log = getCommandLog()
  overlayWindow.webContents.send('overlay:commandLog', log)
}

app.whenReady().then(async () => {
  // Register protocol to serve map images (thumbnails for cards)
  protocol.registerFileProtocol('map', (request, callback) => {
    const url = request.url.replace('map://', '')
    const mapPath = path.join(__dirname, '../resources/maps', url)
    
    // Check if the map image exists, otherwise use unknown_map.png as fallback
    if (fs.existsSync(mapPath)) {
      callback({ path: mapPath })
    } else {
      const unknownMapPath = path.join(__dirname, '../resources/maps', 'unknown_map.png')
      callback({ path: unknownMapPath })
    }
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

  // Keyboard icon handler (for overlay hotkey display)
  ipcMain.handle('keyboard:getIcon', async (_, iconName: string) => {
    try {
      // iconName should be like "keyboard_ctrl" or "keyboard_o" (without extension)
      // Path is in resources/keyboard folder
      const iconFileName = `${iconName}.svg`
      const iconPath = path.join(__dirname, '../resources/keyboard', iconFileName)
      
      if (fs.existsSync(iconPath)) {
        const iconBuffer = fs.readFileSync(iconPath)
        const base64 = iconBuffer.toString('base64')
        return { success: true, data: `data:image/svg+xml;base64,${base64}` }
      } else {
        // Try outline version as fallback
        const outlineFileName = `${iconName}_outline.svg`
        const outlinePath = path.join(__dirname, '../resources/keyboard', outlineFileName)
        if (fs.existsSync(outlinePath)) {
          const iconBuffer = fs.readFileSync(outlinePath)
          const base64 = iconBuffer.toString('base64')
          return { success: true, data: `data:image/svg+xml;base64,${base64}` }
        }
        console.warn(`[KeyboardIcon] Icon not found: ${iconName} (tried ${iconPath} and ${outlinePath})`)
        return { success: false, error: `Keyboard icon not found: ${iconName}` }
      }
    } catch (error) {
      console.error('Error loading keyboard icon:', error)
      return { success: false, error: String(error) }
    }
  })

  // Player images (for 2D viewer)
  ipcMain.handle('player:getImage', async (_, team: 'T' | 'CT') => {
    try {
      const fileName = team === 'T' ? 'player_t.png' : 'player_ct.png'
      const playerPath = path.join(__dirname, '../resources/misc', fileName)
      
      if (fs.existsSync(playerPath)) {
        const imageBuffer = fs.readFileSync(playerPath)
        const base64 = imageBuffer.toString('base64')
        return { success: true, data: `data:image/png;base64,${base64}` }
      } else {
        return { success: false, error: `Player image not found: ${fileName}` }
      }
    } catch (error) {
      console.error('Error loading player image:', error)
      return { success: false, error: String(error) }
    }
  })

  // Initialize settings database
  await initSettingsDb()
  
  // Register overlay hotkey on startup
  let savedHotkey = getSetting('overlay_hotkey', 'CommandOrControl+Shift+O')
  // Normalize arrow keys to Electron format (in case old format is stored)
  savedHotkey = savedHotkey.replace(/ArrowUp/gi, 'Up')
  savedHotkey = savedHotkey.replace(/ArrowDown/gi, 'Down')
  savedHotkey = savedHotkey.replace(/ArrowLeft/gi, 'Left')
  savedHotkey = savedHotkey.replace(/ArrowRight/gi, 'Right')
  // Update stored value if it was normalized
  const originalHotkey = getSetting('overlay_hotkey', 'CommandOrControl+Shift+O')
  if (savedHotkey !== originalHotkey) {
    setSetting('overlay_hotkey', savedHotkey)
  }
  currentHotkey = savedHotkey
  
  // Register hotkey with error handling
  try {
    const registered = globalShortcut.register(savedHotkey, () => {
    // Create overlay window if it doesn't exist
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow()
      // Wait a bit for window to be ready
      setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          // Toggle show/hide instead of interactive state
          overlayExplicitlyShown = !overlayExplicitlyShown
          if (overlayExplicitlyShown) {
            overlayWindow.showInactive()
            // Notify tracker that overlay is explicitly shown
            if (process.platform === 'win32') {
              cs2OverlayTracker.setOverlayExplicitlyShown(true)
            }
          } else {
            overlayWindow.hide()
            // Notify tracker that overlay is explicitly hidden
            if (process.platform === 'win32') {
              cs2OverlayTracker.setOverlayExplicitlyShown(false)
            }
          }
        }
      }, 500)
    } else {
      // Toggle show/hide instead of interactive state
      overlayExplicitlyShown = !overlayExplicitlyShown
      if (overlayExplicitlyShown) {
        overlayWindow.showInactive()
        // Notify tracker that overlay is explicitly shown
        if (process.platform === 'win32') {
          cs2OverlayTracker.setOverlayExplicitlyShown(true)
        }
      } else {
        overlayWindow.hide()
        // Notify tracker that overlay is explicitly hidden
        if (process.platform === 'win32') {
          cs2OverlayTracker.setOverlayExplicitlyShown(false)
        }
      }
    }
    })
    
    if (!registered) {
      console.error(`[Hotkey] Failed to register hotkey on startup: ${savedHotkey}`)
    } else {
      console.log(`[Hotkey] Registered overlay hotkey: ${savedHotkey}`)
    }
  } catch (error) {
    console.error(`[Hotkey] Error registering hotkey on startup: ${savedHotkey}`, error)
    // Reset to default on error
    const defaultHotkey = 'CommandOrControl+Shift+O'
    currentHotkey = defaultHotkey
    setSetting('overlay_hotkey', defaultHotkey)
    try {
      globalShortcut.register(defaultHotkey, () => {
        if (!overlayWindow || overlayWindow.isDestroyed()) {
          createOverlayWindow()
          setTimeout(() => {
            if (overlayWindow && !overlayWindow.isDestroyed()) {
              overlayExplicitlyShown = !overlayExplicitlyShown
              if (overlayExplicitlyShown) {
                overlayWindow.showInactive()
                if (process.platform === 'win32') {
                  cs2OverlayTracker.setOverlayExplicitlyShown(true)
                }
              } else {
                overlayWindow.hide()
                if (process.platform === 'win32') {
                  cs2OverlayTracker.setOverlayExplicitlyShown(false)
                }
              }
            }
          }, 500)
        } else {
          overlayExplicitlyShown = !overlayExplicitlyShown
          if (overlayExplicitlyShown) {
            overlayWindow.showInactive()
            if (process.platform === 'win32') {
              cs2OverlayTracker.setOverlayExplicitlyShown(true)
            }
          } else {
            overlayWindow.hide()
            if (process.platform === 'win32') {
              cs2OverlayTracker.setOverlayExplicitlyShown(false)
            }
          }
        }
      })
      console.log(`[Hotkey] Registered default hotkey after error: ${defaultHotkey}`)
    } catch (defaultError) {
      console.error(`[Hotkey] Failed to register default hotkey: ${defaultHotkey}`, defaultError)
    }
  }
  
  // Initialize stats database
  await initStatsDb()
  
  // Ensure matches directory exists
  matchesService.ensureMatchesDir()
  
  // Perform startup integrity check
  startupCleanupDeleted = await matchesService.performStartupIntegrityCheck()
  if (startupCleanupDeleted.length > 0) {
    console.log(`[Startup] Cleaned up ${startupCleanupDeleted.length} orphan/corrupt databases`)
  }
  
  // Initialize demo folder watcher
  const demoFolders = getSetting('demo_folders', '')
  if (demoFolders) {
    const folders = demoFolders.split('|').filter(f => f.trim())
    try {
      setupDemoFolderWatcher(folders)
    } catch (err) {
      console.error('[Watcher] Failed to initialize demo folder watcher:', err)
    }
  }
  
  // In production, show splash screen first and check for updates
  // In dev, just create the main window
  if (!isDev) {
    createSplashWindow()
    // Check if auto-update is enabled before initializing
    const autoUpdateEnabled = getSetting('autoUpdateEnabled', 'true') === 'true'
    if (autoUpdateEnabled) {
      initializeAutoUpdater()
    } else {
      console.log('[AutoUpdater] Auto-update is disabled in settings')
      // Open main window immediately if auto-update is disabled
      setTimeout(() => {
        createWindow()
      }, 1000)
    }
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

// Helper function to kill a process forcefully
function killProcessForcefully(childProcess: ChildProcess | null, name: string): void {
  if (!childProcess) return
  
  try {
    if (childProcess.pid) {
      console.log(`[App] Killing ${name} process (PID: ${childProcess.pid})`)
      if (process.platform === 'win32') {
        // On Windows, use taskkill for more reliable termination
        exec(`taskkill /F /T /PID ${childProcess.pid}`, { windowsHide: true }, (error) => {
          if (error) {
            console.warn(`[App] taskkill failed for ${name}, trying kill():`, error.message)
            try {
              childProcess.kill('SIGKILL')
            } catch (err) {
              console.error(`[App] Failed to kill ${name}:`, err)
            }
          }
        })
      } else {
        // On Unix, try SIGTERM first, then SIGKILL
        try {
          childProcess.kill('SIGTERM')
          // If process doesn't exit quickly, force kill
          setTimeout(() => {
            if (childProcess && !childProcess.killed && childProcess.pid) {
              try {
                childProcess.kill('SIGKILL')
              } catch (err) {
                console.error(`[App] Failed to force kill ${name}:`, err)
              }
            }
          }, 500)
        } catch (err) {
          console.error(`[App] Error killing ${name}:`, err)
        }
      }
    } else {
      // Fallback if no PID
      try {
        childProcess.kill('SIGKILL')
      } catch (err) {
        console.error(`[App] Failed to kill ${name} (no PID):`, err)
      }
    }
  } catch (err) {
    console.error(`[App] Error killing ${name}:`, err)
  }
}

app.on('before-quit', (event) => {
  console.log('[App] Cleaning up processes before quit...')
  
  // Kill parser process if running
  if (parserProcess) {
    killProcessForcefully(parserProcess, 'parser')
    parserProcess = null
  }
  
  // Kill voice extractor process if running
  if (extractorProcess) {
    killProcessForcefully(extractorProcess, 'voice extractor')
    extractorProcess = null
  }
  
  // Kill audiowaveform process if running
  if (audiowaveformProcess) {
    killProcessForcefully(audiowaveformProcess, 'audiowaveform')
    audiowaveformProcess = null
  }
  
  // Clear pause timer if running
  if (pauseTimerTimeout) {
    console.log('[App] Clearing pause timer')
    clearTimeout(pauseTimerTimeout)
    pauseTimerTimeout = null
  }
  
  // Unregister all global shortcuts
  globalShortcut.unregisterAll()
  
  // Stop overlay tracking (this will also stop WinEvent hooks and health check interval)
  if (overlayWindow) {
    console.log('[App] Stopping overlay tracking')
    cs2OverlayTracker.stopTrackingCs2(overlayWindow)
  }
  
  // Close all windows to ensure renderer processes terminate
  const allWindows = BrowserWindow.getAllWindows()
  console.log(`[App] Closing ${allWindows.length} window(s)`)
  allWindows.forEach(win => {
    if (!win.isDestroyed()) {
      win.removeAllListeners('close') // Prevent close handlers from interfering
      win.destroy()
    }
  })
  
  console.log('[App] Cleanup complete')
})

// Helper to get parser executable path
function getParserPath(): string {
  if (isDev) {
    // Dev: use configurable path or check common locations
    // __dirname in dev is dist-electron, so go up one level to project root
    const projectRoot = path.resolve(__dirname, '..')
    
    // If PARSER_PATH is explicitly set, use it
    if (process.env.PARSER_PATH) {
      const devPath = process.env.PARSER_PATH
      if (process.platform === 'win32' && !devPath.endsWith('.exe')) {
        return devPath + '.exe'
      }
      return devPath
    }
    
    // Use bin/parser in dev mode
    const defaultPath = path.join(projectRoot, 'bin', 'parser')
    if (process.platform === 'win32') {
      return defaultPath + '.exe'
    }
    return defaultPath
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

// Demo folder watcher management
function setupDemoFolderWatcher(folderPaths: string[]) {
  // Clean up existing watchers
  for (const watcher of demoFolderWatchers.values()) {
    watcher.close()
  }
  demoFolderWatchers.clear()
  watchedDemoFolders.clear()
  
  if (!folderPaths || folderPaths.length === 0) {
    return
  }
  
  // Filter to only valid, existing folders
  const validFolders = folderPaths.filter(folder => {
    try {
      return fs.existsSync(folder) && fs.statSync(folder).isDirectory()
    } catch {
      return false
    }
  })
  
  if (validFolders.length === 0) {
    return
  }
  
  watchedDemoFolders = new Set(validFolders)
  
  console.log(`[Watcher] Setting up demo folder watcher for: ${Array.from(watchedDemoFolders).join(', ')}`)
  
  // Use native fs.watch for each folder (more compatible with Electron)
  for (const folderPath of validFolders) {
    try {
      const watcher = fs.watch(folderPath, { persistent: true, recursive: false }, (eventType, filename) => {
        if (!filename || !filename.toLowerCase().endsWith('.dem')) {
          return
        }
        
        const filePath = path.join(folderPath, filename)
        
        // Debounce with timer
        const debounceKey = filePath
        if (demoFileDebounce.has(debounceKey)) {
          clearTimeout(demoFileDebounce.get(debounceKey))
        }
        
        const timer = setTimeout(() => {
          try {
            const exists = fs.existsSync(filePath)
            const event = exists ? 'add' : 'unlink'
            
            console.log(`[Watcher] Demo file ${event}: ${filePath}`)
            if (mainWindow) {
              if (event === 'add') {
                mainWindow.webContents.send('demos:fileAdded', { filePath })
              } else {
                mainWindow.webContents.send('demos:fileRemoved', { filePath })
              }
            }
          } finally {
            demoFileDebounce.delete(debounceKey)
          }
        }, 2000) // 2 second debounce
        
        demoFileDebounce.set(debounceKey, timer as any)
      })
      
      watcher.on('error', (error: unknown) => {
        console.error(`[Watcher] Error watching ${folderPath}:`, error)
      })
      
      demoFolderWatchers.set(folderPath, watcher)
    } catch (err) {
      console.error(`[Watcher] Failed to setup watcher for ${folderPath}:`, err)
    }
  }
  
  if (demoFolderWatchers.size > 0) {
    console.log(`[Watcher] Successfully initialized demo folder watchers for ${demoFolderWatchers.size} folder(s)`)
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

ipcMain.handle('dialog:openDirectory', async () => {
  if (!mainWindow) return null

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return result.filePaths[0]
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
  
  // Clear old database if it exists (for reparsing)
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath)
      console.log(`[Parser] Deleted old database at ${dbPath} for fresh parse`)
    } catch (err) {
      console.warn(`[Parser] Warning: Failed to delete old database: ${err}`)
      // Continue anyway, the parser will try to work with the existing database
    }
  }
  
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
  
  // Get RAM-only parsing setting (default to false)
  const ramOnlyParsing = getSetting('ram_only_parsing', 'false') === 'true'
  
  // Build parser arguments
  const parserArgs = [
    '--demo', demoPath,
    '--out', dbPath,
    '--match-id', matchId,
    '--position-interval', positionInterval,
  ]
  
  // If RAM-only parsing is enabled, pass empty matchID to force in-memory mode
  // This makes the parser accumulate all data in memory before writing
  if (ramOnlyParsing) {
    // Remove --match-id to force in-memory mode (writer != nil but matchID == "")
    // This triggers the in-memory mode in ParseWithDB
    parserArgs.splice(parserArgs.indexOf('--match-id'), 2)
    // Note: The parser will still write to the database, but only after parsing completes
    // All data will be accumulated in memory during parsing
  }
  
  // Spawn parser process with descriptive name
  parserProcess = spawn(parserPath, parserArgs, {
    env: {
      ...process.env,
      // Set process name via environment variable for identification
      PROCESS_NAME: 'CS2 Demo Parser',
    },
  })

  // Track parsing start time
  const parsingStartTime = Date.now()
  const demoDemoSizeBytes = fs.statSync(demoPath).size

  // Collect parser logs (both stdout and stderr)
  const parserLogs: string[] = []

  // Handle stdout (NDJSON - progress and info logs)
  parserProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(line => line.trim())
    for (const line of lines) {
      try {
        // Parse NDJSON and format for display
        const json = JSON.parse(line)
        if (json.type === 'log') {
          // Format log message: "[LEVEL] message"
          parserLogs.push(`[${json.level?.toUpperCase() || 'INFO'}] ${json.msg}`)
        } else if (json.type === 'progress') {
          // Format progress: "stage: X/Y (Zz%) - tick: N"
          const pctStr = (json.pct * 100).toFixed(1)
          parserLogs.push(`[PROGRESS] ${json.stage}: ${pctStr}% (round ${json.round}, tick ${json.tick})`)
        } else if (json.type === 'error') {
          parserLogs.push(`[ERROR] ${json.msg}`)
        }
      } catch {
        // If not valid JSON, treat as plain log line
        parserLogs.push(line)
      }
      mainWindow?.webContents.send('parser:message', line)
    }
  })

  // Handle stderr (error messages and warnings)
  parserProcess.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(line => line.trim())
    for (const line of lines) {
      // Check if line is a DEBUG log
      if (line.startsWith('DEBUG:')) {
        parserLogs.push(`[DEBUG] ${line.substring(6).trim()}`)
      } else {
        // Prefix other stderr with [STDERR] to distinguish from stdout logs
        parserLogs.push(`[STDERR] ${line}`)
      }
      mainWindow?.webContents.send('parser:log', line)
    }
  })

  // Handle process exit
  parserProcess.on('exit', async (code, signal) => {
    parserProcess = null
    mainWindow?.webContents.send('parser:exit', { code, signal })
    
    // Store parser logs to database
    if (parserLogs.length > 0) {
      try {
        const initSqlJs = require('sql.js')
        const SQL = await initSqlJs()
        const buffer = fs.readFileSync(dbPath)
        const db = new SQL.Database(buffer)
        
        const logContent = parserLogs.join('\n')
        const stmt = db.prepare('INSERT OR REPLACE INTO parser_logs (match_id, logs, created_at) VALUES (?, ?, ?)')
        stmt.bind([matchId, logContent, new Date().toISOString()])
        stmt.step()
        stmt.free()
        
        const data = db.export()
        db.close()
        fs.writeFileSync(dbPath, Buffer.from(data))
      } catch (err) {
        console.error('[Main] Failed to store parser logs:', err)
      }
    }
    
    // If parsing succeeded, refresh matches list and track stats
    if (code === 0) {
      // Calculate parsing time
      const parsingTimeMs = Date.now() - parsingStartTime
      
      // Track demo parsing stats (size and time)
      trackDemoParsed(demoDemoSizeBytes, parsingTimeMs)
      
      // Refresh matches list so the new match appears
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          const matches = await matchesService.listMatches()
          mainWindow.webContents.send('matches:list', matches)
        } catch (err) {
          console.error('[Main] Failed to refresh matches list after parsing:', err)
        }
      }
      
      // Get map name from database and track map parse count
      try {
        const initSqlJs = require('sql.js')
        const SQL = await initSqlJs()
        const buffer = fs.readFileSync(dbPath)
        const db = new SQL.Database(buffer)
        
        const stmt = db.prepare('SELECT map FROM matches WHERE id = ?')
        stmt.bind([matchId])
        if (stmt.step()) {
          const row = stmt.getAsObject()
          const mapName = row.map as string
          if (mapName) {
            incrementMapParseCount(mapName)
          }
        }
        stmt.free()
        db.close()
      } catch (err) {
        console.error('[Stats] Failed to get map name for stats:', err)
      }
      
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

ipcMain.handle('demos:getUnparsed', async () => {
  try {
    const appDataPath = app.getPath('userData')
    const matchesDir = path.join(appDataPath, 'matches')
    
    // Ensure matches directory exists
    if (!fs.existsSync(matchesDir)) {
      fs.mkdirSync(matchesDir, { recursive: true })
    }
    
    // Get all parsed demo paths from .sqlite files
    const parsedDemoPaths = new Set<string>()
    const sqliteFiles = fs.readdirSync(matchesDir).filter(file => file.endsWith('.sqlite'))
    
    for (const sqliteFile of sqliteFiles) {
      const dbPath = path.join(matchesDir, sqliteFile)
      try {
        const initSqlJs = require('sql.js')
        const SQL = await initSqlJs()
        const buffer = fs.readFileSync(dbPath)
        const db = new SQL.Database(buffer)
        
        // Get demo_path from meta table
        const metaStmt = db.prepare('SELECT value FROM meta WHERE key = ?')
        metaStmt.bind(['demo_path'])
        if (metaStmt.step()) {
          const demoPaths = metaStmt.get()
          if (demoPaths && demoPaths[0]) {
            parsedDemoPaths.add(demoPaths[0])
          }
        }
        metaStmt.free()
        db.close()
      } catch (err) {
        console.error(`Failed to read demo path from ${sqliteFile}:`, err)
      }
    }
    
    // Get demo folders from settings
    const demoFoldersSetting = getSetting('demo_folders', '')
    if (!demoFoldersSetting) {
      // No demo folders configured
      return []
    }
    
    const demoFolders = demoFoldersSetting.split('|').filter(f => f.trim() && fs.existsSync(f))
    if (demoFolders.length === 0) {
      return []
    }
    
    // Scan all demo folders for .dem files
    const unparsedDemos: Array<{ fileName: string; filePath: string; fileSize: number; createdAt: string }> = []
    
    for (const demoFolder of demoFolders) {
      try {
        const files = fs.readdirSync(demoFolder)
        
        for (const file of files) {
          if (!file.toLowerCase().endsWith('.dem')) continue
          
          const filePath = path.join(demoFolder, file)
          
          // Skip if already parsed
          if (parsedDemoPaths.has(filePath)) continue
          
          try {
            const stats = fs.statSync(filePath)
            unparsedDemos.push({
              fileName: file,
              filePath: filePath,
              fileSize: stats.size,
              createdAt: stats.birthtime.toISOString(),
            })
          } catch (err) {
            console.warn(`Failed to stat demo file ${filePath}:`, err)
          }
        }
      } catch (err) {
        console.error(`Failed to scan demo folder ${demoFolder}:`, err)
      }
    }
    
    return unparsedDemos
  } catch (err) {
    console.error('Failed to get unparsed demos:', err)
    throw new Error('Failed to scan for unparsed demos')
  }
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

ipcMain.handle('matches:parserLogs', async (_, matchId: string) => {
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
    
    let logs = ''
    try {
      const stmt = db.prepare('SELECT logs FROM parser_logs WHERE match_id = ?')
      stmt.bind([matchId])
      
      if (stmt.step()) {
        const row = stmt.getAsObject()
        logs = (row.logs as string) || ''
      }
      stmt.free()
    } catch (err: any) {
      // Table doesn't exist for older demos - this is expected
      if (err.message?.includes('no such table')) {
        logs = '' // Return empty logs for older demos
      } else {
        throw err // Re-throw other errors
      }
    }
    db.close()

    return { matchId, logs }
  } catch (err) {
    throw new Error(`Failed to get parser logs: ${err}`)
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
    
    // Check if team column exists, if not add it
    try {
      db.run(`ALTER TABLE players ADD COLUMN team TEXT`)
    } catch (err: any) {
      // Column might already exist, ignore error
      if (!err.message?.includes('duplicate column')) {
        console.warn('Failed to add team column (might already exist):', err)
      }
    }
    
    // Check if new columns exist, add them if not
    try {
      db.run(`ALTER TABLE players ADD COLUMN connected_midgame INTEGER DEFAULT 0`)
    } catch (err: any) {
      if (!err.message?.includes('duplicate column')) {
        console.warn('Failed to add connected_midgame column (might already exist):', err)
      }
    }
    try {
      db.run(`ALTER TABLE players ADD COLUMN permanent_disconnect INTEGER DEFAULT 0`)
    } catch (err: any) {
      if (!err.message?.includes('duplicate column')) {
        console.warn('Failed to add permanent_disconnect column (might already exist):', err)
      }
    }
    try {
      db.run(`ALTER TABLE players ADD COLUMN first_connect_round INTEGER`)
    } catch (err: any) {
      if (!err.message?.includes('duplicate column')) {
        console.warn('Failed to add first_connect_round column (might already exist):', err)
      }
    }
    try {
      db.run(`ALTER TABLE players ADD COLUMN disconnect_round INTEGER`)
    } catch (err: any) {
      if (!err.message?.includes('duplicate column')) {
        console.warn('Failed to add disconnect_round column (might already exist):', err)
      }
    }
    
    // Get all players (not just those with scores)
    const stmt = db.prepare(`
      SELECT steamid, name, team, 
             COALESCE(connected_midgame, 0) as connected_midgame,
             COALESCE(permanent_disconnect, 0) as permanent_disconnect,
             first_connect_round, disconnect_round
      FROM players
      WHERE match_id = ?
      ORDER BY team, name
    `)
    stmt.bind([matchId])
    
    const players: Array<{ 
      steamId: string
      name: string
      team: string | null
      connectedMidgame: boolean
      permanentDisconnect: boolean
      firstConnectRound: number | null
      disconnectRound: number | null
    }> = []
    while (stmt.step()) {
      const row = stmt.getAsObject()
      const firstConnectRound = row.first_connect_round !== null && row.first_connect_round !== undefined 
        ? (row.first_connect_round as number) 
        : null
      const disconnectRound = row.disconnect_round !== null && row.disconnect_round !== undefined 
        ? (row.disconnect_round as number) 
        : null
      players.push({
        steamId: row.steamid as string,
        name: (row.name as string) || (row.steamid as string),
        team: (row.team as string) || null,
        connectedMidgame: (row.connected_midgame as number) === 1,
        permanentDisconnect: (row.permanent_disconnect as number) === 1,
        firstConnectRound: firstConnectRound,
        disconnectRound: disconnectRound,
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

// Clip export IPC handler
ipcMain.handle('clips:export', async (event, payload: ExportOptions) => {
  try {
    // Validate required fields
    if (!payload.demoPath || !fs.existsSync(payload.demoPath)) {
      throw new Error('Demo file not found')
    }
    if (!payload.clipRanges || payload.clipRanges.length === 0) {
      throw new Error('No clip ranges provided')
    }
    if (payload.playbackSpeed <= 0 || payload.playbackSpeed > 10) {
      throw new Error('Playback speed must be between 0.1 and 10')
    }

    const netconPort = parseInt(getSetting('cs2_netconport', '2121'), 10)
    const exportService = new ClipExportService(netconPort)

    // Get output directory from settings or use payload
    const clipsOutputDir = getSetting('clips_output_dir', '')
    if (!payload.outputDir && clipsOutputDir) {
      payload.outputDir = clipsOutputDir
    }

    // Subscribe to progress updates and forward to renderer
    const result = await exportService.exportClips(payload, (progress) => {
      // Send progress to renderer
      event.sender.send('clips:export:progress', progress)
    })

    return result
  } catch (err) {
    console.error('[ClipExport] Error:', err)
    return {
      success: false,
      clips: [],
      error: err instanceof Error ? err.message : 'Unknown error during clip export',
    }
  }
})

// Stats IPC handlers
ipcMain.handle('stats:getAll', async () => {
  return getAllStats()
})

ipcMain.handle('stats:reset', async () => {
  resetStats()
  return { success: true }
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
  
  // Setup watcher if demo folder setting changes
  if (key === 'demo_folders') {
    try {
      const folders = value ? value.split('|').filter(f => f.trim()) : []
      await setupDemoFolderWatcher(folders)
    } catch (err) {
      console.error('Failed to setup demo folder watcher:', err)
    }
  }
  
  return { success: true }
})

ipcMain.handle('settings:getAll', async () => {
  return getAllSettings()
})

ipcMain.handle('demos:selectFolders', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'multiSelections'],
      title: 'Select demo folders to watch',
    })
    
    if (!result.canceled && result.filePaths.length > 0) {
      // Save selected folders
      const folderPath = result.filePaths.join('|')
      setSetting('demo_folders', folderPath)
      try {
        setupDemoFolderWatcher(result.filePaths)
      } catch (watchErr) {
        console.error('Failed to setup demo folder watcher:', watchErr)
        // Still return success - user selected folders, watcher setup might fail gracefully
      }
      return { success: true, folders: result.filePaths }
    }
    
    return { success: false }
  } catch (err) {
    console.error('Failed to select demo folders:', err)
    throw new Error('Failed to select demo folders')
  }
})

ipcMain.handle('demos:addFolder', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Select a demo folder to add',
    })
    
    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, folder: result.filePaths[0] }
    }
    
    return { success: false }
  } catch (err) {
    console.error('Failed to add demo folder:', err)
    throw new Error('Failed to add demo folder')
  }
})

ipcMain.handle('demos:getDemoFolders', async () => {
  try {
    const folderPath = getSetting('demo_folders', '')
    if (!folderPath) {
      return []
    }
    return folderPath.split('|').filter(f => f.trim() && fs.existsSync(f))
  } catch (err) {
    console.error('Failed to get demo folders:', err)
    return []
  }
})


// Voice cache management
ipcMain.handle('voice:getCacheInfo', async () => {
  const currentSize = calculateCacheSize()
  const limit = getCacheSizeLimit()
  return {
    currentSize,
    limit,
    currentSizeMB: (currentSize / 1024 / 1024).toFixed(2),
    limitMB: (limit / 1024 / 1024).toFixed(2),
  }
})

ipcMain.handle('voice:cleanupCache', async () => {
  cleanupCacheIfNeeded()
  const currentSize = calculateCacheSize()
  return {
    currentSize,
    currentSizeMB: (currentSize / 1024 / 1024).toFixed(2),
  }
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
async function getReleaseNotes(version: string): Promise<{ title: string; body: string } | null> {
  try {
    const repoOwner = 'weeklyvillain'
    const repoName = 'cs2-demo-analyzer'
    
    // Normalize version (remove 'v' prefix if present)
    const normalizedVersion = version.replace(/^v/, '')
    console.log(`[Release Notes] Fetching notes for version: ${normalizedVersion}`)
    
    // Try different tag formats
    const tagVariants = [
      `v${normalizedVersion}`,  // v1.0.21
      normalizedVersion,          // 1.0.21
    ]
    
    for (const tag of tagVariants) {
      try {
        const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/tags/${tag}`
        console.log(`[Release Notes] Trying tag: ${tag}`)
        
        const response = await fetch(apiUrl, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'CS2-Demo-Analyzer',
          },
        })
        
        if (response.ok) {
          const release = await response.json() as GitHubRelease
          console.log(`[Release Notes] Found release: ${release.tag_name}, body length: ${release.body?.length || 0}`)
          
          return {
            title: release.name || `What's New in Version ${normalizedVersion}`,
            body: release.body || '',
          }
        } else {
          console.log(`[Release Notes] Tag ${tag} not found: ${response.status} ${response.statusText}`)
        }
      } catch (err) {
        console.error(`[Release Notes] Error trying tag ${tag}:`, err)
        // Continue to next tag variant
        continue
      }
    }
    
    // If specific release not found, try listing all releases and find matching one
    try {
      console.log(`[Release Notes] Trying to list all releases to find version ${normalizedVersion}`)
      const allReleasesUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases`
      const allReleasesResponse = await fetch(allReleasesUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'CS2-Demo-Analyzer',
        },
      })
      
      if (allReleasesResponse.ok) {
        const allReleases = await allReleasesResponse.json() as GitHubRelease[]
        console.log(`[Release Notes] Found ${allReleases.length} total releases`)
        
        // Find release matching the version
        for (const release of allReleases) {
          const releaseVersion = release.tag_name?.replace(/^v/, '') || ''
          if (releaseVersion === normalizedVersion) {
            console.log(`[Release Notes] Found matching release: ${release.tag_name}`)
            return {
              title: release.name || `What's New in Version ${normalizedVersion}`,
              body: release.body || '',
            }
          }
        }
      }
    } catch (err) {
      console.error('[Release Notes] Error listing all releases:', err)
    }
    
    console.log(`[Release Notes] Could not find release notes for version ${normalizedVersion}`)
    return null
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
  console.log(`[IPC] app:getReleaseNotes called with version: ${version}`)
  const result = await getReleaseNotes(version)
  console.log(`[IPC] app:getReleaseNotes returning:`, result ? { title: result.title, bodyLength: result.body?.length || 0 } : 'null')
  return result
})

ipcMain.handle('app:getAvailableVersions', async () => {
  console.log('[IPC] app:getAvailableVersions called')
  const versions = await getAvailableVersions()
  console.log(`[IPC] app:getAvailableVersions returning ${versions.length} versions`)
  return versions
})

// Helper function to download and install a specific version
async function downloadAndInstallVersion(version: string): Promise<{ success: boolean; error?: string }> {
  try {
    const repoOwner = 'weeklyvillain'
    const repoName = 'cs2-demo-analyzer'
    
    // Find the release for this version
    const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/tags/v${version}`
    // Try without v prefix if that fails
    let response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CS2-Demo-Analyzer',
      },
    })
    
    if (!response.ok) {
      // Try with v prefix
      const altApiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/tags/${version}`
      response = await fetch(altApiUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'CS2-Demo-Analyzer',
        },
      })
    }
    
    if (!response.ok) {
      return { success: false, error: `Release not found for version ${version}` }
    }
    
    const release = await response.json() as GitHubRelease
    
    // Find the installer asset for Windows
    const platform = process.platform
    let installerAsset: { name: string; browser_download_url: string } | null = null
    
    if (platform === 'win32') {
      // Look for .exe installer
      installerAsset = release.assets?.find(asset => 
        asset.name.endsWith('.exe') && 
        (asset.name.includes('Setup') || asset.name.includes('Installer'))
      ) || null
      
      // Fallback: any .exe file
      if (!installerAsset) {
        installerAsset = release.assets?.find(asset => asset.name.endsWith('.exe')) || null
      }
    } else if (platform === 'darwin') {
      // Look for .dmg or .zip for macOS
      installerAsset = release.assets?.find(asset => 
        asset.name.endsWith('.dmg') || asset.name.endsWith('.zip')
      ) || null
    } else if (platform === 'linux') {
      // Look for .AppImage, .deb, or .rpm for Linux
      installerAsset = release.assets?.find(asset => 
        asset.name.endsWith('.AppImage') || 
        asset.name.endsWith('.deb') || 
        asset.name.endsWith('.rpm')
      ) || null
    }
    
    if (!installerAsset) {
      return { success: false, error: `No installer found for ${platform} in version ${version}` }
    }
    
    console.log(`[Update] Downloading installer: ${installerAsset.name}`)
    
    // Download the installer to temp directory
    const tempDir = app.getPath('temp')
    const installerPath = path.join(tempDir, installerAsset.name)
    
    const downloadResponse = await fetch(installerAsset.browser_download_url)
    if (!downloadResponse.ok) {
      return { success: false, error: `Failed to download installer: ${downloadResponse.statusText}` }
    }
    
    const buffer = Buffer.from(await downloadResponse.arrayBuffer())
    fs.writeFileSync(installerPath, buffer)
    
    console.log(`[Update] Installer downloaded to: ${installerPath}`)
    
    // Execute the installer
    if (platform === 'win32') {
      // On Windows, execute the installer which will handle installation and restart
      // Use spawn to detach the process so it continues after app quits
      const installerProcess = spawn(installerPath, ['/S'], {
        detached: true,
        stdio: 'ignore',
      })
      installerProcess.unref()
      
      // Give it a moment to start, then quit the app
      // The installer will handle closing the app and restarting
      setTimeout(() => {
        app.quit()
      }, 1000)
    } else if (platform === 'darwin') {
      // On macOS, open the DMG
      exec(`open "${installerPath}"`, (error) => {
        if (error) {
          console.error('[Update] Error opening DMG:', error)
        }
      })
    } else if (platform === 'linux') {
      // On Linux, make AppImage executable and run it, or install deb/rpm
      if (installerAsset.name.endsWith('.AppImage')) {
        fs.chmodSync(installerPath, 0o755)
        exec(`"${installerPath}"`, (error) => {
          if (error) {
            console.error('[Update] Error executing AppImage:', error)
          }
        })
      } else {
        // For .deb or .rpm, user needs to install manually
        return { success: false, error: 'Please install the downloaded package manually' }
      }
    }
    
    return { success: true }
  } catch (error) {
    console.error('[Update] Error downloading and installing version:', error)
    return { success: false, error: String(error) }
  }
}

ipcMain.handle('update:downloadAndInstallVersion', async (_, version: string) => {
  console.log(`[IPC] update:downloadAndInstallVersion called with version: ${version}`)
  const result = await downloadAndInstallVersion(version)
  return result
})

// GitHub API response type for releases
interface GitHubRelease {
  tag_name: string
  html_url: string
  body: string
  name: string | null
  assets?: Array<{
    name: string
    browser_download_url: string
    content_type: string
    size: number
  }>
}

// Helper function to fetch all available versions from GitHub releases
async function getAvailableVersions(): Promise<string[]> {
  try {
    const repoOwner = 'weeklyvillain'
    const repoName = 'cs2-demo-analyzer'
    const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases`
    
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CS2-Demo-Analyzer',
      },
    })
    
    if (!response.ok) {
      console.log(`[Update] GitHub API returned ${response.status}: ${response.statusText}`)
      return []
    }
    
    const releases = await response.json() as GitHubRelease[]
    const versions = releases
      .map(release => release.tag_name?.replace(/^v/, ''))
      .filter((version): version is string => version !== undefined && version !== null)
    
    return versions
  } catch (error) {
    console.error('[Update] Error fetching available versions:', error)
    return []
  }
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
  
  // Get app version - use manual version if set, otherwise use actual version
  const manualVersion = getSetting('manualVersion', '')
  const actualVersion = app.getVersion() || packageJson.version || '1.0.0'
  const version = manualVersion || actualVersion
  
  // Check for updates (only in production, skip in dev, and only if auto-update is enabled)
  let updateAvailable = false
  let updateVersion: string | null = null
  let updateReleaseUrl: string | null = null
  
  if (!isDev) {
    const autoUpdateEnabled = getSetting('autoUpdateEnabled', 'true') === 'true'
    if (autoUpdateEnabled) {
      const updateCheck = await checkForUpdates(version)
      updateAvailable = updateCheck.available
      updateVersion = updateCheck.version
      updateReleaseUrl = updateCheck.releaseUrl
    }
  }
  
  // Get storage info
  const appDataPath = app.getPath('userData')
  const matchesDir = path.join(appDataPath, 'matches')
  const settingsDbPath = path.join(appDataPath, 'settings.sqlite')
  
  let matchesStorageBytes = 0
  let settingsStorageBytes = 0
  let voiceCacheStorageBytes = 0
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
  
  // Calculate voice cache storage
  voiceCacheStorageBytes = calculateCacheSize()
  
  const totalStorageBytes = matchesStorageBytes + settingsStorageBytes + voiceCacheStorageBytes
  
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
      voiceCache: {
        bytes: voiceCacheStorageBytes,
        formatted: formatBytes(voiceCacheStorageBytes),
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

// Window control handlers for custom title bar
ipcMain.handle('window:minimize', () => {
  if (mainWindow) {
    mainWindow.minimize()
  }
})

ipcMain.handle('window:maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
})

ipcMain.handle('window:close', () => {
  if (mainWindow) {
    mainWindow.close()
  }
})

ipcMain.handle('window:isMaximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false
})

// Overlay IPC handlers
ipcMain.handle('overlay:getInteractive', () => {
  return overlayInteractive
})

ipcMain.handle('overlay:setInteractive', (_, value: boolean) => {
  setOverlayInteractiveState(value)
  return value
})

ipcMain.handle('overlay:create', () => {
  createOverlayWindow()
  return true
})

ipcMain.handle('overlay:close', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // Make overlay click-through before closing to avoid stealing focus
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    overlayWindow.setFocusable(false)
    // Small delay to ensure focus returns to CS2 before closing
    setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.close()
        overlayWindow = null
      }
    }, 100)
  }
  return true
})

ipcMain.handle('overlay:show', () => {
  const overlayEnabled = getSetting('overlayEnabled', 'false') !== 'false'
  if (!overlayEnabled) {
    console.log('[Overlay] Overlay is disabled in settings, cannot show')
    return false
  }
  
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.showInactive() // Use showInactive to prevent stealing focus
  } else {
    createOverlayWindow()
  }
  return true
})

ipcMain.handle('overlay:hide', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide()
  }
  return true
})

// Overlay hover IPC handlers
ipcMain.handle('overlay:hovered', async (_, hovered: boolean) => {
  await overlayHoverController.setHovered(hovered)
})

ipcMain.handle('overlay:getHovered', () => {
  return overlayHoverController.getHovered()
})

// Overlay action IPC handlers
ipcMain.handle('overlay:actions:viewOffender', async () => {
  if (!currentIncident) {
    return { success: false, error: 'No incident available' }
  }

  // Cancel any pending pause timer
  if (pauseTimerTimeout) {
    clearTimeout(pauseTimerTimeout)
    pauseTimerTimeout = null
    console.log('[overlay] Cancelled pending pause timer for viewOffender')
  }

  const { tick, offender } = currentIncident
  
  // Determine best identifier for spec_player
  let specTarget: string | null = null
  if (offender.userId !== undefined) {
    specTarget = offender.userId.toString()
  } else if (offender.entityIndex !== undefined) {
    specTarget = offender.entityIndex.toString()
  } else if (offender.name) {
    specTarget = `"${offender.name}"`
  } else {
    return { success: false, error: 'No valid identifier for offender' }
  }

  try {
    const commands: string[] = []
    
    // Pause demo first
    commands.push(`demo_pause`)
    
    // Calculate tick 5 seconds before the event (same as copy command button)
    const tickRate = 64 // Default tick rate
    const previewSeconds = 5
    const previewTicks = previewSeconds * tickRate
    const targetTick = tick > 0 ? Math.max(0, tick - previewTicks) : 0
    
    // Add tick jump if available
    if (targetTick > 0) {
      commands.push(`demo_gototick ${targetTick}`)
    }
    
    // Add spec command
    commands.push(`spec_player ${specTarget}`)
    
    // Send commands sequentially
    const netconPort = getSetting('cs2_netconport', '2121')
    if (!netconPort) {
      return { success: false, error: 'CS2 netconport not configured' }
    }

    await sendCS2CommandsSequentially(parseInt(netconPort), commands)
    
    // Resume demo playback after spectating (if autoplay is enabled)
    const autoplayAfterSpectate = getSetting('autoplayAfterSpectate', 'true') === 'true'
    if (autoplayAfterSpectate) {
      await sendCS2CommandsSequentially(parseInt(netconPort), ['demo_resume'])
      
      // Show success toast with "Playing event" when demo resumes
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('overlay:actionResult', { 
          success: true, 
          action: 'viewOffender',
          player: 'Playing event'
        })
      }
    } else {
      // If autoplay is disabled, just clear loading state
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('overlay:actionResult', { 
          success: true, 
          action: 'viewOffender',
          player: offender.name,
          clearLoadingOnly: true
        })
      }
    }
    
    // Schedule pause logic based on event type
    const isAfkEvent = currentIncident.eventType === 'AFK_STILLNESS'
    
    if (isAfkEvent) {
      // For AFK events, wait until the end of the AFK period + 5 extra seconds
      // We jumped to 5 seconds before the start, so we need to wait:
      // 5 seconds (to reach start) + AFK duration (to reach end) + 5 seconds (after end)
      let afkDurationSeconds = 5 // Default fallback
      
      if (currentIncident.meta) {
        // Try to get duration from metadata
        const meta = currentIncident.meta
        if (meta.seconds !== undefined) {
          afkDurationSeconds = meta.seconds
        } else if (meta.afkDuration !== undefined) {
          afkDurationSeconds = meta.afkDuration
        } else if (currentIncident.endTick && currentIncident.tick) {
          // Calculate from ticks if endTick is available
          const afkTicks = currentIncident.endTick - currentIncident.tick
          afkDurationSeconds = afkTicks / tickRate
        }
      } else if (currentIncident.endTick && currentIncident.tick) {
        // Fallback: calculate from ticks
        const afkTicks = currentIncident.endTick - currentIncident.tick
        afkDurationSeconds = afkTicks / tickRate
      }
      
      // Total wait time: 5 seconds (to reach start) + AFK duration (to reach end) + 5 seconds (after end)
      const totalWaitMs = (5 + afkDurationSeconds + 5) * 1000
      
      pauseTimerTimeout = setTimeout(async () => {
        try {
          await sendCS2CommandsSequentially(parseInt(netconPort), ['demo_pause'])
          
          // Notify overlay with "Event playback successful" message
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('overlay:actionResult', { 
              success: true, 
              action: 'viewOffender',
              player: 'Event playback successful'
            })
          }
        } catch (err) {
          console.error('[overlay] Failed to pause demo after AFK event:', err)
          // Still notify success even if pause fails
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('overlay:actionResult', { 
              success: true, 
              action: 'viewOffender',
              player: 'Event playback successful'
            })
          }
        } finally {
          pauseTimerTimeout = null // Clear timeout reference after execution
        }
      }, totalWaitMs)
    } else {
      // For non-AFK events, pause 5 seconds after the event tick
      // We jumped to 5 seconds before the event, so we need to wait:
      // 5 seconds (to reach the event) + 5 seconds (after the event) = 10 seconds total
      pauseTimerTimeout = setTimeout(async () => {
        try {
          await sendCS2CommandsSequentially(parseInt(netconPort), ['demo_pause'])
          
          // Notify overlay with "Event playback successful" message
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('overlay:actionResult', { 
              success: true, 
              action: 'viewOffender',
              player: 'Event playback successful'
            })
          }
        } catch (err) {
          console.error('[overlay] Failed to pause demo after event:', err)
          // Still notify success even if pause fails
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('overlay:actionResult', { 
              success: true, 
              action: 'viewOffender',
              player: 'Event playback successful'
            })
          }
        } finally {
          pauseTimerTimeout = null // Clear timeout reference after execution
        }
      }, 10000) // 10 seconds total (5 seconds to event + 5 seconds after event)
    }
    
    // Return success immediately (don't wait for the pause)
    return { success: true }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to spectate offender'
    console.error('[overlay] Failed to view offender:', errorMsg)
    
    // Notify overlay of error
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay:actionResult', { 
        success: false, 
        action: 'viewOffender',
        error: errorMsg 
      })
    }
    
    return { success: false, error: errorMsg }
  }
})

ipcMain.handle('overlay:actions:viewVictim', async () => {
  if (!currentIncident) {
    return { success: false, error: 'No incident available' }
  }

  // Cancel any pending pause timer
  if (pauseTimerTimeout) {
    clearTimeout(pauseTimerTimeout)
    pauseTimerTimeout = null
    console.log('[overlay] Cancelled pending pause timer for viewVictim')
  }

  const { tick, victim } = currentIncident
  
  // Determine best identifier for spec_player
  let specTarget: string | null = null
  if (victim.userId !== undefined) {
    specTarget = victim.userId.toString()
  } else if (victim.entityIndex !== undefined) {
    specTarget = victim.entityIndex.toString()
  } else if (victim.name) {
    specTarget = `"${victim.name}"`
  } else {
    return { success: false, error: 'No valid identifier for victim' }
  }

  try {
    const commands: string[] = []
    
    // Pause demo first
    commands.push(`demo_pause`)
    
    // Calculate tick 5 seconds before the event (same as copy command button)
    const tickRate = 64 // Default tick rate
    const previewSeconds = 5
    const previewTicks = previewSeconds * tickRate
    const targetTick = tick > 0 ? Math.max(0, tick - previewTicks) : 0
    
    // Add tick jump if available
    if (targetTick > 0) {
      commands.push(`demo_gototick ${targetTick}`)
    }
    
    // Add spec command
    commands.push(`spec_player ${specTarget}`)
    
    // Send commands sequentially
    const netconPort = getSetting('cs2_netconport', '2121')
    if (!netconPort) {
      return { success: false, error: 'CS2 netconport not configured' }
    }

    await sendCS2CommandsSequentially(parseInt(netconPort), commands)
    
    // Resume demo playback after spectating (if autoplay is enabled)
    const autoplayAfterSpectate = getSetting('autoplayAfterSpectate', 'true') === 'true'
    if (autoplayAfterSpectate) {
      await sendCS2CommandsSequentially(parseInt(netconPort), ['demo_resume'])
      
      // Show success toast with "Playing event" when demo resumes
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('overlay:actionResult', { 
          success: true, 
          action: 'viewVictim',
          player: 'Playing event'
        })
      }
    } else {
      // If autoplay is disabled, just clear loading state
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('overlay:actionResult', { 
          success: true, 
          action: 'viewVictim',
          player: victim.name,
          clearLoadingOnly: true
        })
      }
    }
    
    // Schedule pause logic based on event type
    const isAfkEvent = currentIncident.eventType === 'AFK_STILLNESS'
    
    if (isAfkEvent) {
      // For AFK events, wait until the end of the AFK period + 5 extra seconds
      // We jumped to 5 seconds before the start, so we need to wait:
      // 5 seconds (to reach start) + AFK duration (to reach end) + 5 seconds (after end)
      let afkDurationSeconds = 5 // Default fallback
      
      if (currentIncident.meta) {
        // Try to get duration from metadata
        const meta = currentIncident.meta
        if (meta.seconds !== undefined) {
          afkDurationSeconds = meta.seconds
        } else if (meta.afkDuration !== undefined) {
          afkDurationSeconds = meta.afkDuration
        } else if (currentIncident.endTick && currentIncident.tick) {
          // Calculate from ticks if endTick is available
          const afkTicks = currentIncident.endTick - currentIncident.tick
          afkDurationSeconds = afkTicks / tickRate
        }
      } else if (currentIncident.endTick && currentIncident.tick) {
        // Fallback: calculate from ticks
        const afkTicks = currentIncident.endTick - currentIncident.tick
        afkDurationSeconds = afkTicks / tickRate
      }
      
      // Total wait time: 5 seconds (to reach start) + AFK duration (to reach end) + 5 seconds (after end)
      const totalWaitMs = (5 + afkDurationSeconds + 5) * 1000
      
      pauseTimerTimeout = setTimeout(async () => {
        try {
          await sendCS2CommandsSequentially(parseInt(netconPort), ['demo_pause'])
          
          // Notify overlay with "Event playback successful" message
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('overlay:actionResult', { 
              success: true, 
              action: 'viewVictim',
              player: 'Event playback successful'
            })
          }
        } catch (err) {
          console.error('[overlay] Failed to pause demo after AFK event:', err)
          // Still notify success even if pause fails
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('overlay:actionResult', { 
              success: true, 
              action: 'viewVictim',
              player: 'Event playback successful'
            })
          }
        } finally {
          pauseTimerTimeout = null // Clear timeout reference after execution
        }
      }, totalWaitMs)
    } else {
      // For non-AFK events, pause 5 seconds after the event tick
      // We jumped to 5 seconds before the event, so we need to wait:
      // 5 seconds (to reach the event) + 5 seconds (after the event) = 10 seconds total
      pauseTimerTimeout = setTimeout(async () => {
        try {
          await sendCS2CommandsSequentially(parseInt(netconPort), ['demo_pause'])
          
          // Notify overlay with "Event playback successful" message
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('overlay:actionResult', { 
              success: true, 
              action: 'viewVictim',
              player: 'Event playback successful'
            })
          }
        } catch (err) {
          console.error('[overlay] Failed to pause demo after event:', err)
          // Still notify success even if pause fails
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('overlay:actionResult', { 
              success: true, 
              action: 'viewVictim',
              player: 'Event playback successful'
            })
          }
        } finally {
          pauseTimerTimeout = null // Clear timeout reference after execution
        }
      }, 10000) // 10 seconds total (5 seconds to event + 5 seconds after event)
    }
    
    // Return success immediately (don't wait for the pause)
    return { success: true }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to spectate victim'
    console.error('[overlay] Failed to view victim:', errorMsg)
    
    // Notify overlay of error
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay:actionResult', { 
        success: false, 
        action: 'viewVictim',
        error: errorMsg 
      })
    }
    
    return { success: false, error: errorMsg }
  }
})

// Function to send incident update to overlay
// Example usage:
// sendIncidentToOverlay({
//   tick: 12345,
//   offender: { name: 'Player1', steamId: '76561198012345678', userId: 1 },
//   victim: { name: 'Player2', steamId: '76561198087654321', userId: 2 }
// })
export function sendIncidentToOverlay(incident: {
  matchId?: string
  tick: number
  eventType?: string
  offender: { name: string; steamId?: string; userId?: number; entityIndex?: number }
  victim: { name: string; steamId?: string; userId?: number; entityIndex?: number }
  meta?: any
  endTick?: number | null
} | null) {
  currentIncident = incident
  
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // Wait for overlay window to be ready before sending
    if (overlayWindow.webContents.isLoading()) {
      overlayWindow.webContents.once('did-finish-load', () => {
        if (!overlayWindow || overlayWindow.isDestroyed()) return
        
        overlayWindow.webContents.send('overlay:incident', incident)
        console.log('[Overlay] Sent incident to overlay (after load):', incident ? `${incident.offender.name} -> ${incident.victim.name}` : 'cleared')
        
        // If incident is sent and overlay is not interactive, make it interactive so user can see the events list
        if (incident && !overlayInteractive) {
          overlayInteractive = true
          overlayWindow.setIgnoreMouseEvents(false, { forward: true })
          overlayWindow.setFocusable(false) // Don't make it focusable to avoid stealing focus from CS2
          updateOverlayOpacity(false) // Less opaque when interactive
          overlayWindow.webContents.send('overlay:interactiveChanged', true)
          // Update tracker with interactive state
          if (process.platform === 'win32') {
            cs2OverlayTracker.setOverlayInteractive(true)
          }
          // Ensure overlay is visible
          if (!overlayWindow.isVisible()) {
            overlayWindow.showInactive() // Use showInactive to not steal focus
          }
          console.log('[Overlay] Made overlay interactive to show events list')
        }
      })
    } else {
      overlayWindow.webContents.send('overlay:incident', incident)
      console.log('[Overlay] Sent incident to overlay:', incident ? `${incident.offender.name} -> ${incident.victim.name}` : 'cleared')
      
      // If incident is sent and overlay is not interactive, make it interactive so user can see the events list
      if (incident && !overlayInteractive) {
        overlayInteractive = true
        overlayWindow.setIgnoreMouseEvents(false, { forward: true })
        overlayWindow.setFocusable(false) // Don't make it focusable to avoid stealing focus from CS2
        updateOverlayOpacity(false) // Less opaque when interactive
        overlayWindow.webContents.send('overlay:interactiveChanged', true)
        // Ensure overlay is visible
        if (!overlayWindow.isVisible()) {
          overlayWindow.showInactive() // Use showInactive to not steal focus
        }
        console.log('[Overlay] Made overlay interactive to show events list')
      }
    }
  } else {
    console.warn('[Overlay] Overlay window not available, incident not sent')
  }
}

// IPC handler for sending incident to overlay
ipcMain.handle('overlay:sendIncident', async (_, incident: {
  matchId?: string
  tick: number
  eventType?: string
  offender: { name: string; steamId?: string; userId?: number; entityIndex?: number }
  victim: { name: string; steamId?: string; userId?: number; entityIndex?: number }
} | null) => {
  sendIncidentToOverlay(incident)
})

// Example function showing how to push incident updates to overlay
// This can be called from anywhere in the main process when an incident is detected
function exampleSendIncident() {
  sendIncidentToOverlay({
    tick: 12345,
    offender: {
      name: 'GrieferPlayer',
      steamId: '76561198012345678',
      userId: 1,
      entityIndex: 5
    },
    victim: {
      name: 'VictimPlayer',
      steamId: '76561198087654321',
      userId: 2,
      entityIndex: 10
    }
  })
}

// To clear the incident (hide the panel):
// sendIncidentToOverlay(null)

// Hotkey settings IPC handlers
ipcMain.handle('settings:getHotkey', () => {
  return getSetting('overlay_hotkey', 'CommandOrControl+Shift+O')
})

ipcMain.handle('settings:setHotkey', (_, accelerator: string) => {
  // Normalize arrow keys to Electron format
  let normalizedAccelerator = accelerator
  // Handle arrow keys in various formats
  normalizedAccelerator = normalizedAccelerator.replace(/ArrowUp/gi, 'Up')
  normalizedAccelerator = normalizedAccelerator.replace(/ArrowDown/gi, 'Down')
  normalizedAccelerator = normalizedAccelerator.replace(/ArrowLeft/gi, 'Left')
  normalizedAccelerator = normalizedAccelerator.replace(/ArrowRight/gi, 'Right')
  
  const oldHotkey = currentHotkey
  currentHotkey = normalizedAccelerator
  setSetting('overlay_hotkey', normalizedAccelerator)
  
  // Unregister old hotkey
  if (oldHotkey) {
    globalShortcut.unregister(oldHotkey)
  }
  
  // Register new hotkey with error handling
  let registered = false
  try {
    registered = globalShortcut.register(normalizedAccelerator, () => {
      // Create overlay window if it doesn't exist
      if (!overlayWindow || overlayWindow.isDestroyed()) {
        createOverlayWindow()
        // Wait a bit for window to be ready
        setTimeout(() => {
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            // Toggle show/hide instead of interactive state
            overlayExplicitlyShown = !overlayExplicitlyShown
            if (overlayExplicitlyShown) {
              overlayWindow.showInactive()
              // Notify tracker that overlay is explicitly shown
              if (process.platform === 'win32') {
                cs2OverlayTracker.setOverlayExplicitlyShown(true)
              }
            } else {
              overlayWindow.hide()
              // Notify tracker that overlay is explicitly hidden
              if (process.platform === 'win32') {
                cs2OverlayTracker.setOverlayExplicitlyShown(false)
              }
            }
          }
        }, 500)
      } else {
        // Toggle show/hide instead of interactive state
        overlayExplicitlyShown = !overlayExplicitlyShown
        if (overlayExplicitlyShown) {
          overlayWindow.showInactive()
          // Notify tracker that overlay is explicitly shown
          if (process.platform === 'win32') {
            cs2OverlayTracker.setOverlayExplicitlyShown(true)
          }
        } else {
          overlayWindow.hide()
          // Notify tracker that overlay is explicitly hidden
          if (process.platform === 'win32') {
            cs2OverlayTracker.setOverlayExplicitlyShown(false)
          }
        }
      }
    })
  } catch (error) {
    console.error(`Error registering hotkey: ${normalizedAccelerator} (original: ${accelerator})`, error)
    return { success: false, error: `Failed to register hotkey: ${normalizedAccelerator}. ${error instanceof Error ? error.message : String(error)}` }
  }
  
  if (!registered) {
    console.error(`Failed to register hotkey: ${normalizedAccelerator} (original: ${accelerator})`)
    return { success: false, error: `Failed to register hotkey: ${normalizedAccelerator}` }
  }
  
  return { success: true }
})

// Debug mode settings IPC handlers
ipcMain.handle('settings:getDebugMode', () => {
  return getSetting('debugMode', 'false') === 'true'
})

ipcMain.handle('settings:setDebugMode', (_, value: boolean) => {
  setSetting('debugMode', value ? 'true' : 'false')
  
  // If debug mode is enabled, send current command log to overlay
  if (value && overlayWindow && !overlayWindow.isDestroyed()) {
    sendCommandLogToOverlay()
  }
  
  return { success: true }
})

ipcMain.handle('settings:resetHotkey', async () => {
  const defaultHotkey = 'CommandOrControl+Shift+O'
  const oldHotkey = currentHotkey
  currentHotkey = defaultHotkey
  setSetting('overlay_hotkey', defaultHotkey)
  
  // Unregister old hotkey
  if (oldHotkey) {
    globalShortcut.unregister(oldHotkey)
  }
  
  // Register default hotkey
  const registered = globalShortcut.register(defaultHotkey, () => {
    // Create overlay window if it doesn't exist
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow()
      // Wait a bit for window to be ready
      setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          // Toggle show/hide instead of interactive state
          overlayExplicitlyShown = !overlayExplicitlyShown
          if (overlayExplicitlyShown) {
            overlayWindow.showInactive()
            // Notify tracker that overlay is explicitly shown
            if (process.platform === 'win32') {
              cs2OverlayTracker.setOverlayExplicitlyShown(true)
            }
          } else {
            overlayWindow.hide()
            // Notify tracker that overlay is explicitly hidden
            if (process.platform === 'win32') {
              cs2OverlayTracker.setOverlayExplicitlyShown(false)
            }
          }
        }
      }, 500)
    } else {
      // Toggle show/hide instead of interactive state
      overlayExplicitlyShown = !overlayExplicitlyShown
      if (overlayExplicitlyShown) {
        overlayWindow.showInactive()
        // Notify tracker that overlay is explicitly shown
        if (process.platform === 'win32') {
          cs2OverlayTracker.setOverlayExplicitlyShown(true)
        }
      } else {
        overlayWindow.hide()
        // Notify tracker that overlay is explicitly hidden
        if (process.platform === 'win32') {
          cs2OverlayTracker.setOverlayExplicitlyShown(false)
        }
      }
    }
  })
  
  if (!registered) {
    console.error(`Failed to register default hotkey: ${defaultHotkey}`)
    return { success: false, error: `Failed to register default hotkey: ${defaultHotkey}` }
  }
  
  return { success: true }
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

function isAkrosRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('tasklist /FI "IMAGENAME eq akros.exe"', (error, stdout) => {
        if (error) {
          resolve(false)
          return
        }
        resolve(stdout.toLowerCase().includes('akros.exe'))
      })
    } else {
      // For non-Windows, use ps command
      exec('ps aux | grep -i akros | grep -v grep', (error, stdout) => {
        resolve(!error && stdout.trim().length > 0)
      })
    }
  })
}

// CS2 Launch handler
ipcMain.handle('cs2:launch', async (_, demoPath: string, startTick?: number, playerName?: string, confirmLoadDemo?: boolean): Promise<{ success: boolean; tick: number; commands: string; alreadyRunning?: boolean; pid?: number; needsDemoLoad?: boolean; currentDemo?: string | null; newDemo?: string; error?: string }> => {
  // Check if Akros anti-cheat is running
  const akrosRunning = await isAkrosRunning()
  if (akrosRunning) {
    const errorMsg = 'Akros anti-cheat is running, close it before you can continue'
    console.error('[CS2]', errorMsg)
    
    return { 
      success: false, 
      tick: 0, 
      commands: '', 
      error: errorMsg 
    }
  }
  
  if (!fs.existsSync(demoPath)) {
    throw new Error(`Demo file not found: ${demoPath}`)
  }

  // Note: Overlay tracking will be started after CS2 is launched (see spawn section below)

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

  // Build console commands to send sequentially via netconport
  // When launching CS2: playdemo -> mat_setvideomode -> demo_pause -> demo_gototick -> spec_player
  // When CS2 already running: playdemo -> demo_pause -> demo_gototick -> spec_player
  const consoleCommands: string[] = []
  
  // Always load the demo first (whether CS2 is running or not)
  consoleCommands.push(`playdemo "${demoPath}"`)
  
  // If CS2 is not running, we need to set video mode
  if (!cs2Running) {
    // Add video mode command based on settings (only when starting CS2)
    // mat_setvideomode syntax: mat_setvideomode <width> <height> <fullscreen>
    // fullscreen: 0 = windowed, 1 = fullscreen
    const fullscreen = windowMode === 'fullscreen' ? '1' : '0'
    consoleCommands.push(`mat_setvideomode ${windowWidth} ${windowHeight} ${fullscreen}`)
  }
  
  // If we're jumping to a specific tick, pause first, then jump
  // If loading from start (targetTick === 0), don't pause - let it play automatically
  if (targetTick > 0) {
    consoleCommands.push(`demo_pause`) // Pause before jumping to tick
    consoleCommands.push(`demo_gototick ${targetTick}`) // Jump to tick
  }
  
  // Add spectate player command if playerName is provided
  if (playerName) {
    // spec_player takes the player's name, wrap in quotes if it contains spaces
    const playerNameQuoted = playerName.includes(' ') ? `"${playerName}"` : playerName
    consoleCommands.push(`spec_player ${playerNameQuoted}`) // Spectate the player
  }

  // For clipboard, join with semicolons (fallback if netconport fails)
  const commandsToCopy = consoleCommands.join('; ')
  
  // Copy console commands to clipboard (always available as fallback)
  clipboard.writeText(commandsToCopy)

  // Extract matchId from demo path (filename without extension)
  const matchId = path.basename(demoPath, path.extname(demoPath))
  
  // Ensure overlay window exists before sending incident
  if (process.platform === 'win32') {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow()
    }
    
    // Send incident to overlay with matchId so event list can be shown
    // Use placeholder offender/victim since we don't have specific event data yet
    // Delay slightly to ensure overlay window is ready
    setTimeout(() => {
      sendIncidentToOverlay({
        matchId: matchId,
        tick: targetTick || 0,
        offender: { name: 'Unknown' },
        victim: { name: 'Unknown' },
      })
    }, 1000) // Increased delay to ensure overlay window is fully loaded
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

  // If CS2 is already running, check if we need to load a different demo
  if (cs2Running) {
    console.log('=== CS2 Already Running ===')
    console.log('Demo Path:', demoPath)
    console.log('Start Tick:', startTick)
    console.log('Target Tick:', targetTick)
    console.log('Player Name:', playerName)
    console.log('Console Commands (copied to clipboard):', commandsToCopy)
    
    // Check if we're already playing the correct demo
    const netconPort = getSetting('cs2_netconport', '2121')
    const normalizedDemoPath = path.resolve(demoPath).replace(/\\/g, '/')
    const normalizedCurrentDemo = currentDemoPath ? path.resolve(currentDemoPath).replace(/\\/g, '/') : null
    
    // If we're already playing the same demo, skip loading it again
    if (normalizedCurrentDemo === normalizedDemoPath) {
      console.log('[CS2] Already playing the correct demo, skipping playdemo command')
      
      // Start overlay tracking for already-running CS2
      if (process.platform === 'win32') {
        // Ensure overlay window exists
        if (!overlayWindow || overlayWindow.isDestroyed()) {
          createOverlayWindow()
        }
        
        // Start tracking (will find CS2 by process name)
        setTimeout(async () => {
          try {
            if (overlayWindow && !overlayWindow.isDestroyed()) {
              await cs2OverlayTracker.startTrackingCs2ForDemo(overlayWindow, {
                processName: 'cs2.exe',
                windowTimeout: 15000,
                retryInterval: 200,
              })
            }
          } catch (err) {
            console.error('[Overlay] Failed to start tracking:', err)
          }
        }, 500) // Small delay to ensure overlay window is ready
      }
      
      // Send only the navigation commands (skip playdemo)
      const navigationCommands = consoleCommands.filter(cmd => !cmd.startsWith('playdemo'))
      const waitTime = 1000 // 1 second delay before sending commands
      
      setTimeout(async () => {
        try {
          if (navigationCommands.length > 0) {
            await sendCS2CommandsSequentially(parseInt(netconPort), navigationCommands)
          }
          console.log('[CS2] Navigation commands sent successfully')
          
          // Check if autoplay after spectate is enabled
          const autoplayAfterSpectate = getSetting('autoplayAfterSpectate', 'true') === 'true'
          if (autoplayAfterSpectate && playerName) {
            // Wait a bit for spec_player to complete, then resume playback
            setTimeout(async () => {
              try {
                await sendCS2CommandsSequentially(parseInt(netconPort), ['demo_resume'])
                console.log('[CS2] Demo playback resumed (autoplay after spectate)')
              } catch (err) {
                console.error('Failed to resume demo playback:', err)
              }
            }, 2000) // 2 second delay after spec_player
          }
        } catch (err) {
          console.error('Failed to send commands via netconport:', err)
          console.log('Commands are still available in clipboard:', commandsToCopy)
        }
      }, waitTime)
      
      return { success: true, tick: targetTick, commands: commandsToCopy, alreadyRunning: true, needsDemoLoad: false }
    }
    
    // Different demo - need to confirm with user (unless confirmLoadDemo is true)
    if (!confirmLoadDemo) {
      return { 
        success: false, 
        tick: targetTick, 
        commands: commandsToCopy, 
        alreadyRunning: true, 
        needsDemoLoad: true,
        currentDemo: currentDemoPath,
        newDemo: demoPath
      }
    }
    
    // User confirmed - proceed with loading new demo
    // Start overlay tracking for already-running CS2
    if (process.platform === 'win32') {
      // Ensure overlay window exists
      if (!overlayWindow || overlayWindow.isDestroyed()) {
        createOverlayWindow()
      }
      
      // Start tracking (will find CS2 by process name)
      setTimeout(async () => {
        try {
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            await cs2OverlayTracker.startTrackingCs2ForDemo(overlayWindow, {
              processName: 'cs2.exe',
              windowTimeout: 15000,
              retryInterval: 200,
            })
          }
        } catch (err) {
          console.error('[Overlay] Failed to start tracking:', err)
        }
      }, 500) // Small delay to ensure overlay window is ready
    }
    
    // Send commands via netconport
    // Split commands: first send playdemo and wait for it to load, then send other commands
    const waitTime = 1000 // 1 second delay before sending commands
    
    setTimeout(async () => {
      try {
        // First, send playdemo command and wait for demo to load
        await sendCS2CommandsSequentially(parseInt(netconPort), [`playdemo "${demoPath}"`])
        
        // Wait additional time for demo to fully load (demo loading can take time)
        console.log('[CS2] Waiting for demo to load...')
        await new Promise(resolve => setTimeout(resolve, 5000)) // Wait 5 seconds for demo to load
        
        // Now send the rest of the commands (pause, gototick, spec_player)
        const remainingCommands = consoleCommands.filter(cmd => !cmd.startsWith('playdemo'))
        if (remainingCommands.length > 0) {
          await sendCS2CommandsSequentially(parseInt(netconPort), remainingCommands)
        }
        
        // Check if autoplay after spectate is enabled
        const autoplayAfterSpectate = getSetting('autoplayAfterSpectate', 'true') === 'true'
        if (autoplayAfterSpectate && playerName) {
          // Wait a bit for spec_player to complete, then resume playback
          setTimeout(async () => {
            try {
              await sendCS2CommandsSequentially(parseInt(netconPort), ['demo_resume'])
              console.log('[CS2] Demo playback resumed (autoplay after spectate)')
            } catch (err) {
              console.error('Failed to resume demo playback:', err)
            }
          }, 2000) // 2 second delay after spec_player
        }
        
        // Update current demo path after successfully loading
        currentDemoPath = demoPath
        console.log('[CS2] All commands sent successfully')
      } catch (err) {
        console.error('Failed to send commands via netconport:', err)
        console.log('Commands are still available in clipboard:', commandsToCopy)
      }
    }, waitTime)
    
    console.log('Commands will be sent via netconport')
    console.log('========================')
    
    return { success: true, tick: targetTick, commands: commandsToCopy, alreadyRunning: true, needsDemoLoad: false }
  }

  // Build command line arguments for launching CS2
  // Use -netconport and -tools to send commands via TCP
  const args: string[] = []
  args.push(`-insecure`)
  args.push(`-novid`)
  //args.push(`-tools`)
  
    // Use netconport for sending commands via TCP
    // Default port 2121 (can be configured)
    const netconPort = getSetting('cs2_netconport', '2121')
    args.push(`-netconport`, netconPort)
    
    // Note: playdemo will be sent via netconport instead of as launch argument

  // Log the command for debugging
  const fullCommand = `"${cs2Exe}" ${args.map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ')}`
  console.log('=== CS2 Launch Command ===')
  console.log('CS2 Executable:', cs2Exe)
  console.log('Demo Path:', demoPath)
  console.log('Start Tick:', startTick)
  console.log('Target Tick:', targetTick)
  console.log('Player Name:', playerName)
  console.log('Netcon Port:', netconPort)
  console.log('Console Commands (will be sent via netconport):', commandsToCopy)
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
      env: {
        ...process.env,
        // Set process name via environment variable for identification
        PROCESS_NAME: 'CS2 (Launched by CS2 Demo Analyzer)',
      },
    })

    const cs2Pid = cs2Process.pid
    cs2Process.unref()
    
    // Start overlay tracking for CS2 window
    if (process.platform === 'win32' && cs2Pid) {
      // Ensure overlay window exists
      if (!overlayWindow || overlayWindow.isDestroyed()) {
        createOverlayWindow()
      }
      
      // Wait a bit for CS2 to initialize, then start tracking
      setTimeout(async () => {
        try {
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            await cs2OverlayTracker.startTrackingCs2ForDemo(overlayWindow, {
              pid: cs2Pid,
              processName: 'cs2.exe',
              windowTimeout: 15000,
              retryInterval: 200,
            })
          }
        } catch (err) {
          console.error('[Overlay] Failed to start tracking:', err)
        }
      }, 2000) // Wait 2 seconds for CS2 to start initializing
    }
    
    // Wait a bit for CS2 to start, then send commands via netconport sequentially
    // Need to wait longer for CS2 to fully initialize and be ready for netconport
    setTimeout(async () => {
      try {
        // First, send playdemo command and wait for demo to load
        await sendCS2CommandsSequentially(parseInt(netconPort), [`playdemo "${demoPath}"`])
        
        // Wait additional time for demo to fully load (demo loading can take time)
        console.log('[CS2] Waiting for demo to load...')
        await new Promise(resolve => setTimeout(resolve, 5000)) // Wait 5 seconds for demo to load
        
        // Now send the rest of the commands (mat_setvideomode, pause, gototick, spec_player)
        const remainingCommands = consoleCommands.filter(cmd => !cmd.startsWith('playdemo'))
        if (remainingCommands.length > 0) {
          await sendCS2CommandsSequentially(parseInt(netconPort), remainingCommands)
        }
        
        // Check if autoplay after spectate is enabled
        const autoplayAfterSpectate = getSetting('autoplayAfterSpectate', 'true') === 'true'
        if (autoplayAfterSpectate && playerName) {
          // Wait a bit for spec_player to complete, then resume playback
          setTimeout(async () => {
            try {
              await sendCS2CommandsSequentially(parseInt(netconPort), ['demo_resume'])
              console.log('[CS2] Demo playback resumed (autoplay after spectate)')
            } catch (err) {
              console.error('Failed to resume demo playback:', err)
            }
          }, 2000) // 2 second delay after spec_player
        }
        
        console.log('[CS2] All commands sent successfully')
      } catch (err) {
        console.error('Failed to send commands via netconport:', err)
        console.log('Commands are still available in clipboard:', commandsToCopy)
      }
    }, 3000) // Wait 3 seconds for CS2 to start
    
    return { success: true, tick: targetTick, commands: commandsToCopy, alreadyRunning: false, pid: cs2Pid }
  } catch (err) {
    throw new Error(`Failed to launch CS2: ${err instanceof Error ? err.message : String(err)}`)
  }
})

// Function to connect to CS2 netconport and send commands sequentially
async function sendCS2CommandsSequentially(port: number, commands: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let commandIndex = 0
    let connected = false
    
    const timeout = setTimeout(() => {
      if (!connected) {
        socket.destroy()
        reject(new Error('Connection timeout'))
      }
    }, 10000) // 10 second timeout
    
    socket.on('connect', () => {
      connected = true
      clearTimeout(timeout)
      console.log(`[netcon] Connected to CS2 on port ${port}`)
      
      // Start sending commands
      sendNextCommand()
    })
    
    socket.on('data', (buf) => {
      // Log response data for debugging
      const response = buf.toString('utf8')
      if (response.trim()) {
        console.log(`[netcon] Response:`, response)
      }
    })
    
    socket.on('error', (err) => {
      clearTimeout(timeout)
      console.error(`[netcon] Error:`, err)
      if (!connected) {
        reject(err)
      } else {
        // If we're already connected and get an error, try to continue
        // or resolve if we've sent all commands
        if (commandIndex >= commands.length) {
          resolve()
        }
      }
    })
    
    socket.on('close', () => {
      clearTimeout(timeout)
      console.log(`[netcon] Connection closed`)
      if (connected) {
        // If we've sent all commands, resolve successfully
        if (commandIndex >= commands.length) {
          resolve()
        } else {
          // Connection closed before all commands were sent
          reject(new Error('Connection closed before all commands were sent'))
        }
      }
    })
    
    const sendNextCommand = () => {
      if (commandIndex >= commands.length) {
        // All commands sent, close the socket
        socket.end()
        return
      }
      
      const command = commands[commandIndex]
      console.log(`[netcon] Sending command ${commandIndex + 1}/${commands.length}: ${command}`)
      
      // Log command if debug mode is enabled
      const debugMode = getSetting('debugMode', 'false') === 'true'
      if (debugMode) {
        pushCommand(command)
      }
      
      // netcon expects newline-terminated commands
      socket.write(command.trimEnd() + '\n', (err) => {
        if (err) {
          console.error(`[netcon] Failed to send command ${commandIndex + 1}:`, err)
          socket.destroy()
          reject(err)
          return
        }
        
        commandIndex++
        
        // Determine delay based on the command type
        let delay = 500 // Default delay
        if (commandIndex > 0) {
          const previousCommand = commands[commandIndex - 1]
          // If previous command was demo_gototick, wait longer for tick to load
          if (previousCommand.startsWith('demo_gototick')) {
            delay = 2000 // 2 seconds delay after demo_gototick
          }
          // If previous command was playdemo, wait longer for demo to load
          else if (previousCommand.startsWith('playdemo')) {
            delay = 3000 // 3 seconds delay after playdemo
            // Update current demo path when playdemo is sent
            const demoMatch = previousCommand.match(/playdemo\s+["']?([^"']+)["']?/i)
            if (demoMatch && demoMatch[1]) {
              currentDemoPath = demoMatch[1]
              console.log(`[CS2] Updated current demo path: ${currentDemoPath}`)
            }
          }
          // If previous command was demo_pause, shorter delay
          else if (previousCommand.startsWith('demo_pause')) {
            delay = 300 // 300ms delay after demo_pause
          }
        }
        
        // Wait a bit before sending next command (CS2 needs time to process)
        if (commandIndex < commands.length) {
          setTimeout(() => {
            sendNextCommand()
          }, delay)
        } else {
          // All commands sent, send updated log to overlay if debug mode is enabled
          const debugMode = getSetting('debugMode', 'false') === 'true'
          if (debugMode) {
            setTimeout(() => sendCommandLogToOverlay(), 100)
          }
          // Close socket
          setTimeout(() => {
            socket.end()
          }, 500)
        }
      })
    }
  })
}

// CS2 Copy Commands handler (generates and copies commands without launching)
ipcMain.handle('cs2:copyCommands', async (_, demoPath: string, startTick?: number, playerName?: string): Promise<{ success: boolean; commands: string; error?: string }> => {
  // Check if Akros anti-cheat is running
  const akrosRunning = await isAkrosRunning()
  if (akrosRunning) {
    const errorMsg = 'Akros anti-cheat is running, close it before you can continue'
    console.error('[CS2]', errorMsg)
    
    return { 
      success: false, 
      commands: '', 
      error: errorMsg 
    }
  }
  
  if (!fs.existsSync(demoPath)) {
    throw new Error(`Demo file not found: ${demoPath}`)
  }

  // Get window settings from settings
  const windowWidth = getSetting('cs2_window_width', '1920')
  const windowHeight = getSetting('cs2_window_height', '1080')
  const windowMode = getSetting('cs2_window_mode', 'windowed')

  // Calculate tick to start at (5 seconds before event, or at start if not specified)
  const tickRate = 64 // Default tick rate
  const previewSeconds = 5
  const previewTicks = previewSeconds * tickRate
  const targetTick = startTick ? Math.max(0, startTick - previewTicks) : 0

  // Extract matchId from demo path (filename without extension)
  const matchId = path.basename(demoPath, path.extname(demoPath))
  
  // Send incident to overlay with matchId so event list can be shown
  // Use placeholder offender/victim since we don't have specific event data yet
  sendIncidentToOverlay({
    matchId: matchId,
    tick: targetTick || 0,
    offender: { name: 'Unknown' },
    victim: { name: 'Unknown' },
  })

  // Start overlay tracking when copying commands (CS2 might already be running)
  if (process.platform === 'win32') {
    // Ensure overlay window exists
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow()
    }
    
    // Start tracking (will find CS2 by process name)
    setTimeout(async () => {
      try {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          await cs2OverlayTracker.startTrackingCs2ForDemo(overlayWindow, {
            processName: 'cs2.exe',
            windowTimeout: 15000,
            retryInterval: 200,
          })
        }
      } catch (err) {
        console.error('[Overlay] Failed to start tracking:', err)
      }
    }, 500) // Small delay to ensure overlay window is ready
  }

  // Build console commands to send sequentially via netconport
  // When CS2 already running: demo_pause -> demo_gototick -> spec_player
  // (mat_setvideomode is only sent when starting CS2, not when jumping to players)
  const consoleCommands: string[] = []
  
  // First, pause the demo to ensure we can jump to tick
  consoleCommands.push(`demo_pause`)
  
  if (targetTick > 0) {
    consoleCommands.push(`demo_gototick ${targetTick}`) // Jump to tick
  }
  
  // Add spectate player command if playerName is provided
  if (playerName) {
    // spec_player takes the player's name, wrap in quotes if it contains spaces
    const playerNameQuoted = playerName.includes(' ') ? `"${playerName}"` : playerName
    consoleCommands.push(`spec_player ${playerNameQuoted}`) // Spectate the player
  }

  // For clipboard, join with semicolons (fallback if netconport fails)
  const commandsToCopy = consoleCommands.join('; ')
  
  // Copy console commands to clipboard
  clipboard.writeText(commandsToCopy)

  // If CS2 is already running, send commands sequentially via netconport
  const cs2Running = await isCS2Running()
  if (cs2Running) {
    const netconPort = getSetting('cs2_netconport', '2121')
    sendCS2CommandsSequentially(parseInt(netconPort), consoleCommands).catch(err => {
      console.error('Failed to send commands via netconport:', err)
      console.log('Commands are still available in clipboard:', commandsToCopy)
    })
  }

  return { success: true, commands: commandsToCopy }
})

// Voice extraction cache helpers
function getVoiceCacheDir(): string {
  // Use temp directory so cache resets between restarts
  const tempDir = app.getPath('temp')
  const cacheDir = path.join(tempDir, 'cs2-voice-cache')
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
  }
  return cacheDir
}

function generateCacheKey(demoPath: string, steamId: string, mode: string): string {
  // Create a hash from demo path, steam ID, and mode
  // Use full demo path to ensure uniqueness even if files have the same name
  const normalizedDemoPath = path.resolve(demoPath).toLowerCase()
  const keyString = `${normalizedDemoPath}-${steamId}-${mode}`
  // Create a safe filename from the key using MD5 hash
  const hash = crypto.createHash('md5').update(keyString).digest('hex')
  return hash
}

function getCachedVoiceFiles(cacheKey: string): { files: string[]; filePaths: string[]; cachePath: string } | null {
  const cacheDir = getVoiceCacheDir()
  const cacheEntryDir = path.join(cacheDir, cacheKey)
  
  if (!fs.existsSync(cacheEntryDir)) {
    return null
  }
  
  // Check if cache directory has .wav files
  const files = fs.readdirSync(cacheEntryDir)
    .filter(file => file.endsWith('.wav'))
    .map(file => ({
      name: file,
      path: path.join(cacheEntryDir, file),
    }))
  
  if (files.length === 0) {
    return null
  }
  
  // Verify all files exist and are readable
  const validFiles = files.filter(f => {
    try {
      return fs.existsSync(f.path) && fs.statSync(f.path).size > 0
    } catch {
      return false
    }
  })
  
  if (validFiles.length === 0) {
    return null
  }
  
  return {
    files: validFiles.map(f => f.name),
    filePaths: validFiles.map(f => f.path),
    cachePath: cacheEntryDir,
  }
}

// Get cache size limit from settings (default 50MB)
function getCacheSizeLimit(): number {
  const limitMB = parseInt(getSetting('voiceCacheSizeLimitMB', '50'), 10)
  return limitMB * 1024 * 1024 // Convert to bytes
}

// Calculate total cache size
function calculateCacheSize(): number {
  const cacheDir = getVoiceCacheDir()
  if (!fs.existsSync(cacheDir)) {
    return 0
  }
  
  let totalSize = 0
  
  function calculateDirSize(dirPath: string): void {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        try {
          if (entry.isDirectory()) {
            calculateDirSize(fullPath)
          } else if (entry.isFile()) {
            const stats = fs.statSync(fullPath)
            totalSize += stats.size
          }
        } catch (err) {
          // Skip files/dirs that can't be accessed
          console.warn(`[Voice Cache] Could not access: ${fullPath}`, err)
        }
      }
    } catch (err) {
      console.warn(`[Voice Cache] Could not read directory: ${dirPath}`, err)
    }
  }
  
  calculateDirSize(cacheDir)
  return totalSize
}

// Get all cache files with their sizes and modification times
interface CacheFile {
  path: string
  size: number
  mtime: number
}

function getAllCacheFiles(): CacheFile[] {
  const cacheDir = getVoiceCacheDir()
  if (!fs.existsSync(cacheDir)) {
    return []
  }
  
  const files: CacheFile[] = []
  
  function collectFiles(dirPath: string): void {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        try {
          if (entry.isDirectory()) {
            collectFiles(fullPath)
          } else if (entry.isFile()) {
            const stats = fs.statSync(fullPath)
            files.push({
              path: fullPath,
              size: stats.size,
              mtime: stats.mtime.getTime(),
            })
          }
        } catch (err) {
          // Skip files/dirs that can't be accessed
          console.warn(`[Voice Cache] Could not access: ${fullPath}`, err)
        }
      }
    } catch (err) {
      console.warn(`[Voice Cache] Could not read directory: ${dirPath}`, err)
    }
  }
  
  collectFiles(cacheDir)
  return files
}

// Clean up old cache files when limit is exceeded
function cleanupCacheIfNeeded(): void {
  const limit = getCacheSizeLimit()
  let currentSize = calculateCacheSize()
  
  if (currentSize <= limit) {
    return // No cleanup needed
  }
  
  console.log(`[Voice Cache] Cache size (${(currentSize / 1024 / 1024).toFixed(2)}MB) exceeds limit (${(limit / 1024 / 1024).toFixed(2)}MB), cleaning up...`)
  
  // Get all files sorted by modification time (oldest first)
  const files = getAllCacheFiles().sort((a, b) => a.mtime - b.mtime)
  
  let deletedSize = 0
  let deletedCount = 0
  
  // Delete oldest files until we're under the limit
  for (const file of files) {
    if (currentSize - deletedSize <= limit) {
      break // We're under the limit now
    }
    
    try {
      fs.unlinkSync(file.path)
      deletedSize += file.size
      deletedCount++
    } catch (err) {
      console.warn(`[Voice Cache] Could not delete file: ${file.path}`, err)
    }
  }
  
  // Try to remove empty directories
  const cacheDir = getVoiceCacheDir()
  try {
    const entries = fs.readdirSync(cacheDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = path.join(cacheDir, entry.name)
        try {
          const dirEntries = fs.readdirSync(dirPath)
          if (dirEntries.length === 0) {
            fs.rmdirSync(dirPath)
          }
        } catch (err) {
          // Directory might not be empty or might have subdirectories, skip
        }
      }
    }
  } catch (err) {
    // Ignore errors when cleaning up directories
  }
  
  console.log(`[Voice Cache] Cleaned up ${deletedCount} file(s), freed ${(deletedSize / 1024 / 1024).toFixed(2)}MB`)
}

function saveToCache(cacheKey: string, sourceFiles: string[]): void {
  const cacheDir = getVoiceCacheDir()
  const cacheEntryDir = path.join(cacheDir, cacheKey)
  
  // Create cache entry directory
  if (!fs.existsSync(cacheEntryDir)) {
    fs.mkdirSync(cacheEntryDir, { recursive: true })
  }
  
  // Copy files to cache
  for (const sourceFile of sourceFiles) {
    if (fs.existsSync(sourceFile)) {
      const fileName = path.basename(sourceFile)
      const destPath = path.join(cacheEntryDir, fileName)
      
      // Only copy if it doesn't already exist (avoid unnecessary I/O)
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(sourceFile, destPath)
      }
    }
  }
  
  console.log(`[Voice Cache] Saved ${sourceFiles.length} file(s) to cache: ${cacheKey}`)
  
  // Clean up cache if it exceeds the size limit
  cleanupCacheIfNeeded()
}

// Voice extraction IPC handler
ipcMain.handle('voice:extract', async (_, options: { demoPath: string; outputPath?: string; mode?: 'split-compact' | 'split-full' | 'single-full'; steamIds?: string[] }) => {
  const { demoPath, mode = 'split-compact', steamIds = [] } = options
  
  // Validate demo file exists
  if (!fs.existsSync(demoPath)) {
    throw new Error(`Demo file not found: ${demoPath}`)
  }
  
  // Check cache if extracting for a single player
  if (steamIds.length === 1) {
    const cacheKey = generateCacheKey(demoPath, steamIds[0], mode)
    const cached = getCachedVoiceFiles(cacheKey)
    
    if (cached && cached.files.length > 0) {
      console.log(`[Voice Cache] Cache hit for ${steamIds[0]} in ${path.basename(demoPath)} (mode: ${mode})`)
      
      // Notify renderer process that we're using cache
      if (mainWindow) {
        mainWindow.webContents.send('voice:extractionLog', `[Cache] Using cached voice files (${cached.files.length} file(s))`)
      }
      
      return {
        success: true,
        outputPath: cached.cachePath,
        files: cached.files,
        filePaths: cached.filePaths,
      }
    } else {
      console.log(`[Voice Cache] Cache miss for ${steamIds[0]} in ${path.basename(demoPath)} (mode: ${mode})`)
    }
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
    
    // Kill any existing extractor process before starting a new one
    if (extractorProcess) {
      console.log('[Voice Extraction] Killing existing extractor process')
      extractorProcess.kill('SIGTERM')
      extractorProcess = null
    }
    
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
          // Set process name via environment variable for identification
          PROCESS_NAME: 'CS2 Voice Extractor',
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
          // Set process name via environment variable for identification
          PROCESS_NAME: 'CS2 Voice Extractor',
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
      // Clear the process reference
      extractorProcess = null
      
      if (code === 0) {
        // List extracted files with full paths
        const files = fs.readdirSync(outputPath)
          .filter(file => file.endsWith('.wav'))
          .map(file => ({
            name: file,
            path: path.join(outputPath, file),
          }))
        console.log(`[Voice Extraction] Completed successfully. Extracted ${files.length} file(s).`)
        
        // Save to cache if extracting for a single player
        if (steamIds.length === 1) {
          try {
            const cacheKey = generateCacheKey(demoPath, steamIds[0], mode)
            saveToCache(cacheKey, files.map(f => f.path))
            
            // Notify renderer process
            if (mainWindow) {
              mainWindow.webContents.send('voice:extractionLog', `[Cache] Saved to cache for future use`)
            }
          } catch (cacheError) {
            console.error(`[Voice Cache] Failed to save to cache:`, cacheError)
            // Don't fail the extraction if caching fails
          }
        }
        
        // Track voice extraction stats (use file count and assume ~60 seconds per extracted file as estimate)
        const estimatedDurationMs = files.length * 60000
        trackVoiceExtracted(estimatedDurationMs, files.length)
        
        // Track voice extraction (legacy counter)
        incrementStat('total_voices_extracted', files.length)
        
        resolve({ success: true, outputPath, files: files.map(f => f.name), filePaths: files.map(f => f.path) })
      } else {
        console.error(`[Voice Extraction] Process exited with code ${code}`)
        console.error(`[Voice Extraction] stderr: ${stderr}`)
        reject(new Error(`Voice extraction failed with exit code ${code}. ${stderr || stdout}`))
      }
    })
    
    extractorProcess.on('error', (error) => {
      // Clear the process reference on error
      extractorProcess = null
      console.error(`[Voice Extraction] Process error:`, error)
      reject(new Error(`Failed to start voice extractor: ${error.message}`))
    })
  })
})

// Helper function to read PNG dimensions from buffer
function getPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  try {
    // PNG signature check
    const signature = [137, 80, 78, 71, 13, 10, 26, 10]
    for (let i = 0; i < signature.length; i++) {
      if (buffer[i] !== signature[i]) {
        return null
      }
    }
    // PNG width is at offset 16 (4 bytes), height at offset 20 (4 bytes), both big-endian
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    return { width, height }
  } catch {
    return null
  }
}

// Voice waveform generation IPC handler - generate waveform PNG using audiowaveform
ipcMain.handle('voice:generateWaveform', async (_, filePath: string, audioDuration?: number, options?: { mode?: 'fixed' | 'wide'; pixelsPerSecond?: number; maxWidth?: number }) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'Audio file not found' }
    }

    const audiowaveformPath = getAudiowaveformPath()
    if (!fs.existsSync(audiowaveformPath)) {
      return { success: false, error: `audiowaveform not found at: ${audiowaveformPath}` }
    }

    // Use temp directory for waveform cache (same as voice cache)
    const cacheDir = getVoiceCacheDir()
    const waveformDir = path.join(cacheDir, 'waveforms')
    if (!fs.existsSync(waveformDir)) {
      fs.mkdirSync(waveformDir, { recursive: true })
    }

    // Generate unique filename based on audio file content hash
    // This ensures each unique audio file gets its own waveform
    const fileBuffer = fs.readFileSync(filePath)
    const audioHash = crypto.createHash('sha256').update(fileBuffer).digest('hex').substring(0, 32)
    const waveformPath = path.join(waveformDir, `waveform-${audioHash}.png`)

    const defaultWidth = 600
    
    // Calculate pixels-per-second dynamically to ensure waveform is always exactly 600px wide
    // This must be calculated based on audio duration and target width
    const audioDurationNumber = typeof audioDuration === 'string' ? parseFloat(audioDuration) : audioDuration
    if (audioDurationNumber === undefined || !Number.isFinite(audioDurationNumber) || audioDurationNumber <= 0) {
      return { success: false, error: 'Audio duration is required to generate waveform with fixed width' }
    }

    const mode = options?.mode || 'fixed'
    const pixelsPerSecondSetting = options?.pixelsPerSecond && options.pixelsPerSecond > 0 ? options.pixelsPerSecond : 4
    const maxWidth = options?.maxWidth && options.maxWidth > 0 ? options.maxWidth : 20000

    let targetWidth = defaultWidth
    let rawPixelsPerSecond = targetWidth / audioDurationNumber

    if (mode === 'wide') {
      targetWidth = Math.max(defaultWidth, Math.round(audioDurationNumber * pixelsPerSecondSetting))
      targetWidth = Math.min(targetWidth, maxWidth)
      rawPixelsPerSecond = targetWidth / audioDurationNumber
    }

    if (!Number.isFinite(rawPixelsPerSecond) || rawPixelsPerSecond <= 0) {
      return { success: false, error: 'Invalid pixels-per-second calculation' }
    }
    const pixelsPerSecond = Math.max(1, Math.ceil(rawPixelsPerSecond))

    // Check if waveform already exists (cache)
    // Note: We still use cached waveforms, but always calculate pixelsPerSecond based on targetWidth
    if (fs.existsSync(waveformPath)) {
      const imageBuffer = fs.readFileSync(waveformPath)
      const base64 = imageBuffer.toString('base64')
      
      // Always use targetWidth for pixelsPerSecond calculation, regardless of cached image size
      // This ensures consistent behavior even if old cached waveforms have different dimensions
      
      return { 
        success: true, 
        data: `data:image/png;base64,${base64}`,
        pixelsPerSecond,
        actualWidth: targetWidth, // Always report targetWidth as actualWidth for consistency
      }
    }

    // Build audiowaveform command
    // Colors: background #282b30, waveform #d07a2d, progress will be overlaid in React
    // Using bars style for better visual appeal
    // Calculate pixels-per-second dynamically to ensure waveform is always exactly 600px
    const args: string[] = [
      '-i', filePath,
      '-o', waveformPath,
      '-w', targetWidth.toString(),   // Fixed width (wide for team waveform)
      '-h', '150',   // Fixed height for consistent display
      '--waveform-style', 'bars',
      '--bar-width', '2',   // Slightly thinner bars for higher resolution
      '--bar-gap', '1',
      '--bar-style', 'rounded',
      '--background-color', '282b30',  // Dark background matching theme
      '--waveform-color', 'd07a2d',    // Orange waveform matching accent
      '--no-axis-labels',              // No axis labels for cleaner look
      '--amplitude-scale', '1.8',       // Lower fixed scale to preserve volume relationships
      // Dynamic pixels-per-second ensures waveform is always exactly 600px regardless of duration
    ]

    if (mode === 'fixed') {
      args.push('--pixels-per-second', pixelsPerSecond.toString())
    }

    return new Promise<{ success: boolean; data?: string; error?: string; pixelsPerSecond?: number; actualWidth?: number }>((resolve) => {
      // Kill any existing audiowaveform process before starting a new one
      if (audiowaveformProcess) {
        console.log('[Waveform] Killing existing audiowaveform process')
        audiowaveformProcess.kill('SIGTERM')
        audiowaveformProcess = null
      }
      
      audiowaveformProcess = spawn(audiowaveformPath, args, {
        cwd: path.dirname(audiowaveformPath),
        windowsHide: true,
        env: {
          ...process.env,
          // Set process name via environment variable for identification
          PROCESS_NAME: 'CS2 Audio Waveform Generator',
        },
      })

      let stderr = ''

      audiowaveformProcess.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      audiowaveformProcess.on('close', (code) => {
        // Clear the process reference
        const processRef = audiowaveformProcess
        audiowaveformProcess = null
        
        if (code === 0 && fs.existsSync(waveformPath)) {
          try {
            const imageBuffer = fs.readFileSync(waveformPath)
            const base64 = imageBuffer.toString('base64')
            
            // Verify the generated waveform is the correct width
            // Always use targetWidth for pixelsPerSecond calculation to ensure consistency
            const dimensions = getPngDimensions(imageBuffer)
            if (dimensions && dimensions.width !== targetWidth) {
              console.warn(`[Waveform] Generated waveform width (${dimensions.width}px) does not match target (${targetWidth}px)`)
            }
            
            resolve({ 
              success: true, 
              data: `data:image/png;base64,${base64}`,
              pixelsPerSecond, // Already calculated based on targetWidth and audioDuration
              actualWidth: targetWidth, // Always report targetWidth for consistency
            })
          } catch (error) {
            resolve({ success: false, error: `Failed to read waveform: ${error instanceof Error ? error.message : String(error)}` })
          }
        } else {
          resolve({ success: false, error: `audiowaveform failed with code ${code}: ${stderr}` })
        }
      })

      audiowaveformProcess.on('error', (error) => {
        // Clear the process reference on error
        audiowaveformProcess = null
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
