import { useState, useEffect } from 'react'
import Modal from './Modal'
import WhatsNewModal from './WhatsNewModal'
import OverlayHotkeySettings from './OverlayHotkeySettings'
import { RefreshCw } from 'lucide-react'

interface Settings {
  cs2_path: string
  cs2_window_width: string
  cs2_window_height: string
  cs2_window_mode: string
  auto_cleanup_missing_demos: string
  match_cap_enabled: string
  match_cap_value: string
  enable_db_viewer: string
  default_afk_threshold: string
  default_flash_threshold: string
  default_sort_field: string
  default_sort_direction: string
  voice_skip_time: string
  position_extraction_interval: string
  ram_only_parsing: string
  voiceCacheSizeLimitMB: string
  autoUpdateEnabled: string
  manualVersion: string
  debugMode: string
  overlayEnabled: string
  autoplayAfterSpectate: string
}

function SettingsScreen() {
  const [settings, setSettings] = useState<Settings>({
    cs2_path: '',
    cs2_window_width: '1920',
    cs2_window_height: '1080',
    cs2_window_mode: 'windowed',
    auto_cleanup_missing_demos: 'true',
    match_cap_enabled: 'false',
    match_cap_value: '10',
    enable_db_viewer: 'false',
    default_afk_threshold: '10',
    default_flash_threshold: '1.5',
    default_sort_field: 'date',
    default_sort_direction: 'desc',
    voice_skip_time: '10',
    position_extraction_interval: '4',
    ram_only_parsing: 'false',
    voiceCacheSizeLimitMB: '50',
    autoUpdateEnabled: 'true',
    manualVersion: '',
    debugMode: 'false',
    overlayEnabled: 'false',
    autoplayAfterSpectate: 'true',
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showWhatsNew, setShowWhatsNew] = useState(false)
  const [availableVersions, setAvailableVersions] = useState<string[]>([])
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [installingVersion, setInstallingVersion] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [appInfo, setAppInfo] = useState<{
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
      voiceCache?: { bytes: number; formatted: string }
      total: { bytes: number; formatted: string }
    }
    updateAvailable: boolean
    updateVersion: string | null
  } | null>(null)

  useEffect(() => {
    loadSettings()
    loadAppInfo()
    loadAvailableVersions()
    
    // Refresh app info periodically to update storage usage (especially voice cache)
    const refreshInterval = setInterval(() => {
      loadAppInfo()
    }, 5000) // Refresh every 5 seconds
    
    return () => clearInterval(refreshInterval)
  }, [])

  const loadAvailableVersions = async () => {
    if (!window.electronAPI) return

    setLoadingVersions(true)
    try {
      const versions = await window.electronAPI.getAvailableVersions()
      setAvailableVersions(versions)
    } catch (err) {
      console.error('Failed to load available versions:', err)
    } finally {
      setLoadingVersions(false)
    }
  }

  const loadAppInfo = async () => {
    if (!window.electronAPI) return

    try {
      const info = await window.electronAPI.getAppInfo()
      setAppInfo(info)
    } catch (err) {
      console.error('Failed to load app info:', err)
    }
  }

  const loadSettings = async () => {
    if (!window.electronAPI) {
      setError('Electron API not available')
      setLoading(false)
      return
    }

    try {
      const allSettings = await window.electronAPI.getAllSettings()
      setSettings({
        cs2_path: allSettings.cs2_path || '',
        cs2_window_width: allSettings.cs2_window_width || '1920',
        cs2_window_height: allSettings.cs2_window_height || '1080',
        cs2_window_mode: allSettings.cs2_window_mode || 'windowed',
        auto_cleanup_missing_demos: allSettings.auto_cleanup_missing_demos || 'true',
        match_cap_enabled: allSettings.match_cap_enabled || 'false',
        match_cap_value: allSettings.match_cap_value || '10',
        enable_db_viewer: allSettings.enable_db_viewer || 'false',
        default_afk_threshold: allSettings.default_afk_threshold || '10',
        default_flash_threshold: allSettings.default_flash_threshold || '1.5',
        default_sort_field: allSettings.default_sort_field || 'date',
        default_sort_direction: allSettings.default_sort_direction || 'desc',
        voice_skip_time: allSettings.voice_skip_time || '10',
        position_extraction_interval: allSettings.position_extraction_interval || '4',
        ram_only_parsing: allSettings.ram_only_parsing || 'false',
        voiceCacheSizeLimitMB: allSettings.voiceCacheSizeLimitMB || '50',
        autoUpdateEnabled: allSettings.autoUpdateEnabled || 'true',
        manualVersion: allSettings.manualVersion || '',
        debugMode: allSettings.debugMode || 'false',
        overlayEnabled: allSettings.overlayEnabled !== undefined ? allSettings.overlayEnabled : 'false',
        autoplayAfterSpectate: allSettings.autoplayAfterSpectate !== undefined ? allSettings.autoplayAfterSpectate : 'true',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings')
    } finally {
      setLoading(false)
    }
  }

  // Save a single setting immediately
  const handleSaveSingleSetting = async (key: string, value: string) => {
    if (!window.electronAPI) return

    try {
      await window.electronAPI.setSetting(key, value)
      
      // Special handling for match cap
      if (key === 'match_cap_enabled' && value === 'true') {
        const capValue = parseInt(settings.match_cap_value, 10)
        if (!isNaN(capValue) && capValue > 0) {
          try {
            await window.electronAPI.trimMatchesToCap(capValue)
          } catch (err) {
            console.error('Failed to trim matches:', err)
          }
        }
      }
    } catch (err) {
      console.error(`Failed to save setting ${key}:`, err)
      setError(err instanceof Error ? err.message : `Failed to save ${key}`)
    }
  }

  // Save only window settings
  const handleSaveWindowSettings = async () => {
    if (!window.electronAPI) {
      setError('Electron API not available')
      return
    }

    setSaving(true)
    setError(null)
    setSuccess(false)

    try {
      await window.electronAPI.setSetting('cs2_window_width', settings.cs2_window_width)
      await window.electronAPI.setSetting('cs2_window_height', settings.cs2_window_height)
      await window.electronAPI.setSetting('cs2_window_mode', settings.cs2_window_mode)

      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save window settings')
    } finally {
      setSaving(false)
    }
  }

  const handleBrowseCS2 = async () => {
    if (!window.electronAPI) return

    const path = await window.electronAPI.openFileDialog()
    if (path) {
      setSettings((prev) => ({ ...prev, cs2_path: path }))
      // Save immediately when file is selected
      await handleSaveSingleSetting('cs2_path', path)
    }
  }

  const handleDeleteAllMatches = async () => {
    if (!window.electronAPI) return
    
    setDeleting(true)
    setError(null)
    
    try {
      const result = await window.electronAPI.deleteAllMatches()
      setSuccess(true)
      setShowDeleteConfirm(false)
      setTimeout(() => {
        setSuccess(false)
        // Refresh matches list if we're on matches screen
        window.location.reload()
      }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete matches')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-gray-400">Loading settings...</div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col p-6 overflow-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold mb-2">Settings</h2>
        <p className="text-gray-400 text-sm">Configure application settings</p>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-900/20 border border-red-500/50 rounded text-red-400">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 p-4 bg-green-900/20 border border-green-500/50 rounded text-green-400">
          Settings saved successfully!
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Settings */}
        <div className="space-y-6">
          {/* CS2 Path */}
        <div className="bg-secondary rounded-lg border border-border p-4">
          <h3 className="text-lg font-semibold mb-4">CS2 Configuration</h3>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                CS2 Executable Path
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={settings.cs2_path}
                  onChange={(e) => setSettings((prev) => ({ ...prev, cs2_path: e.target.value }))}
                  placeholder="C:\Program Files\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe"
                  className="flex-1 px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                />
                <button
                  onClick={handleBrowseCS2}
                  className="px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 transition-colors text-sm"
                >
                  Browse
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Path to the CS2 executable (cs2.exe)
              </p>
            </div>
          </div>
        </div>

        {/* Window Settings */}
        <div className="bg-secondary rounded-lg border border-border p-4">
          <h3 className="text-lg font-semibold mb-4">Window Settings</h3>
          
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Window Width
                </label>
                <input
                  type="number"
                  value={settings.cs2_window_width}
                  onChange={(e) => setSettings((prev) => ({ ...prev, cs2_window_width: e.target.value }))}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  min="640"
                  max="7680"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Window Height
                </label>
                <input
                  type="number"
                  value={settings.cs2_window_height}
                  onChange={(e) => setSettings((prev) => ({ ...prev, cs2_window_height: e.target.value }))}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  min="480"
                  max="4320"
                />
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Window Mode
              </label>
              <select
                value={settings.cs2_window_mode}
                onChange={(e) => setSettings((prev) => ({ ...prev, cs2_window_mode: e.target.value }))}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
              >
                <option value="windowed">Windowed</option>
                <option value="fullscreen">Fullscreen</option>
              </select>
            </div>

            {/* Save Button for Window Settings */}
            <div className="flex justify-end pt-2">
              <button
                onClick={handleSaveWindowSettings}
                disabled={saving}
                className="px-6 py-2 bg-accent text-white rounded hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
              >
                {saving ? 'Saving...' : 'Save Window Settings'}
              </button>
            </div>
          </div>
        </div>

        {/* Playback Settings */}
        <div className="bg-secondary rounded-lg border border-border p-4">
          <h3 className="text-lg font-semibold mb-4">Playback Settings</h3>
          
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Autoplay After Spectate
                </label>
                <p className="text-xs text-gray-500">
                  Automatically resume demo playback after spectating a player
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.autoplayAfterSpectate === 'true'}
                  onChange={async (e) => {
                    const newValue = e.target.checked ? 'true' : 'false'
                    setSettings((prev) => ({ ...prev, autoplayAfterSpectate: newValue }))
                    await handleSaveSingleSetting('autoplayAfterSpectate', newValue)
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>
          </div>
        </div>

        {/* Overlay Settings */}
        <div className="bg-secondary rounded-lg border border-border p-4">
          <h3 className="text-lg font-semibold mb-4">Overlay Settings</h3>
          
          <div className="space-y-4">
            {/* Overlay Enable/Disable */}
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Enable Overlay
                </label>
                <p className="text-xs text-gray-500">
                  Enable or disable the overlay window completely. When disabled, the overlay will not be created or shown.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.overlayEnabled !== 'false'}
                  onChange={async (e) => {
                    const value = e.target.checked ? 'true' : 'false'
                    setSettings((prev) => ({ ...prev, overlayEnabled: value }))
                    await handleSaveSingleSetting('overlayEnabled', value)
                    // Close overlay if disabling
                    if (!e.target.checked && window.electronAPI?.overlay?.close) {
                      await window.electronAPI.overlay.close()
                    }
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
              </label>
            </div>

            <div className="pt-2 border-t border-border">
              {/* Overlay Hotkey Settings */}
              <OverlayHotkeySettings />
            </div>

            <div className="pt-2 border-t border-border">
              {/* Debug Mode */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    Debug Mode
                  </label>
                  <p className="text-xs text-gray-500">
                    Show command log in overlay (top-right). Displays all CS2 commands sent via netcon.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.debugMode === 'true'}
                    onChange={async (e) => {
                      const value = e.target.checked ? 'true' : 'false'
                      setSettings((prev) => ({ ...prev, debugMode: value }))
                      await handleSaveSingleSetting('debugMode', value)
                      // Also update via settings API for immediate overlay update
                      if (window.electronAPI) {
                        await window.electronAPI.settings.setDebugMode(e.target.checked)
                      }
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Storage Settings */}
        <div className="bg-secondary rounded-lg border border-border p-4">
          <h3 className="text-lg font-semibold mb-4">Storage Settings</h3>
          
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Rensa saknade demos vid start
                </label>
                <p className="text-xs text-gray-500">
                  Radera automatiskt databaser där demo-filen saknas
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.auto_cleanup_missing_demos === 'true'}
                  onChange={async (e) => {
                    const value = e.target.checked ? 'true' : 'false'
                    setSettings((prev) => ({ ...prev, auto_cleanup_missing_demos: value }))
                    await handleSaveSingleSetting('auto_cleanup_missing_demos', value)
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
              </label>
            </div>
            
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Begränsa antal sparade matcher
                </label>
                <p className="text-xs text-gray-500">
                  Behåll endast de N senaste matcherna
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.match_cap_enabled === 'true'}
                  onChange={async (e) => {
                    const value = e.target.checked ? 'true' : 'false'
                    setSettings((prev) => ({ ...prev, match_cap_enabled: value }))
                    await handleSaveSingleSetting('match_cap_enabled', value)
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
              </label>
            </div>
            
            {settings.match_cap_enabled === 'true' && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Max antal matcher
                </label>
                <input
                  type="number"
                  value={settings.match_cap_value}
                  onChange={async (e) => {
                    const value = e.target.value
                    setSettings((prev) => ({ ...prev, match_cap_value: value }))
                    await handleSaveSingleSetting('match_cap_value', value)
                  }}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  min="1"
                  max="1000"
                />
              </div>
            )}
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Voice Cache Size Limit (MB)
              </label>
              <input
                type="number"
                value={settings.voiceCacheSizeLimitMB}
                onChange={async (e) => {
                  const value = e.target.value
                  setSettings((prev) => ({ ...prev, voiceCacheSizeLimitMB: value }))
                  await handleSaveSingleSetting('voiceCacheSizeLimitMB', value)
                }}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                min="1"
                max="10000"
              />
              <p className="text-xs text-gray-500 mt-1">
                Maximum size for voice extraction cache (default: 50MB). Oldest files are deleted when limit is exceeded.
              </p>
            </div>
          </div>
        </div>

        {/* Display Settings */}
        <div className="bg-secondary rounded-lg border border-border p-4">
          <h3 className="text-lg font-semibold mb-4">Display Settings</h3>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Default AFK Threshold (seconds)
              </label>
              <input
                type="number"
                step="0.1"
                value={settings.default_afk_threshold}
                onChange={async (e) => {
                  const value = e.target.value
                  setSettings((prev) => ({ ...prev, default_afk_threshold: value }))
                  await handleSaveSingleSetting('default_afk_threshold', value)
                }}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                min="0"
                max="300"
              />
              <p className="text-xs text-gray-500 mt-1">
                Default minimum AFK duration to show in overview (default: 10s)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Default Flash Threshold (seconds)
              </label>
              <input
                type="number"
                step="0.1"
                value={settings.default_flash_threshold}
                onChange={async (e) => {
                  const value = e.target.value
                  setSettings((prev) => ({ ...prev, default_flash_threshold: value }))
                  await handleSaveSingleSetting('default_flash_threshold', value)
                }}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                min="0"
                max="60"
              />
              <p className="text-xs text-gray-500 mt-1">
                Default minimum flash duration to show in overview (default: 1.5s)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Position Extraction Frequency
              </label>
              <select
                value={settings.position_extraction_interval}
                onChange={async (e) => {
                  const value = e.target.value
                  setSettings((prev) => ({ ...prev, position_extraction_interval: value }))
                  await handleSaveSingleSetting('position_extraction_interval', value)
                }}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
              >
                <option value="1">All positions (slowest, most accurate)</option>
                <option value="2">Half positions (1/2, balanced)</option>
                <option value="4">Quarter positions (1/4, fastest, default)</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Controls how often player positions are stored. Lower values = more accurate but slower parsing. (default: 1/4)
              </p>
            </div>

            <div>
              <label className="flex items-center gap-2 mb-2">
                <input
                  type="checkbox"
                  checked={settings.ram_only_parsing === 'true'}
                  onChange={async (e) => {
                    const value = e.target.checked ? 'true' : 'false'
                    setSettings((prev) => ({ ...prev, ram_only_parsing: value }))
                    await handleSaveSingleSetting('ram_only_parsing', value)
                  }}
                  className="w-4 h-4 text-accent bg-surface border-border rounded focus:ring-accent focus:ring-2"
                />
                <span className="text-sm font-medium text-gray-300">
                  RAM-Only Parsing (No Disk Writes During Parsing)
                </span>
              </label>
              <p className="text-xs text-gray-500 ml-6">
                Accumulate all data in memory before writing to disk. This can use a lot of RAM for large demos, but may be faster for smaller demos. (Default: disabled)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Default Match Sort
              </label>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={settings.default_sort_field}
                  onChange={async (e) => {
                    const value = e.target.value
                    setSettings((prev) => ({ ...prev, default_sort_field: value }))
                    await handleSaveSingleSetting('default_sort_field', value)
                  }}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                >
                  <option value="date">Date</option>
                  <option value="id">ID</option>
                  <option value="length">Duration</option>
                  <option value="map">Map</option>
                </select>
                <select
                  value={settings.default_sort_direction}
                  onChange={async (e) => {
                    const value = e.target.value
                    setSettings((prev) => ({ ...prev, default_sort_direction: value }))
                    await handleSaveSingleSetting('default_sort_direction', value)
                  }}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Default sorting for matches list
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Voice Playback Skip Time (seconds)
              </label>
              <input
                type="number"
                step="0.5"
                value={settings.voice_skip_time}
                onChange={async (e) => {
                  const value = e.target.value
                  setSettings((prev) => ({ ...prev, voice_skip_time: value }))
                  await handleSaveSingleSetting('voice_skip_time', value)
                }}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                min="0.5"
                max="60"
              />
              <p className="text-xs text-gray-500 mt-1">
                Time to skip forward/backward in voice playback (default: 10s)
              </p>
            </div>
          </div>
        </div>

        {/* Advanced Settings */}
        <div className="bg-secondary rounded-lg border border-border p-4">
          <h3 className="text-lg font-semibold mb-4">Advanced</h3>
          
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Enable DB Viewer
                </label>
                <p className="text-xs text-gray-500">
                  Show the database viewer in the sidebar for debugging
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.enable_db_viewer === 'true'}
                  onChange={async (e) => {
                    const value = e.target.checked ? 'true' : 'false'
                    setSettings((prev) => ({ ...prev, enable_db_viewer: value }))
                    await handleSaveSingleSetting('enable_db_viewer', value)
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
              </label>
            </div>
          </div>
        </div>

        {/* Danger Zone */}
        <div className="bg-secondary rounded-lg border border-red-500/50 p-4">
          <h3 className="text-lg font-semibold mb-4 text-red-400">Danger Zone</h3>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Ta bort alla matcher
              </label>
              <p className="text-xs text-gray-500 mb-3">
                Detta raderar alla sparade matcher permanent. Denna åtgärd kan inte ångras.
              </p>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors text-sm"
              >
                Ta bort alla matcher
              </button>
            </div>
          </div>
        </div>

        {/* Delete All Matches Modal */}
        <Modal
          isOpen={showDeleteConfirm}
          onClose={() => !deleting && setShowDeleteConfirm(false)}
          title="Ta bort alla matcher"
          size="md"
          footer={
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="px-4 py-2 bg-surface border border-border text-white rounded hover:bg-surface/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
              >
                Avbryt
              </button>
              <button
                onClick={handleDeleteAllMatches}
                disabled={deleting}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
              >
                {deleting ? 'Raderar...' : 'Ja, radera alla'}
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-red-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-white mb-2">
                  Är du säker?
                </h3>
                <p className="text-sm text-gray-400 mb-2">
                  Detta kommer att radera alla sparade matcher permanent från databasen.
                </p>
                <p className="text-sm text-red-400 font-medium">
                  Denna åtgärd kan inte ångras.
                </p>
              </div>
            </div>
          </div>
        </Modal>
        </div>

        {/* Right Column: Application Information */}
        {appInfo && (
          <div className="space-y-6">
            <div className="bg-secondary rounded-lg border border-border p-4">
              <h3 className="text-lg font-semibold mb-4">Application Information</h3>
              
              <div className="space-y-3">
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-gray-400">Version</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">{appInfo.version}</span>
                    <button
                      onClick={() => setShowWhatsNew(true)}
                      className="px-3 py-1 bg-surface hover:bg-surface/80 text-white text-xs rounded transition-colors flex items-center gap-1"
                      title="View What's New"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      What's New
                    </button>
                    {appInfo.updateAvailable && appInfo.updateVersion && (
                      <button
                        onClick={async () => {
                          if (window.electronAPI?.restartApp) {
                            await window.electronAPI.restartApp()
                          }
                        }}
                        className="px-3 py-1 bg-accent hover:bg-accent/90 text-white text-xs rounded transition-colors flex items-center gap-1"
                        title={`Restart to install update v${appInfo.updateVersion}`}
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Restart to Update
                      </button>
                    )}
                  </div>
                </div>
                
                
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-gray-400">Platform</span>
                  <span className="text-sm font-medium text-white">
                    {appInfo.platform} {appInfo.arch} ({appInfo.osVersion})
                  </span>
                </div>
                
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-gray-400">Electron</span>
                  <span className="text-sm font-medium text-white">{appInfo.electronVersion}</span>
                </div>
                
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-gray-400">Chrome</span>
                  <span className="text-sm font-medium text-white">{appInfo.chromeVersion}</span>
                </div>
                
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-gray-400">Node.js</span>
                  <span className="text-sm font-medium text-white">{appInfo.nodeVersion}</span>
                </div>
                
                <div className="mt-4 pt-3 border-t border-border">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-gray-300">Storage Usage</h4>
                    <button
                      onClick={loadAppInfo}
                      className="p-1.5 hover:bg-surface rounded transition-colors"
                      title="Refresh storage usage"
                    >
                      <RefreshCw size={14} className="text-gray-400 hover:text-white" />
                    </button>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Matches ({appInfo.storage.matches.count} files)</span>
                      <span className="text-sm font-medium text-white">{appInfo.storage.matches.formatted}</span>
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Settings</span>
                      <span className="text-sm font-medium text-white">{appInfo.storage.settings.formatted}</span>
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">Voice Cache</span>
                      <span className="text-sm font-medium text-white">{appInfo.storage.voiceCache?.formatted || '0 B'}</span>
                    </div>
                    
                    <div className="flex items-center justify-between pt-2 border-t border-border/50">
                      <span className="text-sm font-medium text-gray-300">Total</span>
                      <span className="text-sm font-semibold text-white">{appInfo.storage.total.formatted}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Update Settings */}
            <div className="bg-secondary rounded-lg border border-border p-4">
              <h3 className="text-lg font-semibold mb-4">Update Settings</h3>
              
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">
                      Enable Auto-Update on Startup
                    </label>
                    <p className="text-xs text-gray-500">
                      Automatically check for and download updates when the application starts
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.autoUpdateEnabled === 'true'}
                      onChange={async (e) => {
                        const value = e.target.checked ? 'true' : 'false'
                        setSettings((prev) => ({ ...prev, autoUpdateEnabled: value }))
                        await handleSaveSingleSetting('autoUpdateEnabled', value)
                      }}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Download and Install Version
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={settings.manualVersion}
                      onChange={async (e) => {
                        const value = e.target.value
                        setSettings((prev) => ({ ...prev, manualVersion: value }))
                        await handleSaveSingleSetting('manualVersion', value)
                        setInstallError(null)
                      }}
                      className="flex-1 px-3 py-2 bg-surface border border-border rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      disabled={loadingVersions || installingVersion !== null}
                    >
                      <option value="">Use actual version</option>
                      {availableVersions.map((version) => (
                        <option key={version} value={version}>
                          {version}
                        </option>
                      ))}
                    </select>
                    {settings.manualVersion && (
                      <button
                        onClick={async () => {
                          if (!settings.manualVersion) return
                          
                          setInstallingVersion(settings.manualVersion)
                          setInstallError(null)
                          
                          try {
                            const result = await window.electronAPI?.downloadAndInstallVersion(settings.manualVersion)
                            if (result?.success) {
                              // App will restart, so we don't need to do anything else
                            } else {
                              setInstallError(result?.error || 'Failed to install version')
                              setInstallingVersion(null)
                            }
                          } catch (err) {
                            setInstallError(err instanceof Error ? err.message : 'Failed to install version')
                            setInstallingVersion(null)
                          }
                        }}
                        disabled={installingVersion !== null || !settings.manualVersion}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition-colors whitespace-nowrap"
                      >
                        {installingVersion ? 'Installing...' : 'Install'}
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Select a version to download and install. The app will restart after installation. Useful if a broken version was published.
                  </p>
                  {loadingVersions && (
                    <p className="text-xs text-gray-400 mt-1">Loading versions...</p>
                  )}
                  {installError && (
                    <p className="text-xs text-red-400 mt-1">{installError}</p>
                  )}
                  {installingVersion && (
                    <p className="text-xs text-blue-400 mt-1">Downloading and installing {installingVersion}... The app will restart shortly.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      
      {/* What's New Modal */}
      {showWhatsNew && appInfo && (
        <WhatsNewModal 
          version={appInfo.version} 
          onClose={() => setShowWhatsNew(false)} 
        />
      )}
    </div>
  )
}

export default SettingsScreen

