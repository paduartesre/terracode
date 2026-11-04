import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { listDir, listRoots, openFolder, type Entry } from './api'

type TfProjectPickerProps = {
  // Directory to start browsing from. When omitted (no project loaded yet), the
  // picker starts at the server's primary root.
  initialDir?: string
  onSelect: (dirPath: string) => void
  onClose: () => void
}

const RECENT_KEY = 'app-test.tf-recent-dirs'
const MAX_RECENT_DIRS = 5

function loadRecentDirs(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT_DIRS)
  } catch {
    return []
  }
}

function pushRecentDir(dirPath: string): string[] {
  const next = [dirPath, ...loadRecentDirs().filter(d => d !== dirPath)].slice(0, MAX_RECENT_DIRS)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // storage unavailable; recents just won't persist
  }
  return next
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) || p : p
}

// Path segments for the breadcrumb; a leading '/' is its own segment.
function pathSegments(dirPath: string): string[] {
  if (!dirPath.startsWith('/')) return [dirPath]
  const parts = dirPath.split('/').filter(Boolean)
  return ['/', ...parts]
}

// Drill-down folder browser for loading a Terraform project from a specific
// folder. Reuses the file API (listDir / openFolder), so folders outside the
// allowed roots get the same "Open this folder" flow as the working tree.
const TfProjectPicker = ({ initialDir, onSelect, onClose }: TfProjectPickerProps): ReactElement => {
  const [currentDir, setCurrentDir] = useState<string>(initialDir ?? '')
  const [inputValue, setInputValue] = useState<string>(initialDir ?? '')
  const [dirs, setDirs] = useState<Entry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Set when the server refused a folder as outside its allowed roots.
  const [allowTarget, setAllowTarget] = useState('')
  const [allowing, setAllowing] = useState(false)
  const [recentDirs, setRecentDirs] = useState<string[]>(loadRecentDirs)

  const loadDir = useCallback(async (dirPath: string) => {
    setLoading(true)
    setError('')
    try {
      const entries = await listDir(dirPath)
      setDirs(entries.filter(e => e.isDirectory))
      setCurrentDir(dirPath)
      setInputValue(dirPath)
      setAllowTarget('')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load folder'
      setError(message)
      if (message.includes('Access denied')) setAllowTarget(dirPath)
      else setAllowTarget('')
    } finally {
      setLoading(false)
    }
  }, [])

  // Start at the given folder, or (when no project is loaded yet) at the
  // server's primary root. Initial data fetch on mount: synchronizing with the
  // external backend.
  useEffect(() => {
    if (initialDir !== undefined && initialDir !== '') {
      void loadDir(initialDir) // eslint-disable-line react/set-state-in-effect
      return
    }
    let cancelled = false
    listRoots()
      .then(r => {
        const first = r.roots[0]
        if (!first) throw new Error('No server roots configured')
        if (!cancelled) void loadDir(first)
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to list folders')
      })
    return () => {
      cancelled = true
    }
  }, [initialDir, loadDir])

  // Esc closes the picker.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleAllow = async () => {
    if (!allowTarget || allowing) return
    setAllowing(true)
    setError('')
    try {
      await openFolder(allowTarget)
      void loadDir(allowTarget)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to allow folder')
    } finally {
      setAllowing(false)
    }
  }

  const handleSelect = () => {
    if (loading || error !== '') return
    setRecentDirs(pushRecentDir(currentDir))
    onSelect(currentDir)
  }

  const segments = pathSegments(currentDir)

  return (
    <div className="tf-picker-overlay" onClick={onClose}>
      <div
        className="tf-picker"
        role="dialog"
        aria-label="Load a Terraform project folder"
        onClick={e => e.stopPropagation()}
      >
        <h3>Load Terraform project</h3>
        <p className="tf-picker-hint">Pick the folder that contains your .tf files — all commands run there.</p>

        {recentDirs.length > 0 && (
          <div className="tf-picker-recent">
            {recentDirs.map(d => (
              <button key={d} onClick={() => void loadDir(d)} title={d}>
                {basename(d)}
              </button>
            ))}
          </div>
        )}

        <div className="tf-picker-breadcrumb">
          {segments.map((seg, i) => (
            <span key={`${i}:${seg}`}>
              {i > 0 && <span className="tf-picker-sep" aria-hidden="true">/</span>}
              <button onClick={() => void loadDir(segments.slice(0, i + 1).join('/'))} title={segments.slice(0, i + 1).join('/')}>
                {seg === '/' ? 'root' : seg}
              </button>
            </span>
          ))}
        </div>

        <div className="tf-picker-list">
          {loading && <p className="tf-picker-status">Loading…</p>}
          {!loading && error !== '' && (
            <>
              <p className="tf-picker-status error">{error}</p>
              {allowTarget !== '' && (
                <button onClick={() => void handleAllow()} disabled={allowing}>
                  {allowing ? 'Opening…' : 'Open this folder'}
                </button>
              )}
            </>
          )}
          {!loading && error === '' && dirs?.length === 0 && (
            <p className="tf-picker-status">No subfolders here — use “Load this folder” below.</p>
          )}
          {dirs?.map(d => (
            <button key={d.path} onClick={() => void loadDir(d.path)} title={d.path}>
              📁 {d.name}
            </button>
          ))}
        </div>

        <form
          className="tf-picker-form"
          onSubmit={e => {
            e.preventDefault()
            if (inputValue.trim() !== '') void loadDir(inputValue.trim())
          }}
        >
          <input
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            placeholder="/path/to/terraform/project"
            aria-label="Folder path"
          />
          <button type="submit">Go</button>
        </form>

        <div className="tf-picker-actions">
          <button onClick={handleSelect} disabled={loading || error !== ''}>
            Load this folder
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

export default TfProjectPicker
