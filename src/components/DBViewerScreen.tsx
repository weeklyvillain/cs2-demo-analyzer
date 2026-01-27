import { useState, useEffect } from 'react'
import { t, getLanguage } from '../utils/translations'

interface TableInfo {
  name: string
  rowCount: number
  schema: string
}

interface QueryResult {
  columns: string[]
  rows: any[][]
}

function DBViewerScreen() {
  const [matches, setMatches] = useState<Array<{ id: string; map: string }>>([])
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null)
  const [tables, setTables] = useState<string[]>([])
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [tableInfo, setTableInfo] = useState<TableInfo | null>(null)
  const [tableRows, setTableRows] = useState<QueryResult | null>(null)
  const [loadingTableRows, setLoadingTableRows] = useState(false)
  const [query, setQuery] = useState<string>('')
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    loadMatches()
    
    // Listen for navigation events (when already on DB Viewer screen)
    const handleNavigate = () => {
      // Reload matches to ensure we have the latest list
      loadMatches()
    }
    
    window.addEventListener('navigateToDbViewer', handleNavigate)
    return () => window.removeEventListener('navigateToDbViewer', handleNavigate)
  }, [])

  // Subscribe to language changes
  useEffect(() => {
    const checkLanguage = () => {
      forceUpdate((prev) => prev + 1)
    }
    // Check language every second (simple polling approach)
    const interval = setInterval(checkLanguage, 1000)
    return () => clearInterval(interval)
  }, [])

  // Effect to select match from localStorage after matches are loaded
  useEffect(() => {
    const storedMatchId = localStorage.getItem('dbViewerSelectedMatch')
    if (storedMatchId && matches.length > 0) {
      const matchExists = matches.some(m => m.id === storedMatchId)
      if (matchExists && selectedMatchId !== storedMatchId) {
        setSelectedMatchId(storedMatchId)
        localStorage.removeItem('dbViewerSelectedMatch')
      }
    } else if (matches.length > 0 && !selectedMatchId && !storedMatchId) {
      // Auto-select first match if no selection and no stored ID
      setSelectedMatchId(matches[0].id)
    }
  }, [matches, selectedMatchId])

  useEffect(() => {
    if (selectedMatchId) {
      loadTables()
    } else {
      setTables([])
      setSelectedTable(null)
      setTableInfo(null)
    }
  }, [selectedMatchId])

  useEffect(() => {
    if (selectedMatchId && selectedTable) {
      loadTableInfo()
      loadTableRows()
    } else {
      setTableInfo(null)
      setTableRows(null)
    }
  }, [selectedMatchId, selectedTable])

  const loadMatches = async () => {
    if (!window.electronAPI) return

    try {
      const data = await window.electronAPI.listMatches()
      setMatches(data)
      // Match selection will be handled by useEffect that watches matches state
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dbviewer.failedToLoadMatches'))
    }
  }

  const loadTables = async () => {
    if (!window.electronAPI || !selectedMatchId) return

    setLoading(true)
    setError(null)

    try {
      const data = await window.electronAPI.listTables(selectedMatchId)
      setTables(data)
      if (data.length > 0) {
        setSelectedTable(data[0])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dbviewer.failedToLoadTables'))
    } finally {
      setLoading(false)
    }
  }

  const loadTableInfo = async () => {
    if (!window.electronAPI || !selectedMatchId || !selectedTable) return

    setLoading(true)
    setError(null)

    try {
      const info = await window.electronAPI.getTableInfo(selectedMatchId, selectedTable)
      setTableInfo(info)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dbviewer.failedToLoadTableInfo'))
    } finally {
      setLoading(false)
    }
  }

  const loadTableRows = async () => {
    if (!window.electronAPI || !selectedMatchId || !selectedTable) return

    // Validate table name to prevent SQL injection
    // Table names should only contain alphanumeric characters, underscores, and be in the tables list
    if (!/^[a-zA-Z0-9_]+$/.test(selectedTable) || !tables.includes(selectedTable)) {
      setError(t('dbviewer.invalidTableName'))
      setTableRows(null)
      return
    }

    setLoadingTableRows(true)
    setError(null)

    try {
      // Use parameterized query approach - escape table name
      const escapedTableName = selectedTable.replace(/"/g, '""')
      const result = await window.electronAPI.runQuery(selectedMatchId, `SELECT * FROM "${escapedTableName}" LIMIT 100`)
      setTableRows(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dbviewer.failedToLoadTableRows'))
      setTableRows(null)
    } finally {
      setLoadingTableRows(false)
    }
  }

  const runQuery = async () => {
    if (!window.electronAPI || !selectedMatchId || !query.trim()) return

    setLoading(true)
    setError(null)
    setQueryResult(null)

    try {
      const result = await window.electronAPI.runQuery(selectedMatchId, query)
      setQueryResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dbviewer.queryFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col p-6 overflow-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold mb-2">{t('dbviewer.title')}</h2>
        <p className="text-gray-400 text-sm">{t('dbviewer.subtitle')}</p>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-900/20 border border-red-500/50 rounded text-red-400">
          {error}
        </div>
      )}

      <div className="flex-1 grid grid-cols-2 gap-6">
        {/* Left: Match and Table Selection */}
        <div className="space-y-4">
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">{t('dbviewer.selectMatch')}</h3>
            <select
              value={selectedMatchId || ''}
              onChange={(e) => setSelectedMatchId(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
            >
              <option value="">{t('dbviewer.selectMatchPlaceholder')}</option>
              {matches.map((match) => (
                <option key={match.id} value={match.id}>
                  {match.map} ({match.id})
                </option>
              ))}
            </select>
          </div>

          {selectedMatchId && (
            <div className="bg-secondary rounded-lg border border-border p-4">
              <h3 className="text-lg font-semibold mb-4">{t('dbviewer.tables')}</h3>
              {loading ? (
                <div className="text-gray-400 text-sm">{t('dbviewer.loadingTables')}</div>
              ) : (
                <div className="space-y-2">
                  {tables.map((table) => (
                    <button
                      key={table}
                      onClick={() => setSelectedTable(table)}
                      className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                        selectedTable === table
                          ? 'bg-accent text-white'
                          : 'bg-surface text-gray-300 hover:bg-surface/80'
                      }`}
                    >
                      {table}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {tableInfo && (
            <div className="bg-secondary rounded-lg border border-border p-4">
              <h3 className="text-lg font-semibold mb-4">{t('dbviewer.tableInfo')}</h3>
              <div className="space-y-2 text-sm">
                <div>
                  <span className="text-gray-400">{t('dbviewer.rows')} </span>
                  <span className="text-white">{tableInfo.rowCount.toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-gray-400">{t('dbviewer.schema')}</span>
                  <pre className="mt-2 p-2 bg-surface rounded text-xs text-gray-300 overflow-x-auto max-h-40 overflow-y-auto">
                    {tableInfo.schema || 'N/A'}
                  </pre>
                </div>
              </div>
            </div>
          )}

          {selectedTable && (
            <div className="bg-secondary rounded-lg border border-border p-4">
              <h3 className="text-lg font-semibold mb-4">{t('dbviewer.tableData')} {selectedTable}</h3>
              {loadingTableRows ? (
                <div className="text-gray-400 text-sm">{t('dbviewer.loadingRows')}</div>
              ) : tableRows ? (
                <div className="space-y-2">
                  <div className="overflow-x-auto max-h-96 overflow-y-auto border border-border rounded">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-secondary">
                        <tr className="border-b border-border">
                          {tableRows.columns.map((col, idx) => (
                            <th key={idx} className="text-left px-3 py-2 text-gray-400 font-medium">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {tableRows.rows.map((row, rowIdx) => (
                          <tr key={rowIdx} className="border-b border-border/50 hover:bg-surface/50">
                            {row.map((cell, cellIdx) => (
                              <td key={cellIdx} className="px-3 py-2 text-gray-300 whitespace-nowrap">
                                {cell !== null && cell !== undefined ? (
                                  <span className="max-w-xs truncate block" title={String(cell)}>
                                    {String(cell)}
                                  </span>
                                ) : (
                                  <span className="text-gray-500 italic">{t('dbviewer.null')}</span>
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {tableRows.rows.length === 0 && (
                    <div className="text-center py-4 text-gray-400">{t('dbviewer.noRows')}</div>
                  )}
                  {tableInfo && tableInfo.rowCount > tableRows.rows.length && (
                    <div className="text-center py-2 text-xs text-gray-500">
                      {t('dbviewer.showingRows').replace('{showing}', tableRows.rows.length.toString()).replace('{total}', tableInfo.rowCount.toLocaleString())}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-gray-400 text-sm">{t('dbviewer.noData')}</div>
              )}
            </div>
          )}
        </div>

        {/* Right: Query Runner */}
        <div className="space-y-4">
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">{t('dbviewer.queryRunner')}</h3>
            <div className="space-y-2">
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('dbviewer.queryPlaceholder')}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm font-mono"
                rows={6}
              />
              <button
                onClick={runQuery}
                disabled={loading || !selectedMatchId || !query.trim()}
                className="w-full px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? t('dbviewer.running') : t('dbviewer.runQuery')}
              </button>
              <p className="text-xs text-gray-500">
                {t('dbviewer.queryHint')}
              </p>
            </div>
          </div>

          {queryResult && (
            <div className="bg-secondary rounded-lg border border-border p-4">
              <h3 className="text-lg font-semibold mb-4">{t('dbviewer.results')}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      {queryResult.columns.map((col, idx) => (
                        <th key={idx} className="text-left px-2 py-2 text-gray-400">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {queryResult.rows.map((row, rowIdx) => (
                      <tr key={rowIdx} className="border-b border-border/50">
                        {row.map((cell, cellIdx) => (
                          <td key={cellIdx} className="px-2 py-2 text-gray-300">
                            {cell !== null && cell !== undefined ? String(cell) : t('dbviewer.null')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {queryResult.rows.length === 0 && (
                  <div className="text-center py-4 text-gray-400">{t('dbviewer.noResults')}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default DBViewerScreen
