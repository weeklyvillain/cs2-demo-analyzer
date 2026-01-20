import { useState, useEffect } from 'react'

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
      setError(err instanceof Error ? err.message : 'Failed to load matches')
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
      setError(err instanceof Error ? err.message : 'Failed to load tables')
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
      setError(err instanceof Error ? err.message : 'Failed to load table info')
    } finally {
      setLoading(false)
    }
  }

  const loadTableRows = async () => {
    if (!window.electronAPI || !selectedMatchId || !selectedTable) return

    // Validate table name to prevent SQL injection
    // Table names should only contain alphanumeric characters, underscores, and be in the tables list
    if (!/^[a-zA-Z0-9_]+$/.test(selectedTable) || !tables.includes(selectedTable)) {
      setError('Invalid table name')
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
      setError(err instanceof Error ? err.message : 'Failed to load table rows')
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
      setError(err instanceof Error ? err.message : 'Query failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col p-6 overflow-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold mb-2">DB Viewer</h2>
        <p className="text-gray-400 text-sm">Inspect database tables and run queries</p>
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
            <h3 className="text-lg font-semibold mb-4">Select Match</h3>
            <select
              value={selectedMatchId || ''}
              onChange={(e) => setSelectedMatchId(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
            >
              <option value="">Select a match...</option>
              {matches.map((match) => (
                <option key={match.id} value={match.id}>
                  {match.map} ({match.id})
                </option>
              ))}
            </select>
          </div>

          {selectedMatchId && (
            <div className="bg-secondary rounded-lg border border-border p-4">
              <h3 className="text-lg font-semibold mb-4">Tables</h3>
              {loading ? (
                <div className="text-gray-400 text-sm">Loading tables...</div>
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
              <h3 className="text-lg font-semibold mb-4">Table Info</h3>
              <div className="space-y-2 text-sm">
                <div>
                  <span className="text-gray-400">Rows: </span>
                  <span className="text-white">{tableInfo.rowCount.toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-gray-400">Schema:</span>
                  <pre className="mt-2 p-2 bg-surface rounded text-xs text-gray-300 overflow-x-auto max-h-40 overflow-y-auto">
                    {tableInfo.schema || 'N/A'}
                  </pre>
                </div>
              </div>
            </div>
          )}

          {selectedTable && (
            <div className="bg-secondary rounded-lg border border-border p-4">
              <h3 className="text-lg font-semibold mb-4">Table Data: {selectedTable}</h3>
              {loadingTableRows ? (
                <div className="text-gray-400 text-sm">Loading rows...</div>
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
                                  <span className="text-gray-500 italic">NULL</span>
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {tableRows.rows.length === 0 && (
                    <div className="text-center py-4 text-gray-400">No rows</div>
                  )}
                  {tableInfo && tableInfo.rowCount > tableRows.rows.length && (
                    <div className="text-center py-2 text-xs text-gray-500">
                      Showing {tableRows.rows.length} of {tableInfo.rowCount.toLocaleString()} rows
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-gray-400 text-sm">No data</div>
              )}
            </div>
          )}
        </div>

        {/* Right: Query Runner */}
        <div className="space-y-4">
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">Query Runner</h3>
            <div className="space-y-2">
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="SELECT * FROM matches LIMIT 10"
                className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm font-mono"
                rows={6}
              />
              <button
                onClick={runQuery}
                disabled={loading || !selectedMatchId || !query.trim()}
                className="w-full px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Running...' : 'Run Query'}
              </button>
              <p className="text-xs text-gray-500">
                Only SELECT and PRAGMA table_info queries are allowed. LIMIT 200 is automatically added.
              </p>
            </div>
          </div>

          {queryResult && (
            <div className="bg-secondary rounded-lg border border-border p-4">
              <h3 className="text-lg font-semibold mb-4">Results</h3>
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
                            {cell !== null && cell !== undefined ? String(cell) : 'NULL'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {queryResult.rows.length === 0 && (
                  <div className="text-center py-4 text-gray-400">No results</div>
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
