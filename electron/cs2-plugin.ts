import * as path from 'path'
import * as fs from 'fs'

/**
 * Check if CS Demo Analyzer's server plugin is installed for CS2
 */
export function isCS2PluginInstalled(cs2ExePath: string): boolean {
  try {
    // CS2 plugin is installed at: <csgo_folder>/game/csgo/csdm/bin/win64/server.dll (Windows)
    // or <csgo_folder>/game/csgo/csdm/bin/linuxsteamrt64/libserver.so (Linux)
    const csgoFolderPath = getCsgoFolderFromExe(cs2ExePath)
    if (!csgoFolderPath) {
      return false
    }

    const isWindows = process.platform === 'win32'
    const pluginPath = isWindows
      ? path.join(csgoFolderPath, 'game', 'csgo', 'csdm', 'bin', 'win64', 'server.dll')
      : path.join(csgoFolderPath, 'game', 'csgo', 'csdm', 'bin', 'linuxsteamrt64', 'libserver.so')

    return fs.existsSync(pluginPath)
  } catch {
    return false
  }
}

/**
 * Get CSGO folder path from CS2 executable path
 */
function getCsgoFolderFromExe(exePath: string): string | null {
  try {
    // CS2 exe is at: <csgo_folder>/game/bin/win64/cs2.exe (Windows)
    // or <csgo_folder>/game/cs2.sh (Linux)
    const exeDir = path.dirname(exePath)
    
    if (process.platform === 'win32') {
      // Go up 3 levels: bin/win64 -> bin -> game -> csgo folder
      return path.join(exeDir, '..', '..', '..')
    } else {
      // Go up 1 level: game -> csgo folder
      return path.join(exeDir, '..')
    }
  } catch {
    return null
  }
}

/**
 * Get the path where the plugin should be installed
 */
export function getPluginInstallPath(cs2ExePath: string): { pluginDir: string; binaryPath: string } | null {
  try {
    const csgoFolderPath = getCsgoFolderFromExe(cs2ExePath)
    if (!csgoFolderPath) {
      return null
    }

    const isWindows = process.platform === 'win32'
    const pluginDir = path.join(csgoFolderPath, 'game', 'csgo', 'csdm', 'bin')
    const binaryPath = isWindows
      ? path.join(pluginDir, 'win64', 'server.dll')
      : path.join(pluginDir, 'linuxsteamrt64', 'libserver.so')

    return { pluginDir, binaryPath }
  } catch {
    return null
  }
}

/**
 * Check if gameinfo.gi has been modified to load the plugin
 */
export function isGameInfoModified(cs2ExePath: string): boolean {
  try {
    const csgoFolderPath = getCsgoFolderFromExe(cs2ExePath)
    if (!csgoFolderPath) {
      return false
    }

    const gameInfoPath = path.join(csgoFolderPath, 'game', 'csgo', 'gameinfo.gi')
    if (!fs.existsSync(gameInfoPath)) {
      return false
    }

    const content = fs.readFileSync(gameInfoPath, 'utf8')
    return content.includes('Game\tcsgo/csdm')
  } catch {
    return false
  }
}
