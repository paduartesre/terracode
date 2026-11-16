import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type UIEvent } from 'react'
import { escapeHtml, highlightCode } from './highlight'

type FileEditorProps = {
  value: string
  filePath: string
  // Soft-wrap long lines. The line-number gutter cannot stay aligned with wrapped
  // rows in the overlay layout, so it is hidden while wrapping is on.
  wrap?: boolean
  onChange: (value: string) => void
  // Find-bar open state is controlled by App so the toolbar "Find" button (next
  // to the drift badge) can drive it from any view mode.
  findOpen: boolean
  onFindRequest: () => void // Ctrl+F in the textarea — always opens
  onFindToggle: () => void // status-bar button
  onFindClose: () => void // × / Esc
  onToggleWrap?: () => void
}

const FileEditor = ({ value, filePath, wrap = false, onChange, findOpen, onFindRequest, onFindToggle, onFindClose, onToggleWrap }: FileEditorProps): ReactElement => {
  const preRef = useRef<HTMLPreElement>(null)
  const gutterRef = useRef<HTMLPreElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })

  // In-file search/replace state (the bar's open/closed state lives in App).
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')

  // Note: per-file state reset happens via the `key` prop in App.tsx, which
  // remounts this component when the open file changes.

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus()
  }, [findOpen])

  const matchCount = useMemo(
    () => (query === '' ? 0 : value.split(query).length - 1),
    [value, query],
  )

  // Scroll the textarea so the line containing `index` sits a few lines from
  // the top. The onScroll handler keeps the highlight/gutter overlays in sync.
  const scrollToIndex = (el: HTMLTextAreaElement, index: number) => {
    const line = value.slice(0, index).split('\n').length
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 24
    const target = Math.max(0, (line - 3) * lh)
    el.scrollTop = Math.min(target, el.scrollHeight - el.clientHeight)
  }

  // Select the next occurrence of `query` at/after the caret (wrapping around).
  // Returns the match start index, or -1 when there is no match.
  const findNext = (): number => {
    const el = taRef.current
    if (!el || query === '') return -1
    const from = Math.max(el.selectionEnd ?? 0, 0)
    let idx = value.indexOf(query, from)
    if (idx === -1) idx = value.indexOf(query) // wrap to the start
    if (idx === -1) return -1
    el.focus()
    el.setSelectionRange(idx, idx + query.length)
    scrollToIndex(el, idx)
    updateCursor(el)
    return idx
  }

  const replaceOne = () => {
    const el = taRef.current
    if (!el || query === '') return
    let start = el.selectionStart ?? 0
    let end = el.selectionEnd ?? 0
    if (value.slice(start, end) !== query) {
      const found = findNext()
      if (found === -1) return
      start = found
      end = found + query.length
    }
    onChange(value.slice(0, start) + replacement + value.slice(end))
    requestAnimationFrame(() => {
      el.selectionStart = start
      el.selectionEnd = start + replacement.length
    })
  }

  const replaceAll = () => {
    if (query === '') return
    const parts = value.split(query)
    if (parts.length <= 1) return
    onChange(parts.join(replacement))
  }

  const totalLines = useMemo(() => value.split('\n').length, [value])

  const highlightedHtml = useMemo(() => {
    const html = highlightCode(value, filePath)
    const base = html !== null ? html : escapeHtml(value)
    // A trailing newline produces an extra (empty) line in the textarea;
    // mirror it so the overlay keeps the same height and line positions.
    return value.endsWith('\n') ? `${base}\n` : base
  }, [value, filePath])

  const gutterText = useMemo(
    () => Array.from({ length: totalLines }, (_, i) => String(i + 1)).join('\n'),
    [totalLines],
  )

  // Gutter width scales with the digit count of the last line number.
  // Shared via CSS var so .editor-wrap's margin-left matches exactly. Zero while
  // wrapping (the gutter is hidden, see below).
  const shellStyle = {
    '--gutter-w': wrap ? '0px' : `calc(${String(totalLines).length} * 0.65em + 1.3rem)`,
  } as CSSProperties

  const updateCursor = (el: HTMLTextAreaElement) => {
    // Use el.value, not the `value` prop: during a change event the prop is
    // still the previous render's value.
    const upToCaret = el.value.slice(0, el.selectionStart ?? 0).split('\n')
    setCursor({ line: upToCaret.length, col: upToCaret[upToCaret.length - 1].length + 1 })
  }

  const handleScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (preRef.current !== null) {
      preRef.current.scrollTop = e.currentTarget.scrollTop
      preRef.current.scrollLeft = e.currentTarget.scrollLeft
    }
    if (gutterRef.current !== null) {
      gutterRef.current.scrollTop = e.currentTarget.scrollTop
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      onFindRequest()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const el = e.currentTarget
      const start = el.selectionStart
      const end = el.selectionEnd
      onChange(`${value.slice(0, start)}  ${value.slice(end)}`)
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 2
      })
    }
  }

  return (
    <div>
      {findOpen && (
        <div className="find-bar">
          <input
            ref={findInputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') findNext()
              else if (e.key === 'Escape') {
                e.stopPropagation()
                onFindClose()
              }
            }}
            placeholder="Find"
            aria-label="Find in file"
          />
          <span className={`find-count${matchCount === 0 ? ' none' : ''}`}>
            {query === '' ? '' : `${matchCount} match${matchCount === 1 ? '' : 'es'}`}
          </span>
          <input
            value={replacement}
            onChange={e => setReplacement(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') replaceOne()
              else if (e.key === 'Escape') {
                e.stopPropagation()
                onFindClose()
              }
            }}
            placeholder="Replace with"
            aria-label="Replace with"
          />
          <button onClick={() => findNext()}>Next</button>
          <button onClick={replaceOne}>Replace</button>
          <button onClick={replaceAll}>All</button>
          <button title="Close find bar (Esc)" onClick={onFindClose}>
            ×
          </button>
        </div>
      )}
      <div className="editor-shell" style={shellStyle}>
        {!wrap && (
          <pre ref={gutterRef} className="editor-gutter" aria-hidden="true">
            {gutterText}
          </pre>
        )}
        <div className={`editor-wrap${wrap ? ' editor-wrap-on' : ''}`}>
          <pre ref={preRef} className="editor-highlight" aria-hidden="true">
            <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
          </pre>
          <textarea
            ref={taRef}
            className="editor-input"
            value={value}
            onChange={e => {
              onChange(e.target.value)
              updateCursor(e.currentTarget)
            }}
            onSelect={e => updateCursor(e.currentTarget)}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={`Edit ${filePath}`}
          />
        </div>
      </div>
      <div className="editor-status">
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <span>{totalLines} lines</span>
        {onToggleWrap !== undefined && (
          <button
            type="button"
            className={`find-toggle${wrap ? ' active' : ''}`}
            onClick={onToggleWrap}
            title={wrap ? 'Word wrap is on — line numbers are hidden. Click to turn wrap off and show them.' : 'Click to soft-wrap long lines (hides the line-number gutter).'}
          >
            {wrap ? 'wrap on' : 'wrap off'}
          </button>
        )}
        {!findOpen && (
          <button className="find-toggle" onClick={onFindToggle}>
            Find (Ctrl+F)
          </button>
        )}
      </div>
    </div>
  )
}

export default FileEditor
