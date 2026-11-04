import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { listDir, listRoots } from './api'
import { collectFiles } from './fileIndex'
import { rankFiles } from './fuzzy'

type CommandPaletteProps = {
  // Bumped on external file-system changes so a still-open palette re-indexes.
  refreshKey: number
  recentFiles: string[]
  onSelect: (path: string) => void
  onClose: () => void
}

const MAX_RESULTS = 50

// Ctrl/Cmd+P overlay: fuzzy-jump to any file under the allowed roots. The index
// is built on open (and rebuilt when refreshKey changes while open).
const CommandPalette = ({ refreshKey, recentFiles, onSelect, onClose }: CommandPaletteProps) => {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // Re-indexes on open and whenever refreshKey changes while open. State is only
  // touched after the fetch settles, so a re-index briefly shows the previous list
  // (or "Indexing…" on first open) instead of flashing an empty state.
  useEffect(() => {
    let cancelled = false
    listRoots()
      .then(({ roots }) => collectFiles(roots, listDir))
      .then(list => {
        if (!cancelled) {
          setFiles(list)
          setError('')
        }
      })
      .catch(err => {
        if (!cancelled) {
          setFiles(null)
          setError(err instanceof Error ? err.message : 'Failed to index files')
        }
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const results = useMemo(() => (files === null ? [] : rankFiles(query, files, recentFiles).slice(0, MAX_RESULTS)), [query, files, recentFiles])

  // Keep the selection in view as it moves.
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected(s => Math.min(s + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected(s => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const path = results[selected]
      if (path) onSelect(path)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Go to file" onMouseDown={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          value={query}
          autoFocus
          placeholder="Jump to a file…"
          onChange={e => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={handleKeyDown}
        />
        <ul className="palette-list" ref={listRef}>
          {files === null && error === '' && <li className="palette-empty">Indexing files…</li>}
          {error !== '' && <li className="palette-empty">{error}</li>}
          {files !== null && error === '' && results.length === 0 && <li className="palette-empty">No matching files</li>}
          {results.map((path, i) => (
            <li
              key={path}
              className={`palette-item${i === selected ? ' active' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => onSelect(path)}
            >
              <span className="palette-name">{path.slice(path.lastIndexOf('/') + 1)}</span>
              <span className="palette-dir" title={path}>
                {path.slice(0, path.lastIndexOf('/'))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export default CommandPalette
