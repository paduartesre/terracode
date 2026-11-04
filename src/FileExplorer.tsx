import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  createEntry,
  deleteEntry,
  getGitStatus,
  listDir,
  listRoots,
  openFolder,
  removeRoot,
  renameEntry,
  replaceInFile,
  searchFiles,
  type Entry,
  type GitStatusResult,
  type RootsResult,
  type SearchOptions,
  type SearchResult
} from './api'
import { badgesBySegment, type GitBadge } from './gitBadge'

type FileExplorerProps = {
  onSelectFile: (filePath: string) => void
  selectedFile?: string
  recentFiles?: string[]
  onClearRecentFiles?: () => void
  // Folder to browse when it changes (e.g. a Terraform project loaded via the
  // panel's picker). Manual navigation afterwards is not overridden.
  requestedRoot?: string | null
  onEntryRenamed?: (oldPath: string, newPath: string) => void
  onEntryDeleted?: (path: string) => void
  externalRefresh?: number
  // Report the browsed folder + its git status up so App can render the
  // dedicated right-hand Git sidebar independently of this tree.
  onGitContext?: (dirPath: string, status: GitStatusResult | null) => void
}

const DEFAULT_ROOT = '/home/pedroantonio/github/code/app-test'

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

type TreeActions = {
  onRenamed: (oldPath: string, newPath: string) => void
  onDeleted: (path: string) => void
  bumpRefresh: () => void
}

type TreeNodeProps = {
  entry: Entry
  parentPath: string
  selectedFile?: string
  onSelectFile: (filePath: string) => void
  refreshKey: number
  actions: TreeActions
  badges?: GitBadge[]
}

const TreeNode = ({
  entry,
  parentPath,
  selectedFile,
  onSelectFile,
  refreshKey,
  actions,
  badges
}: TreeNodeProps): ReactElement => {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<Entry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  // Git status of this directory (for badges on its children); empty when the
  // folder is not inside a repository or has no changes.
  const [statusBadges, setStatusBadges] = useState<Map<string, GitBadge[]>>(new Map())

  // Re-fetch children when a create/rename/delete happens anywhere in the tree.
  useEffect(() => {
    if (!entry.isDirectory || !expanded || children === null) return
    let cancelled = false
    listDir(entry.path)
      .then(entries => {
        if (!cancelled) setChildren(sortEntries(entries))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch git status for this directory when expanded (and on tree refreshes).
  useEffect(() => {
    if (!entry.isDirectory || !expanded) return
    let cancelled = false
    getGitStatus(entry.path)
      .then(status => {
        if (!cancelled && status.isRepo) setStatusBadges(badgesBySegment(status.entries))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [entry.isDirectory, entry.path, expanded, refreshKey])

  const badgeSpans = badges?.length ? (
    <span className="git-badges">
      {badges.map(b => (
        <span key={b.letter} className={`git-badge ${b.cls}`} title={`${b.letter} — git status`}>
          {b.letter}
        </span>
      ))}
    </span>
  ) : null

  const handleRename = async () => {
    const newName = window.prompt(`Rename "${entry.name}" to:`, entry.name)
    if (newName === null || !newName.trim() || newName.trim() === entry.name) return
    setActionError('')
    try {
      const result = await renameEntry(entry.path, joinPath(parentPath, newName.trim()))
      actions.onRenamed(entry.path, result.path)
      actions.bumpRefresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Rename failed')
    }
  }

  const handleDelete = async () => {
    const what = entry.isDirectory ? ' and all its contents' : ''
    if (!window.confirm(`Delete "${entry.name}"${what}? This cannot be undone.`)) return
    setActionError('')
    try {
      await deleteEntry(entry.path)
      actions.onDeleted(entry.path)
      actions.bumpRefresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const rowActions = (
    <span className="tree-row-actions">
      <button
        title="Rename"
        onClick={e => {
          e.stopPropagation()
          void handleRename()
        }}
      >
        ✎
      </button>
      <button
        title="Delete"
        onClick={e => {
          e.stopPropagation()
          void handleDelete()
        }}
      >
        🗑
      </button>
    </span>
  )

  if (!entry.isDirectory) {
    return (
      <>
        <div
          className={`file ${selectedFile === entry.path ? 'selected' : ''}`}
          onClick={() => onSelectFile(entry.path)}
        >
          <span className="file-icon">📄</span>
          <span className="file-name">{entry.name}</span>
          {badgeSpans}
          {rowActions}
        </div>
        {actionError && <div className="tree-status error">{actionError}</div>}
      </>
    )
  }

  const toggle = async () => {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (children !== null || loading) return
    setLoading(true)
    setError('')
    try {
      setChildren(sortEntries(await listDir(entry.path)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load folder')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className={`folder ${expanded ? 'expanded' : ''}`} onClick={() => void toggle()}>
        <span className="folder-icon">📁</span>
        <span className="folder-name">{entry.name}</span>
        {badgeSpans}
        {rowActions}
      </div>
      {actionError && <div className="tree-status error">{actionError}</div>}
      {expanded && (
        <div className="children">
          {loading && <div className="tree-status">Loading…</div>}
          {error && <div className="tree-status error">{error}</div>}
          {!loading && !error && children?.map(child => (
            <TreeNode
              key={child.path}
              entry={child}
              parentPath={entry.path}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              refreshKey={refreshKey}
              actions={actions}
              badges={statusBadges.get(child.name)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

type TreeResult = { path: string; entries?: Entry[]; error?: string }

const FileExplorer = ({
  onSelectFile,
  selectedFile,
  recentFiles,
  onClearRecentFiles,
  requestedRoot,
  onEntryRenamed,
  onEntryDeleted,
  externalRefresh,
  onGitContext
}: FileExplorerProps): ReactElement => {
  const [requestedPath, setRequestedPath] = useState(DEFAULT_ROOT)
  const [tree, setTree] = useState<TreeResult | null>(null)

  // Git status of the loaded root (badges + commit panel); null when unknown.
  const [rootStatus, setRootStatus] = useState<GitStatusResult | null>(null)
  const rootSeq = useRef(0)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const searchSeq = useRef(0)

  // Step 3: search filters (regex / case / extension) + replace bar.
  const [searchRegex, setSearchRegex] = useState(false)
  const [searchCase, setSearchCase] = useState(false)
  const [searchExt, setSearchExt] = useState('')
  const [searchNonce, setSearchNonce] = useState(0) // bump to force a re-search after replace
  const [replaceText, setReplaceText] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [replaceSummary, setReplaceSummary] = useState('')

  const [refreshKey, setRefreshKey] = useState(0)
  const [actionError, setActionError] = useState('')

  // A path the server refused as outside its allowed roots; "Open this folder"
  // asks the backend to allow it (POST /api/roots), then retries the load.
  const [allowTarget, setAllowTarget] = useState('')
  const [allowing, setAllowing] = useState(false)
  const [allowError, setAllowError] = useState('')

  // Step 3: allowed-roots management (list + remove runtime-added roots).
  const [roots, setRoots] = useState<RootsResult | null>(null)
  const [removingRoot, setRemovingRoot] = useState('')
  const [rootError, setRootError] = useState('')

  useEffect(() => {
    listRoots().then(setRoots).catch(() => setRoots(null))
  }, [])

  const loadRoot = useCallback(async (dirPath: string) => {
    const trimmed = dirPath.trim()
    if (!trimmed) return
    // A newer load started meanwhile (e.g. mount-time default root vs an
    // externally requested one): drop this stale response entirely.
    const seq = ++rootSeq.current
    try {
      const entries = sortEntries(await listDir(trimmed))
      if (seq !== rootSeq.current) return
      setTree({ path: trimmed, entries })
      setAllowTarget('')
      // Fetch git status for badges/commit panel; a stale response (user moved
      // to another folder meanwhile) is dropped via the sequence counter.
      getGitStatus(trimmed)
        .then(status => {
          if (seq === rootSeq.current) setRootStatus(status)
        })
        .catch(() => {
          if (seq === rootSeq.current) setRootStatus(null)
        })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load folder'
      if (seq !== rootSeq.current) return
      setTree({ path: trimmed, error: message })
      if (message.includes('Access denied')) setAllowTarget(trimmed)
      else setAllowTarget('')
      setRootStatus(null)
    }
  }, [])

  const rootBadges = useMemo(
    () => (rootStatus?.isRepo ? badgesBySegment(rootStatus.entries) : null),
    [rootStatus],
  )

  const handleAllowFolder = async () => {
    const target = allowTarget
    if (!target || allowing) return
    setAllowing(true)
    setAllowError('')
    try {
      const res = await openFolder(target)
      setRoots(res)
      void loadRoot(target)
    } catch (err) {
      setAllowError(err instanceof Error ? err.message : 'Failed to allow folder')
    } finally {
      setAllowing(false)
    }
  }

  // After any mutation: re-fetch the root listing (root-level entries live in
  // this component's state) and signal expanded subfolders to refresh theirs.
  const bumpRefresh = useCallback(() => {
    setRefreshKey(key => key + 1)
    void loadRoot(requestedPath)
  }, [loadRoot, requestedPath])

  // Remove a runtime-added root. If the currently-browsed folder lived inside it,
  // re-loading now surfaces "Access denied" with an option to re-open it.
  const handleRemoveRoot = async (rootPath: string) => {
    if (removingRoot !== '') return
    setRemovingRoot(rootPath)
    setRootError('')
    try {
      const res = await removeRoot(rootPath)
      setRoots(res)
      bumpRefresh()
    } catch (err) {
      setRootError(err instanceof Error ? err.message : 'Failed to remove root')
    } finally {
      setRemovingRoot('')
    }
  }

  const actions: TreeActions = {
    onRenamed: (oldPath, newPath) => onEntryRenamed?.(oldPath, newPath),
    onDeleted: deletedPath => onEntryDeleted?.(deletedPath),
    bumpRefresh
  }

  // External mutations (e.g. terraform fmt rewriting files): refresh the root
  // listing and any expanded subfolders when the parent bumps this counter.
  // Also re-fetch the allowed roots — a project loaded via the Terraform panel's
  // picker may have added one after this component mounted.
  useEffect(() => {
    if (!externalRefresh) return
    bumpRefresh() // eslint-disable-line react/set-state-in-effect
    listRoots().then(setRoots).catch(() => {})
  }, [externalRefresh]) // eslint-disable-line react-hooks/exhaustive-deps

  // Report the browsed folder + its git status up so App can render the dedicated
  // right-hand Git sidebar. Only once the tree has loaded (mirrors when the panel
  // used to appear inline below the tree).
  const treeReady = tree !== null && tree.entries !== undefined
  useEffect(() => {
    if (!onGitContext || !treeReady) return
    onGitContext(requestedPath, rootStatus)
  }, [requestedPath, rootStatus, treeReady, onGitContext])

  useEffect(() => {
    // Initial data fetch on mount: synchronizing with the external backend.
    void loadRoot(DEFAULT_ROOT) // eslint-disable-line react/set-state-in-effect
  }, [loadRoot])

  // Follow an externally requested root (e.g. a Terraform project loaded via
  // the panel's picker). Only reacts to changes of the prop itself, so manual
  // navigation afterwards is not overridden.
  useEffect(() => {
    if (!requestedRoot || requestedRoot === requestedPath) return
    setRequestedPath(requestedRoot) // eslint-disable-line react/set-state-in-effect
    void loadRoot(requestedRoot)
  }, [requestedRoot, requestedPath, loadRoot])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) return
    const seq = ++searchSeq.current
    const timer = setTimeout(async () => {
      setSearching(true)
      setSearchError('')
      try {
        const opts: SearchOptions = { regex: searchRegex, caseSensitive: searchCase }
        if (searchExt.trim()) opts.ext = searchExt.trim()
        setResults(await searchFiles(trimmed, requestedPath, opts))
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : 'Search failed')
      } finally {
        if (seq === searchSeq.current) setSearching(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [query, requestedPath, searchRegex, searchCase, searchExt, searchNonce])

  const loadPath = (dirPath: string) => {
    const trimmed = dirPath.trim()
    if (!trimmed) return
    setAllowError('')
    setRequestedPath(trimmed)
    void loadRoot(trimmed)
  }

  const handleCreate = async (type: 'file' | 'directory') => {
    const label = type === 'file' ? 'New file name:' : 'New folder name:'
    const name = window.prompt(`${label} (in ${requestedPath})`)
    if (!name || !name.trim()) return
    setActionError('')
    try {
      await createEntry(joinPath(requestedPath, name.trim()), type)
      void loadRoot(requestedPath)
      bumpRefresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Create failed')
    }
  }

  const handleResultClick = (result: SearchResult) => {
    if (result.isDirectory) {
      loadPath(result.path)
    } else {
      onSelectFile(result.path)
    }
  }

  // Files that had content matches — the targets of "Replace in N".
  const matchedFiles = useMemo(
    () => (results ?? []).filter(r => !r.isDirectory && r.matches && r.matches.length > 0),
    [results],
  )

  // Step 3: replace the current query across every file that had matches, using
  // each file's mtime from the search for conflict-safe writes.
  const handleReplaceAll = async () => {
    if (matchedFiles.length === 0 || replacing) return
    const opts: SearchOptions = { regex: searchRegex, caseSensitive: searchCase }
    setReplacing(true)
    setReplaceSummary('')
    let total = 0
    let okCount = 0
    let failCount = 0
    for (const f of matchedFiles) {
      try {
        const r = await replaceInFile(f.path, query.trim(), replaceText, f.mtimeMs, opts)
        total += r.replaced
        okCount++
      } catch {
        failCount++
      }
    }
    setReplacing(false)
    const parts = [`Replaced ${total} occurrence${total === 1 ? '' : 's'} in ${okCount}/${matchedFiles.length} file(s)`]
    if (failCount > 0) parts.push(`${failCount} failed`)
    setReplaceSummary(parts.join(' — '))
    bumpRefresh() // refresh the tree (file mtimes changed)
    setSearchNonce(n => n + 1) // re-run the search to reflect new content
  }

  const loading = tree === null || tree.path !== requestedPath
  const showSearch = query.trim() !== ''

  return (
    <div>
      <div className="path-bar">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search files and contents…"
          title={`Search within ${requestedPath}`}
          aria-label="Search"
        />
      </div>

      {query.trim() !== '' && (
        <div className="path-bar search-filters">
          <button
            type="button"
            className={`filter-toggle${searchRegex ? ' active' : ''}`}
            onClick={() => setSearchRegex(v => !v)}
            title="Use regular expression"
            aria-pressed={searchRegex}
          >
            .*
          </button>
          <button
            type="button"
            className={`filter-toggle${searchCase ? ' active' : ''}`}
            onClick={() => setSearchCase(v => !v)}
            title="Match case"
            aria-pressed={searchCase}
          >
            Aa
          </button>
          <input
            value={searchExt}
            onChange={e => setSearchExt(e.target.value)}
            placeholder="ext (ts,tsx)"
            aria-label="Filter by extension"
            className="ext-input"
          />
        </div>
      )}

      <div className="path-bar tree-actions">
        <button onClick={() => void handleCreate('file')}>+ File</button>
        <button onClick={() => void handleCreate('directory')}>+ Folder</button>
      </div>

      {actionError && <div className="tree-status error">{actionError}</div>}

      {recentFiles !== undefined && recentFiles.length > 0 && (
        <div className="recent-section">
          <div className="recent-header">
            Recent
            {onClearRecentFiles && (
              <button
                type="button"
                className="recent-clear"
                onClick={onClearRecentFiles}
                title="Clear recent files"
                aria-label="Clear recent files"
              >
                ×
              </button>
            )}
          </div>
          {recentFiles.map(p => (
            <div
              key={p}
              className={`file recent-item ${selectedFile === p ? 'selected' : ''}`}
              onClick={() => onSelectFile(p)}
              title={p}
            >
              <span className="file-icon">📄</span>
              <span className="file-name">{p.split('/').pop()}</span>
            </div>
          ))}
        </div>
      )}

      <div className="root-path">Root: {requestedPath}</div>

      {roots !== null && roots.roots.length > 0 && (
        <div className="roots-section">
          <div className="recent-header">Allowed roots</div>
          {roots.roots.map(r => {
            const removable = (roots.removableRoots ?? []).includes(r)
            return (
              <div key={r} className="file root-row" title={r}>
                <span className="file-icon">📁</span>
                <span className="file-name">{r.split('/').pop() || r}</span>
                {removable && (
                  <button
                    type="button"
                    className="root-remove"
                    onClick={() => void handleRemoveRoot(r)}
                    disabled={removingRoot !== ''}
                    title={`Stop allowing ${r}`}
                    aria-label={`Remove root ${r}`}
                  >
                    ×
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {rootError !== '' && <div className="tree-status error">{rootError}</div>}

      {showSearch ? (
        <div>
          {searching && <div className="tree-status">Searching…</div>}
          {!searching && searchError && <div className="tree-status error">{searchError}</div>}
          {!searching && !searchError && results !== null && results.length === 0 && (
            <div className="tree-status">No matches for “{query.trim()}”</div>
          )}
          {!searching && !searchError && matchedFiles.length > 0 && (
            <div className="replace-bar">
              <input
                value={replaceText}
                onChange={e => setReplaceText(e.target.value)}
                placeholder={`Replace “${query.trim()}” with…`}
                aria-label="Replacement text"
              />
              <button onClick={() => void handleReplaceAll()} disabled={replacing}>
                {replacing ? 'Replacing…' : `Replace in ${matchedFiles.length}`}
              </button>
            </div>
          )}
          {!searching && replaceSummary !== '' && <div className="tree-status">{replaceSummary}</div>}
          {results?.map(result => (
            <div key={result.path}>
              <div
                className={`file ${selectedFile === result.path ? 'selected' : ''}`}
                onClick={() => handleResultClick(result)}
              >
                <span className="file-icon">{result.isDirectory ? '📁' : '📄'}</span>
                <span className="file-name">{result.name}</span>
              </div>
              {result.matches?.map(match => (
                <div key={match.line} className="match-line">
                  <span className="match-no">{match.line}</span>
                  <span className="match-text">{match.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <>
          {loading && <div className="tree-status">Loading…</div>}
          {!loading && tree?.error && (
            <div className="tree-status error">
              <span>{tree.error}</span>
              {allowTarget !== '' && (
                <button
                  className="allow-folder-btn"
                  onClick={() => void handleAllowFolder()}
                  disabled={allowing}
                >
                  {allowing ? 'Opening…' : 'Open this folder'}
                </button>
              )}
            </div>
          )}
          {!loading && allowError !== '' && <div className="tree-status error">{allowError}</div>}
          {tree?.entries?.map(entry => (
            <TreeNode
              key={entry.path}
              entry={entry}
              parentPath={requestedPath}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              refreshKey={refreshKey}
              actions={actions}
              badges={rootBadges?.get(entry.name)}
            />
          ))}
        </>
      )}
    </div>
  )
}

export default FileExplorer
