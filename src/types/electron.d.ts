export interface ElectronAPI {
  deleteDemo: (demoPath: string | null, deleteFile: boolean) => Promise<void>
  openFileDialog: (allowMultiple?: boolean) => Promise<string | null | string[]>
  parseDemo: (args: { demoPath: string }) => Promise<{ matchId: string; dbPath: string }>
  stopParser: () => Promise<void>
  listMatches: () => Promise<Array<{ id: string; map: string; startedAt: string | null; playerCount: number; demoPath: string | null; isMissingDemo?: boolean; createdAtIso?: string | null }>>
  getMatchSummary: (matchId: string) => Promise<{ matchId: string; players: any[] }>
  getMatchPlayers: (matchId: string) => Promise<{ matchId: string; players: Array<{ steamId: string; name: string }> }>
  getMatchEvents: (matchId: string, filters?: { type?: string; steamid?: string; round?: number }) => Promise<any>
  getMatchRounds: (matchId: string) => Promise<any>
  getMatchChat: (matchId: string, steamid?: string) => Promise<{ matchId: string; messages: Array<{ matchId: string; roundIndex: number; tick: number; steamid: string; name: string; team: string | null; message: string; isTeamChat: boolean }> }>
  getMatchPositions: (matchId: string, roundIndex: number, tick: number) => Promise<{ matchId: string; roundIndex: number; tick: number; positions: Array<{ tick: number; steamid: string; x: number; y: number; z: number; team: string | null; name: string | null }> }>
  getMatchPositionsForRound: (matchId: string, roundIndex: number) => Promise<{ matchId: string; roundIndex: number; positions: Array<{ tick: number; steamid: string; x: number; y: number; z: number; team: string | null; name: string | null }> }>
  getGrenadePositionsForRound: (matchId: string, roundIndex: number) => Promise<{ matchId: string; roundIndex: number; positions: Array<{ tick: number; projectileId: number; grenadeName: string; x: number; y: number; z: number; throwerSteamId: string | null; throwerName: string | null; throwerTeam: string | null }> }>
  getGrenadeEventsForRound: (matchId: string, roundIndex: number) => Promise<{ matchId: string; roundIndex: number; events: Array<{ tick: number; eventType: string; projectileId: number; grenadeName: string; x: number; y: number; z: number; throwerSteamId: string | null; throwerName: string | null; throwerTeam: string | null }> }>
  getRadarImage: (mapName: string) => Promise<{ success: boolean; data?: string; error?: string }>
  deleteMatches: (matchIds: string[]) => Promise<{ deleted: number }>
  deleteAllMatches: () => Promise<{ deleted: number }>
  trimMatchesToCap: (cap: number) => Promise<{ deleted: Array<{ matchId: string; reason: string }> }>
  listTables: (matchId: string) => Promise<string[]>
  getTableInfo: (matchId: string, tableName: string) => Promise<{ name: string; rowCount: number; schema: string }>
  runQuery: (matchId: string, sql: string) => Promise<{ columns: string[]; rows: any[][] }>
  launchCS2: (demoPath: string, startTick?: number, playerName?: string) => Promise<{ success: boolean; tick: number; commands: string; alreadyRunning?: boolean }>
  copyCS2Commands: (demoPath: string, startTick?: number, playerName?: string) => Promise<{ success: boolean; commands: string }>
  getSetting: (key: string, defaultValue?: string) => Promise<string>
  setSetting: (key: string, value: string) => Promise<{ success: boolean }>
  getAllSettings: () => Promise<Record<string, string>>
  getAppInfo: () => Promise<{
    version: string
    platform: string
    arch: string
    osVersion: string
    electronVersion: string
    chromeVersion: string
    nodeVersion: string
    storage: {
      matches: { bytes: number; formatted: string; count: number }
      settings: { bytes: number; formatted: string }
      total: { bytes: number; formatted: string }
    }
    updateAvailable: boolean
    updateVersion: string | null
    updateReleaseUrl: string | null
  }>
  openExternal: (url: string) => Promise<void>
  showFileInFolder: (filePath: string) => Promise<void>
  extractVoice: (options: { demoPath: string; outputPath?: string; mode?: 'split-compact' | 'split-full' | 'single-full'; steamIds?: string[] }) => Promise<{ success: boolean; outputPath: string; files: string[]; filePaths?: string[] }>
  getVoiceAudio: (filePath: string) => Promise<{ success: boolean; data?: string; error?: string }>
  cleanupVoiceFiles: (outputPath: string) => Promise<{ success: boolean; error?: string }>
  onParserMessage: (callback: (message: string) => void) => void
  onParserLog: (callback: (log: string) => void) => void
  onParserExit: (callback: (data: { code: number | null; signal: string | null }) => void) => void
  onParserError: (callback: (error: string) => void) => void
  onMatchesCleanup: (callback: (data: { deleted: number; details: Array<{ matchId: string; reason: string }> }) => void) => void
  onMatchesTrimmed: (callback: (data: { deleted: number; details: Array<{ matchId: string; reason: string }> }) => void) => void
  onVoiceExtractionLog: (callback: (log: string) => void) => void
  removeAllListeners: (channel: string) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

