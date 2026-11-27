import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  type TerminalSessionInfo, type TerminalStatus,
  closeTerminalSession, connectTerminalStream, createTerminalSession,
  getTerminalStatus, listTerminalSessions, resizeTerminal, restartTerminalSession, sendTerminalInput
} from './api'

type LiveTerm = {
  term: Terminal
  fit: FitAddon
  cancel: () => void
  applySize: () => void
  observer: ResizeObserver
}

const isLive = (s: TerminalSessionInfo) => s.state === 'starting' || s.state === 'running'

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

// Custom tab labels, keyed by session id. Sessions outlive a page reload while
// the server keeps running, so persist them (pruned to known sessions below).
const TAB_NAMES_KEY = 'terracode.terminal-tab-names'

function loadTabNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(TAB_NAMES_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [id, label] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof label === 'string' && label.length > 0) out[id] = label
    }
    return out
  } catch {
    // storage unavailable or corrupted; start with no custom labels
    return {}
  }
}

function statusText(s: TerminalSessionInfo): string {
  if (s.state === 'exited') {
    return s.exitStatus !== undefined ? `Shell exited with code ${s.exitStatus}` : 'Shell exited'
  }
  if (s.state === 'failed') return s.failReason ?? 'The terminal session failed to start'
  if (s.closeReason === 'timeout') return 'Terminal closed — no viewer connected within 15 seconds'
  if (s.closeReason === 'viewer-disconnect') return 'Terminal closed — the connection was lost'
  if (s.closeReason === 'slow-client') return 'Terminal closed — output could not be delivered in time'
  return s.closeReason ? `Terminal closed (${s.closeReason})` : 'Terminal closed'
}

// Optional interactive terminal below the editor. One xterm instance per
// session; minimizing only hides this panel (CSS), so the SSE connection and
// shell keep running and restoring shows the same session again. Each tab is
// bound to its own starting project — switching projects never redirects an
// existing shell, it just labels which directory each terminal lives in.
export default function TerminalPanel({ projectDir, open, onToggleOpen, height }: {
  projectDir: string | null
  open: boolean
  onToggleOpen: () => void
  height?: number
}) {
  const [status, setStatus] = useState<TerminalStatus | null>(null)
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [names, setNames] = useState<Record<string, string>>(loadTabNames)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  const liveRef = useRef(new Map<string, LiveTerm>())
  const hostRefs = useRef(new Map<string, HTMLDivElement>())
  const resizeTimer = useRef<number | null>(null)
  const createdForRef = useRef<Set<string>>(new Set()) // projects with an auto-created session

  const patchSession = useCallback((id: string, patch: Partial<TerminalSessionInfo>) => {
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)))
  }, [])

  // Persist custom labels so they survive a page reload (sessions outlive the UI
  // while the server keeps running), pruned to sessions that still exist so dead
  // ids never accumulate in storage.
  useEffect(() => {
    try {
      const ids = new Set(sessions.map(s => s.id))
      const kept: Record<string, string> = {}
      for (const [id, label] of Object.entries(names)) if (ids.has(id)) kept[id] = label
      localStorage.setItem(TAB_NAMES_KEY, JSON.stringify(kept))
    } catch {
      // storage unavailable; labels just won't persist
    }
  }, [names, sessions])

  const commitRename = useCallback((id: string, value: string) => {
    const label = value.trim()
    setNames(prev => {
      if ((prev[id] ?? '') === (label || '')) return prev // Enter + blur double-commit
      const next = { ...prev }
      if (label === '') delete next[id]
      else next[id] = label
      return next
    })
    setRenamingId(null)
  }, [])

  // Availability probe once on mount; restore whatever the server still holds.
  useEffect(() => {
    let cancelled = false
    getTerminalStatus()
      .then(st => {
        if (cancelled) return
        setStatus(st)
        if (!st.available) return
        listTerminalSessions().then(({ sessions: existing }) => {
          if (cancelled || existing.length === 0) return
          setSessions(existing) // the derived active tab picks the first live one
        }).catch(() => {})
      })
      .catch(() => {
        // API unreachable: the panel stays empty; the button is hidden anyway
        if (!cancelled) setStatus({ available: false, reason: 'Could not reach the terminal API', maxSessions: 4 })
      })
    return () => { cancelled = true }
  }, [])

  const attachLive = useCallback((s: TerminalSessionInfo) => {
    const host = hostRefs.current.get(s.id)
    if (!host || liveRef.current.has(s.id)) return
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      // Fixed dark palette (like a classic integrated terminal) in both app themes.
      theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
      scrollback: 2000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    let lastSent = { cols: -1, rows: -1 }
    const applySize = () => {
      try {
        fit.fit()
      } catch {
        // panel hidden or zero-sized; the open effect refits on restore
      }
      if (term.cols === lastSent.cols && term.rows === lastSent.rows) return
      lastSent = { cols: term.cols, rows: term.rows }
      void resizeTerminal(s.id, term.cols, term.rows).catch(() => {})
    }

    const cancel = connectTerminalStream(s.id, {
      onHello: (state, dir) => {
        if (!isLive({ ...s, state })) patchSession(s.id, { state, dir })
      },
      onReplay: text => term.write(text),
      onData: text => term.write(text),
      onExit: exitStatus => patchSession(s.id, { state: 'exited', ...(exitStatus !== null ? { exitStatus } : {}) }),
      onError: message => {
        term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
        patchSession(s.id, { state: 'failed', failReason: message })
      },
      onClose: reason => patchSession(s.id, { state: 'closed', closeReason: reason }),
    })

    const observer = new ResizeObserver(() => {
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current)
      resizeTimer.current = window.setTimeout(applySize, 150)
    })
    observer.observe(host)

    liveRef.current.set(s.id, { term, fit, cancel, applySize, observer })
    term.onData(data => {
      void sendTerminalInput(s.id, data).catch(() => {})
    })
    applySize()
  }, [patchSession])

  // Keep xterm instances in sync with the session list: attach live ones,
  // dispose dead or removed ones (closing a tab releases its stream + shell).
  useEffect(() => {
    const liveIds = new Set(sessions.filter(isLive).map(s => s.id))
    for (const [id, entry] of [...liveRef.current]) {
      if (!liveIds.has(id)) {
        entry.cancel()
        entry.observer.disconnect()
        entry.term.dispose()
        liveRef.current.delete(id)
        hostRefs.current.delete(id)
      }
    }
    for (const s of sessions) {
      if (isLive(s)) attachLive(s)
    }
  }, [sessions, attachLive])

  // Restoring a minimized panel: refit every live terminal to the new size.
  useEffect(() => {
    if (!open) return
    for (const entry of liveRef.current.values()) entry.applySize()
  }, [open])

  // First open with no live session: start a shell in the active project. The
  // ref guards against re-creating for a project whose terminal was closed;
  // state updates happen only in the async callbacks below.
  useEffect(() => {
    if (!open || status === null || !status.available) return
    if (sessions.some(isLive)) return
    if (projectDir === null || createdForRef.current.has(projectDir)) return
    createdForRef.current.add(projectDir)
    void createTerminalSession(projectDir)
      .then(created => {
        setSessions(prev => [...prev, created])
        setActiveId(created.id)
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Could not start the terminal'))
  }, [open, status, sessions, projectDir])

  // Unmount (page close): drop every stream so no shell outlives the UI.
  useEffect(() => () => {
    for (const entry of liveRef.current.values()) {
      entry.cancel()
      entry.observer.disconnect()
      entry.term.dispose()
    }
    liveRef.current.clear()
  }, [])

  const handleNew = useCallback(async () => {
    if (projectDir === null) return
    setCreating(true)
    setError('')
    try {
      const created = await createTerminalSession(projectDir)
      setSessions(prev => [...prev, created])
      setActiveId(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the terminal')
    } finally {
      setCreating(false)
    }
  }, [projectDir])

  const handleClose = useCallback(async (id: string) => {
    try {
      await closeTerminalSession(id)
    } catch {
      // already gone server-side; drop it locally either way
    }
    setSessions(prev => prev.filter(s => s.id !== id))
    setActiveId(current => (current === id ? null : current))
  }, [])

  const handleRestart = useCallback(async (id: string) => {
    setError('')
    try {
      await restartTerminalSession(id)
      // A fresh incarnation gets a fresh xterm: the sync effect disposes the
      // dead one and attaches a new terminal + stream for 'starting'.
      setSessions(prev => prev.map(s => (s.id === id ? { ...s, state: 'starting', exitStatus: undefined, failReason: undefined, closeReason: undefined } : s)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restart the terminal')
    }
  }, [])

  if (status === null) return null
  if (!status.available) {
    return (
      <div className="terminal-panel">
        <p className="terminal-unavailable">{status.reason ?? 'The terminal is unavailable on this server.'}</p>
      </div>
    )
  }

  // Explicit selection wins; otherwise the first live session (or any record,
  // so a reopened panel shows its status). Derived — no effect needed.
  const active = sessions.find(s => s.id === activeId) ?? sessions.find(isLive) ?? sessions[0] ?? null

  return (
    <section
      className={`terminal-panel${open ? '' : ' hidden'}`}
      style={height !== undefined ? { height } : undefined}
      aria-label="Integrated terminal"
    >
      <div className="terminal-header">
        <span className="terminal-title">Terminal</span>
        {sessions.map(s => {
          const label = names[s.id] ?? basename(s.dir)
          if (renamingId === s.id) {
            return (
              <input
                key={s.id}
                type="text"
                className="terminal-tab-rename"
                defaultValue={label}
                autoFocus
                aria-label={`Rename terminal in ${s.dir}`}
                onFocus={e => e.currentTarget.select()}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename(s.id, e.currentTarget.value)
                  else if (e.key === 'Escape') setRenamingId(null)
                }}
                onBlur={e => commitRename(s.id, e.currentTarget.value)}
              />
            )
          }
          return (
            <button
              key={s.id}
              type="button"
              className={`terminal-tab${s.id === activeId ? ' active' : ''}`}
              title={`${s.dir}${isLive(s) ? ` (${s.state})` : ''} — double-click to rename`}
              onClick={() => {
                setActiveId(s.id)
                liveRef.current.get(s.id)?.term.focus()
              }}
              onDoubleClick={() => setRenamingId(s.id)}
            >
              <span className={`terminal-dot${isLive(s) ? ' live' : ''}`} aria-hidden="true" />
              {label}
            </button>
          )
        })}
        <button
          type="button"
          className="terminal-new"
          onClick={() => void handleNew()}
          disabled={projectDir === null || creating || sessions.length >= status.maxSessions}
          title={
            projectDir === null
              ? 'Load a Terraform project first'
              : sessions.length >= status.maxSessions
                ? `Session limit reached (${status.maxSessions})`
                : `New terminal in ${projectDir}`
          }
        >
          +
        </button>
        <span className="terminal-spacer" />
        {active !== null && !isLive(active) && (
          <span className={`terminal-state${active.state === 'failed' ? ' failed' : ''}`} title={statusText(active)}>
            {active.state}
          </span>
        )}
        <button type="button" className="terminal-minimize" onClick={onToggleOpen} aria-label="Minimize terminal (keeps the shell running)" title="Minimize — the shell keeps running">
          –
        </button>
      </div>

      {error !== '' && <p className="terminal-error">{error}</p>}

      <div className="terminal-body">
        {sessions.length === 0 && (
          <p className="terminal-hint">
            {projectDir === null
              ? 'Load a Terraform project to start a shell in its directory.'
              : creating
                ? 'Starting the shell…'
                : 'No terminal sessions — use + to start one.'}
          </p>
        )}
        {sessions.map(s => (
          <div key={s.id} className={`terminal-host${s.id === activeId ? '' : ' hidden'}`}>
            {isLive(s) && (
              <div
                ref={el => {
                  if (el !== null) hostRefs.current.set(s.id, el)
                  else hostRefs.current.delete(s.id)
                }}
                className="terminal-xterm"
              />
            )}
            {!isLive(s) && (
              <div className="terminal-dead">
                <p>{statusText(s)}</p>
                {(s.state === 'exited' || s.state === 'failed') && (
                  <button type="button" onClick={() => void handleRestart(s.id)}>
                    Restart
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {sessions.length > 0 && active !== null && (
        <div className="terminal-footer">
          <span title={active.dir}>
            {basename(active.dir)}
            {projectDir !== null && active.dir !== projectDir ? ' — different from the loaded project' : ''}
          </span>
          <button type="button" onClick={() => void handleClose(active.id)} aria-label={`Close terminal in ${active.dir}`} title="Close this terminal (terminates its shell)">
            Close ×
          </button>
        </div>
      )}
    </section>
  )
}
