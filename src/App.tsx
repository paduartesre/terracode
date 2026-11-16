import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import FileExplorer from './FileExplorer'
import FileEditor from './FileEditor'
import FileDiff from './FileDiff'
import TerraformPanel from './TerraformPanel'
import CommitView from './CommitView'
import GitPanel from './GitPanel'
import CommandPalette from './CommandPalette'
import SettingsPanel from './SettingsPanel'
import {
  getGitCommitDiff,
  getGitFileDiff,
  listDir,
  openFileEvents,
  openFolder,
  readFileContent,
  saveFileContent,
  type FileData,
  type GitCommitDiff,
  type GitFileDiff,
  type GitStatusResult
} from './api'
import { escapeHtml, highlightCode } from './highlight'
import { findMatches } from './findInText'
import { clampZoom, clearSettings, DEFAULT_SETTINGS, loadSettings, MAX_ZOOM, MIN_ZOOM, storeSettings, type Settings } from './settings'
import './App.css'

const MAX_RECENT_FILES = 8
const RECENT_STORAGE_KEY = 'terracode.recent-files'
const OPEN_TABS_KEY = 'terracode.open-tabs'
const MAX_OPEN_TABS = 32
const SIDEBAR_VIS_KEY = 'terracode.sidebar-visibility'

// The read-only view renders one row per line (for the line-number gutter).
// Above this many lines a single <pre> is far cheaper than thousands of rows,
// so huge files fall back to it without numbers.
const MAX_GUTTER_LINES = 2000

// Read-only rows for the line-number gutter: one self-contained HTML fragment
// per logical line (hljs never emits a tag spanning lines). Null when the file
// is too large for row rendering — then the plain <pre> fallback is used. The
// newline count avoids allocating the split array before the size check, so
// huge files bail out cheaply on every render.
function computeContentLines(loaded: { content: string; path: string } | null, highlighted: string | null): string[] | null {
  if (loaded === null || loaded.content === '') return null
  let newlines = 0
  for (let i = 0; i < loaded.content.length; i++) {
    if (loaded.content.charCodeAt(i) === 10) newlines++
  }
  if (newlines + 1 > MAX_GUTTER_LINES) return null
  const html = highlighted !== null ? highlighted : escapeHtml(loaded.content)
  return html.split('\n')
}

type SidebarVisibility = { left: boolean; right: boolean }

function loadSidebarVis(): SidebarVisibility {
  try {
    const raw = localStorage.getItem(SIDEBAR_VIS_KEY)
    if (!raw) return { left: true, right: true }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { left: true, right: true }
    const obj = parsed as Partial<SidebarVisibility>
    return {
      left: typeof obj.left === 'boolean' ? obj.left : true,
      right: typeof obj.right === 'boolean' ? obj.right : true
    }
  } catch {
    // corrupted storage; both sidebars visible
    return { left: true, right: true }
  }
}

// Sidebar widths (px) — user-adjustable by dragging each sidebar's inner edge.
const LEFT_WIDTH_KEY = 'terracode.left-sidebar-width'
const RIGHT_WIDTH_KEY = 'terracode.right-sidebar-width'
const DEFAULT_LEFT_WIDTH = 520
const DEFAULT_RIGHT_WIDTH = 360
const MIN_SIDEBAR_WIDTH = 240
// The center pane is never allowed to shrink below this while dragging.
const MIN_CENTER_WIDTH = 320

function loadStoredWidth(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= MIN_SIDEBAR_WIDTH ? n : fallback
  } catch {
    // storage unavailable; fall back to the default width
    return fallback
  }
}

function storeWidth(key: string, width: number): void {
  try {
    localStorage.setItem(key, String(width))
  } catch {
    // storage unavailable (private mode); the preference just won't persist
  }
}

function dirOf(filePath: string): string {
  const i = filePath.lastIndexOf('/')
  return i > 0 ? filePath.slice(0, i) : '/'
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

// Per-tab editor state. All of a tab's data lives here (not in component-local
// state), so switching tabs never loses an unsaved draft — only the transient
// textarea cursor resets, matching the previous single-file behavior.
type TabState = {
  path: string
  loaded: FileData | null
  error: string // '' when there is no load/save error for this tab
  editing: boolean
  draft: string
  reviewing: boolean
  saving: boolean
  saveState: 'idle' | 'saved'
  gitDiff: GitFileDiff | null
  gitDiffError: string
  gitDiffLoading: boolean
}

function newTab(path: string): TabState {
  return {
    path,
    loaded: null,
    error: '',
    editing: false,
    draft: '',
    reviewing: false,
    saving: false,
    saveState: 'idle',
    gitDiff: null,
    gitDiffError: '',
    gitDiffLoading: false
  }
}

function isDirty(t: TabState): boolean {
  return t.editing && t.loaded !== null && t.draft !== t.loaded.content
}

type OpenTabsStore = { paths: string[]; active?: string }

function loadOpenTabs(): OpenTabsStore {
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY)
    if (!raw) return { paths: [] }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { paths: [] }
    const obj = parsed as OpenTabsStore
    const paths = Array.isArray(obj.paths) ? obj.paths.filter((p): p is string => typeof p === 'string') : []
    const active = typeof obj.active === 'string' && paths.includes(obj.active) ? obj.active : undefined
    return { paths: paths.slice(0, MAX_OPEN_TABS), active }
  } catch {
    // corrupted storage; start fresh
    return { paths: [] }
  }
}

function loadRecentFiles(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT_FILES)
  } catch {
    // corrupted storage; start fresh
    return []
  }
}

function App() {
  const [tabs, setTabs] = useState<TabState[]>(() => loadOpenTabs().paths.map(newTab))
  const [activePath, setActivePath] = useState<string>(() => {
    const store = loadOpenTabs()
    return store.active ?? store.paths[0] ?? ''
  })
  const [recentFiles, setRecentFiles] = useState<string[]>(loadRecentFiles)
  const [treeBump, setTreeBump] = useState(0)

  // Editor preferences (zoom / word-wrap / font family / theme), persisted as one
  // object under a single localStorage key. Zoom is % of the inherited size and is
  // applied to .content-body only, so code scales while sidebars stay fixed-size.
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const patchSettings = useCallback((patch: Partial<Settings>) => {
    setSettings(prev => ({ ...prev, ...patch }))
  }, [])

  // Settings drawer (left sidebar footer).
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Command palette (Ctrl/Cmd+P) and per-sidebar visibility (Ctrl+B / Ctrl+Shift+B),
  // persisted so a hidden sidebar stays hidden across reloads.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sidebarVis, setSidebarVis] = useState<SidebarVisibility>(loadSidebarVis)

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_VIS_KEY, JSON.stringify(sidebarVis))
    } catch {
      // storage unavailable; visibility just won't persist
    }
  }, [sidebarVis])

  const toggleLeftSidebar = useCallback(() => setSidebarVis(v => ({ ...v, left: !v.left })), [])
  const toggleRightSidebar = useCallback(() => setSidebarVis(v => ({ ...v, right: !v.right })), [])

  // Global shortcuts: Ctrl/Cmd+P opens the palette; Ctrl+B / Ctrl+Shift+B toggle
  // the sidebars. Runs regardless of focus (the palette input handles its own keys).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const key = e.key.toLowerCase()
      if (!e.shiftKey && key === 'p') {
        e.preventDefault()
        setPaletteOpen(true)
      } else if (key === 'b' && !e.shiftKey) {
        e.preventDefault()
        toggleLeftSidebar()
      } else if (key === 'b' && e.shiftKey) {
        e.preventDefault()
        toggleRightSidebar()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleLeftSidebar, toggleRightSidebar])

  // Terraform Log view: the active file path, or an empty string when no file
  // is open (null = closed). Switching files closes the view automatically.
  const [tfLogPath, setTfLogPath] = useState<string | null>(null)
  const tfLogOpen = tfLogPath === activePath

  // In-file search (Find): one open/closed state shared by the editor and the
  // read-only view. Driven by the Find button next to the drift badge, the
  // status-bar buttons, or Ctrl+F. Each view keeps its own query text.
  const [fileFindOpen, setFileFindOpen] = useState(false)

  // Read-only find: the query lives with the bar; the match position is keyed by
  // (file, query) so a new search or file switch starts at the first match during
  // render — no effect needed to reset state. The row container ref scrolls a
  // matched line into view.
  const [roQuery, setRoQuery] = useState('')
  const [roNav, setRoNav] = useState<{ key: string; idx: number }>({ key: '', idx: 0 })
  const roRowsRef = useRef<HTMLDivElement | null>(null)
  const roKey = `${activePath}\u0000${roQuery}`
  const roMatchIdx = roNav.key === roKey ? roNav.idx : 0

  // Terraform project folder explicitly loaded via the panel's picker (null =
  // follow the open file's folder). Persisted so a reload keeps the same project.
  const [tfProjectDir, setTfProjectDir] = useState<string | null>(() => {
    try {
      return localStorage.getItem('terracode.tf-project-dir')
    } catch {
      return null
    }
  })

  useEffect(() => {
    try {
      if (tfProjectDir === null) localStorage.removeItem('terracode.tf-project-dir')
      else localStorage.setItem('terracode.tf-project-dir', tfProjectDir)
    } catch {
      // storage unavailable; the project just won't persist across reloads
    }
  }, [tfProjectDir])

  // Bumped when the project folder is re-allowed as a root, forcing the panel
  // to remount and re-fetch version/state data that failed before.
  const [tfRootNonce, setTfRootNonce] = useState(0)

  const handleLoadTfProject = useCallback((dir: string | null) => {
    setTfProjectDir(dir)
    if (dir !== null) setTreeBump(b => b + 1) // refresh the tree's allowed-roots list
  }, [])

  // Ensure the loaded project folder is an allowed root. Runtime-added roots do
  // not survive a server restart, so a persisted project may point at a folder
  // the API no longer reaches: re-allow it, then refresh both panels (the tree
  // via treeBump, the Terraform panel by remounting through tfKey).
  useEffect(() => {
    if (!tfProjectDir) return
    let cancelled = false
    listDir(tfProjectDir).catch(err => {
      if (cancelled || !(err instanceof Error && err.message.includes('Access denied'))) return
      openFolder(tfProjectDir)
        .then(() => {
          if (!cancelled) {
            setTfRootNonce(n => n + 1)
            setTreeBump(b => b + 1)
          }
        })
        .catch(() => {})
    })
    return () => {
      cancelled = true
    }
  }, [tfProjectDir])

  // Step 2: a commit's per-file diff shown in the main area (read-only overlay).
  const [commitView, setCommitView] = useState<GitCommitDiff | null>(null)
  const [commitLoading, setCommitLoading] = useState(false)
  const [commitError, setCommitError] = useState('')

  // Git context reported up by FileExplorer (the browsed folder + its git status),
  // so the dedicated right-hand Git sidebar can render independently of the tree.
  const [gitCtx, setGitCtx] = useState<{ dirPath: string; status: GitStatusResult | null }>({
    dirPath: '',
    status: null
  })

  // Refs mirroring the latest state for use inside stable callbacks/effects.
  const tabsRef = useRef(tabs)
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])
  const activePathRef = useRef(activePath)
  useEffect(() => {
    activePathRef.current = activePath
  }, [activePath])

  // Sidebar widths in px, persisted per browser. Dragging clamps each width so the
  // center pane never disappears and the other sidebar stays reachable.
  const [leftWidth, setLeftWidth] = useState(() => loadStoredWidth(LEFT_WIDTH_KEY, DEFAULT_LEFT_WIDTH))
  const [rightWidth, setRightWidth] = useState(() => loadStoredWidth(RIGHT_WIDTH_KEY, DEFAULT_RIGHT_WIDTH))
  const containerRef = useRef<HTMLDivElement | null>(null)
  const resizingRef = useRef<'left' | 'right' | null>(null)
  // Refs mirror the widths so endResize persists the exact value even if the last
  // drag frame's effect hasn't run yet (moveResize updates them synchronously).
  const leftWidthRef = useRef(leftWidth)
  useEffect(() => {
    leftWidthRef.current = leftWidth
  }, [leftWidth])
  const rightWidthRef = useRef(rightWidth)
  useEffect(() => {
    rightWidthRef.current = rightWidth
  }, [rightWidth])

  const startResize = useCallback(
    (side: 'left' | 'right') => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      resizingRef.current = side
      document.body.classList.add('sb-resizing')
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [],
  )

  const moveResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const side = resizingRef.current
    if (side === null) return
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (side === 'left') {
      const max = Math.max(MIN_SIDEBAR_WIDTH, rect.width - rightWidthRef.current - MIN_CENTER_WIDTH)
      const w = Math.min(Math.max(e.clientX - rect.left, MIN_SIDEBAR_WIDTH), max)
      leftWidthRef.current = w
      setLeftWidth(w)
    } else {
      const max = Math.max(MIN_SIDEBAR_WIDTH, rect.width - leftWidthRef.current - MIN_CENTER_WIDTH)
      const w = Math.min(Math.max(rect.right - e.clientX, MIN_SIDEBAR_WIDTH), max)
      rightWidthRef.current = w
      setRightWidth(w)
    }
  }, [])

  const endResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const side = resizingRef.current
    if (side === null) return
    resizingRef.current = null
    document.body.classList.remove('sb-resizing')
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // capture already released; nothing to do
    }
    storeWidth(side === 'left' ? LEFT_WIDTH_KEY : RIGHT_WIDTH_KEY, side === 'left' ? leftWidthRef.current : rightWidthRef.current)
  }, [])

  const resetLeftWidth = useCallback(() => {
    setLeftWidth(DEFAULT_LEFT_WIDTH)
    storeWidth(LEFT_WIDTH_KEY, DEFAULT_LEFT_WIDTH)
  }, [])

  const resetRightWidth = useCallback(() => {
    setRightWidth(DEFAULT_RIGHT_WIDTH)
    storeWidth(RIGHT_WIDTH_KEY, DEFAULT_RIGHT_WIDTH)
  }, [])

  // Derived view state for the active tab, computed early so effects can depend on it.
  const active = tabs.find(t => t.path === activePath) ?? null
  const loadingActive = active !== null && active.loaded === null && active.error === ''
  const errorActive = active?.error ?? ''
  const commitActive = commitView !== null || commitLoading

  // Read-only view: plain file content on screen (no diff/review overlay).
  const readOnlyView =
    !commitActive &&
    active !== null &&
    active.loaded !== null &&
    !loadingActive &&
    errorActive === '' &&
    !active.editing &&
    active.gitDiff === null &&
    active.loaded.content !== ''

  // Effective Terraform working directory: the explicitly loaded project wins;
  // otherwise follow the open file's folder (null when neither exists — the
  // panel then offers to load a project). The key remounts the panel per dir so
  // results never leak across folders.
  const tfDir = tfProjectDir ?? (active !== null && active.loaded !== null ? dirOf(active.path) : null)
  // The nonce suffix remounts the panel after its folder is re-allowed as a root.
  const tfKey = `${tfProjectDir ?? (tfDir !== null ? `file:${tfDir}` : 'none')}#${tfRootNonce}`

  const updateTab = useCallback(
    (path: string, patch: Partial<TabState> | ((t: TabState) => Partial<TabState>)) => {
      setTabs(ts => ts.map(t => (t.path === path ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)))
    },
    [],
  )

  // Fire-and-forget content load. A stale response for a since-closed tab is a
  // no-op because updateTab maps over the current tab list and finds nothing.
  const loadTab = useCallback(
    (path: string) => {
      readFileContent(path)
        .then(data => updateTab(path, { loaded: data, error: '' }))
        .catch(err => updateTab(path, { error: err instanceof Error ? err.message : 'Failed to read file' }))
    },
    [updateTab],
  )

  // Load content for any restored tab that has no data yet (once on mount).
  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    for (const t of tabs) {
      if (t.loaded === null && t.error === '') void loadTab(t.path)
    }
  }, [tabs, loadTab])

  const handleSelectFile = useCallback(
    (filePath: string) => {
      const exists = tabsRef.current.some(t => t.path === filePath)
      setTabs(ts => (ts.some(t => t.path === filePath) ? ts : [...ts, newTab(filePath)]))
      setActivePath(filePath)
      if (!exists) void loadTab(filePath)
      // Selecting a file returns to the file view from any open commit overlay.
      setCommitView(null)
      setCommitError('')
      setRecentFiles(prev => [filePath, ...prev.filter(p => p !== filePath)].slice(0, MAX_RECENT_FILES))
    },
    [loadTab],
  )

  const closeTab = useCallback((path: string) => {
    const ts = tabsRef.current
    const tab = ts.find(t => t.path === path)
    if (tab && isDirty(tab) && !window.confirm('Discard unsaved changes?')) return
    const idx = ts.findIndex(t => t.path === path)
    const next = ts.filter(t => t.path !== path)
    setTabs(next)
    if (path === activePathRef.current) {
      setActivePath(next.length ? next[Math.max(0, Math.min(idx, next.length - 1))].path : '')
    }
  }, [])

  const startEdit = useCallback(
    (path: string) => {
      const t = tabsRef.current.find(x => x.path === path)
      if (!t || t.loaded === null || t.error !== '') return
      updateTab(path, { editing: true, draft: t.loaded.content, reviewing: false, saveState: 'idle', gitDiff: null })
    },
    [updateTab],
  )

  const cancelEdit = useCallback(
    (path: string) => {
      const t = tabsRef.current.find(x => x.path === path)
      if (!t) return
      if (isDirty(t) && !window.confirm('Discard unsaved changes?')) return
      updateTab(path, { editing: false, reviewing: false, error: '' })
    },
    [updateTab],
  )

  const discardDraft = useCallback(
    (path: string) => {
      const t = tabsRef.current.find(x => x.path === path)
      if (!t || !window.confirm('Discard your edits and revert to the saved version?')) return
      updateTab(path, { draft: t.loaded?.content ?? '', reviewing: false, error: '' })
    },
    [updateTab],
  )

  const saveFile = useCallback(
    async (path: string) => {
      const t = tabsRef.current.find(x => x.path === path)
      if (!t || t.loaded === null || t.saving) return
      updateTab(path, { saving: true })
      try {
        const result = await saveFileContent(t.loaded.path, t.draft, t.loaded.mtimeMs)
        updateTab(path, {
          loaded: { path: result.path, content: t.draft, mtimeMs: result.mtimeMs },
          error: '',
          editing: false,
          reviewing: false,
          saveState: 'saved',
          saving: false
        })
      } catch (err) {
        updateTab(path, { error: err instanceof Error ? err.message : 'Failed to save file', saving: false })
      }
    },
    [updateTab],
  )

  const toggleGitDiff = useCallback(
    async (path: string) => {
      const t = tabsRef.current.find(x => x.path === path)
      if (!t || t.loaded === null) return
      if (t.gitDiff !== null && t.gitDiff.path === t.loaded.path) {
        updateTab(path, { gitDiff: null })
        return
      }
      updateTab(path, { gitDiffLoading: true, gitDiffError: '' })
      try {
        const dir = dirOf(t.loaded.path)
        const file = t.loaded.path.slice(dir.length + 1)
        const gd = await getGitFileDiff(dir, file)
        updateTab(path, { gitDiff: gd, gitDiffLoading: false })
      } catch (err) {
        updateTab(path, { gitDiff: null, gitDiffError: err instanceof Error ? err.message : 'Failed to load git diff', gitDiffLoading: false })
      }
    },
    [updateTab],
  )

  const reloadFromDisk = useCallback(
    (path: string) => {
      const t = tabsRef.current.find(x => x.path === path)
      if (!t) return
      if (isDirty(t) && !window.confirm('Discard your edits and reload the file from disk?')) return
      updateTab(path, { editing: false, reviewing: false, error: '', saveState: 'idle', loaded: null })
      void loadTab(path)
    },
    [updateTab, loadTab],
  )

  // External file changes (terraform fmt rewrites, another editor, git ops):
  // refresh the tree and reload any open tab that changed on disk (only when it
  // has no unsaved edits).
  const handleExternalChanges = useCallback(
    (changedPaths: string[]) => {
      setTreeBump(key => key + 1)
      for (const p of changedPaths) {
        const t = tabsRef.current.find(x => x.path === p)
        if (t && !t.editing) void loadTab(p)
      }
    },
    [loadTab],
  )

  // Keep a single EventSource alive across re-renders.
  const externalChangesRef = useRef(handleExternalChanges)
  useEffect(() => {
    externalChangesRef.current = handleExternalChanges
  })
  useEffect(() => openFileEvents(paths => externalChangesRef.current(paths)), [])

  // Keep open tabs in sync when the tree renames or deletes them.
  const handleEntryRenamed = useCallback((oldPath: string, newPath: string) => {
    setTabs(ts => ts.map(t => (t.path === oldPath ? { ...t, path: newPath, loaded: t.loaded ? { ...t.loaded, path: newPath } : null } : t)))
    if (activePathRef.current === oldPath) setActivePath(newPath)
  }, [])

  const handleEntryDeleted = useCallback((deletedPath: string) => {
    const ts = tabsRef.current
    const next = ts.filter(t => !(t.path === deletedPath || t.path.startsWith(deletedPath + '/')))
    setTabs(next)
    if (next.length === 0) setActivePath('')
    else if (!next.some(t => t.path === activePathRef.current)) setActivePath(next[0].path)
  }, [])

  // Step 2: open a commit's per-file diff in the main area.
  const handleOpenCommit = useCallback(async (dirPath: string, hash: string) => {
    setCommitLoading(true)
    setCommitError('')
    try {
      const data = await getGitCommitDiff(dirPath, hash)
      setCommitView(data)
    } catch (err) {
      setCommitView(null)
      setCommitError(err instanceof Error ? err.message : 'Failed to load commit')
    } finally {
      setCommitLoading(false)
    }
  }, [])

  const handleCloseCommit = useCallback(() => {
    setCommitView(null)
    setCommitError('')
  }, [])

  // FileExplorer reports the browsed folder + its git status here. The identity
  // check avoids re-render loops when the same values are reported again.
  const handleGitContext = useCallback((dirPath: string, status: GitStatusResult | null) => {
    setGitCtx(prev => (prev.dirPath === dirPath && prev.status === status ? prev : { dirPath, status }))
  }, [])

  // Warn before leaving the window while any tab has unsaved edits.
  const anyDirty = tabs.some(isDirty)
  useEffect(() => {
    if (!anyDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [anyDirty])

  // Keyboard shortcuts for the active tab only: Ctrl/Cmd+S saves, Esc cancels.
  useEffect(() => {
    if (!activePath) return
    const t0 = tabsRef.current.find(t => t.path === activePath)
    if (!t0 || !t0.editing) return
    const handler = (e: KeyboardEvent) => {
      const t = tabsRef.current.find(x => x.path === activePath)
      if (!t) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (isDirty(t) && !t.saving) void saveFile(activePath)
        return
      }
      if (e.key === 'Escape' && !t.saving) {
        if (t.reviewing) updateTab(activePath, { reviewing: false })
        else cancelEdit(activePath)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activePath, active?.editing, saveFile, cancelEdit, updateTab])

  // Esc closes the git diff view of the active tab (the editor's own Esc runs while editing).
  useEffect(() => {
    if (!activePath) return
    const t0 = tabsRef.current.find(t => t.path === activePath)
    if (!t0 || t0.gitDiff === null || t0.editing) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') updateTab(activePath, { gitDiff: null })
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activePath, active?.gitDiff, active?.editing, updateTab])

  // Persist recent files and the set of open tabs (paths only; content is re-fetched).
  useEffect(() => {
    try {
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recentFiles))
    } catch {
      // storage unavailable (private mode); recents just won't persist
    }
  }, [recentFiles])

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_TABS_KEY, JSON.stringify({ paths: tabs.map(t => t.path), active: activePath || undefined }))
    } catch {
      // storage unavailable; open tabs just won't persist
    }
  }, [tabs, activePath])

  useEffect(() => {
    storeSettings(settings)
  }, [settings])

  // Theme override: a class on <html> that redefines the CSS variables and the
  // hardcoded dark-mode rules (see index.css / App.css). No class = follow OS.
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('theme-light', 'theme-dark')
    if (settings.theme !== 'system') root.classList.add(`theme-${settings.theme}`)
  }, [settings.theme])

  const handleResetSettings = () => {
    clearSettings()
    setSettings({ ...DEFAULT_SETTINGS })
  }

  // Only rendered in read-only view (never while editing), so recomputing on each
  // render is cheap enough to skip manual memoization.
  const highlighted = active?.loaded ? highlightCode(active.loaded.content, active.loaded.path) : null

  // Read-only rows for the line-number gutter (see computeContentLines). Like
  // `highlighted` above it is recomputed per render — cheap for the ≤2000-line
  // files that use it.
  const contentLines = computeContentLines(active?.loaded ?? null, highlighted)

  // Find is available whenever the open file's content can be searched: the
  // read-only rows view (line-level scrolling needs the row layout) or the
  // editor. Diff/review/commit views have no find target.
  const findAvailable =
    (readOnlyView && contentLines !== null) ||
    (active !== null && active.editing && !loadingActive && errorActive === '' && active.gitDiff === null && !active.reviewing)

  // Read-only search matches for the current query (line-level, see findInText).
  // Recomputed per render like `highlighted` above — indexOf-based, and only
  // runs while the read-only view is open with a non-empty query.
  const roMatches = readOnlyView && roQuery !== '' && active?.loaded ? findMatches(active.loaded.content, roQuery) : []

  // Scroll a read-only match into view. Called from the navigation handlers
  // (rows are always rendered, so no effect is needed to wait for a re-render).
  const scrollToRoMatch = (idx: number) => {
    const m = roMatches[idx]
    if (m !== undefined) {
      ;(roRowsRef.current?.children[m.line] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
    }
  }

  // Global Ctrl/Cmd+F opens the file find bar (the editor's textarea handles its
  // own shortcut and prevents this from double-firing). Skipped while typing in
  // any other input so browser search stays available there.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (!findAvailable) return
      e.preventDefault()
      setFileFindOpen(true)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [findAvailable])

  // Shared inline style for both .content-body regions: code zoom plus the user's
  // font stack (as a CSS var consumed by the code viewer/editor rules).
  const contentBodyStyle = {
    fontSize: `${settings.zoom}%`,
    ...(settings.fontFamily !== '' ? ({ '--user-mono': settings.fontFamily } as CSSProperties) : {}),
  } as CSSProperties

  return (
    <>
      <header className="app-header">
        <img className="app-logo" src="/terracode-header.png" alt="Terra Code logo" />
      </header>

      <div className="app-container" ref={containerRef}>
      {sidebarVis.left && (
        <>
          <aside className="file-explorer" style={{ flexBasis: leftWidth }}>
            <h3>Working Tree</h3>
            <FileExplorer
              onSelectFile={handleSelectFile}
              selectedFile={activePath}
              recentFiles={recentFiles}
              onClearRecentFiles={() => setRecentFiles([])}
              requestedRoot={tfProjectDir}
              onEntryRenamed={handleEntryRenamed}
              onEntryDeleted={handleEntryDeleted}
              externalRefresh={treeBump}
              onGitContext={handleGitContext}
            />
            <button
              type="button"
              className={`settings-toggle${settingsOpen ? ' open' : ''}`}
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen(o => !o)}
            >
              Settings
            </button>
            {settingsOpen && (
              <SettingsPanel settings={settings} onChange={patchSettings} onReset={handleResetSettings} />
            )}
          </aside>

          <div
            className="sb-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the left sidebar"
            title="Drag to resize — double-click to reset (Ctrl+B hides this sidebar)"
            onPointerDown={startResize('left')}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onDoubleClick={resetLeftWidth}
          />
        </>
      )}

      <main className="app-content">
        {commitActive ? (
          <div className={`content-body${settings.wordWrap ? '' : ' wrap-off'}`} style={contentBodyStyle}>
            <CommitView data={commitView} loading={commitLoading} error={commitError} onClose={handleCloseCommit} />
          </div>
        ) : active !== null ? (
          <>
            <div className="tab-bar" role="tablist">
              {tabs.map(t => (
                <div
                  key={t.path}
                  role="tab"
                  aria-selected={t.path === activePath}
                  className={`tab${t.path === activePath ? ' active' : ''}`}
                  onClick={() => setActivePath(t.path)}
                  title={t.path}
                >
                  <span className="tab-name">{basename(t.path)}</span>
                  {isDirty(t) && (
                    <span className="tab-dirty" title="Unsaved changes">
                      ●
                    </span>
                  )}
                  <button
                    type="button"
                    className="tab-close"
                    onClick={e => {
                      e.stopPropagation()
                      closeTab(t.path)
                    }}
                    aria-label={`Close ${basename(t.path)}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {active.loaded !== null && !loadingActive && (
              <div className="editor-toolbar">
                <span className="file-path">{active.loaded.path}</span>
                <span className="zoom-controls" title="Zoom applies to the code text only">
                  <button
                    type="button"
                    className="zoom-btn"
                    aria-label="Zoom out code"
                    disabled={settings.zoom <= MIN_ZOOM}
                    onClick={() => patchSettings({ zoom: clampZoom(settings.zoom - 10) })}
                  >
                    −
                  </button>
                  <span className="zoom-level">{settings.zoom}%</span>
                  <button
                    type="button"
                    className="zoom-btn"
                    aria-label="Zoom in code"
                    disabled={settings.zoom >= MAX_ZOOM}
                    onClick={() => patchSettings({ zoom: clampZoom(settings.zoom + 10) })}
                  >
                    +
                  </button>
                </span>
                {active.editing ? (
                  <>
                    <span className={`save-state${isDirty(active) ? ' dirty' : ''}`}>
                      {active.saving ? 'Saving…' : isDirty(active) ? 'Unsaved changes' : 'No changes'}
                    </span>
                    <button onClick={() => void saveFile(active.path)} disabled={!isDirty(active) || active.saving}>
                      Save
                    </button>
                    {!active.reviewing && (
                      <button onClick={() => updateTab(active.path, { reviewing: true })} disabled={!isDirty(active) || active.saving}>
                        Diff
                      </button>
                    )}
                    {active.reviewing && (
                      <button onClick={() => updateTab(active.path, { reviewing: false })} disabled={active.saving}>
                        Edit
                      </button>
                    )}
                    {active.reviewing && (
                      <button onClick={() => discardDraft(active.path)} disabled={!isDirty(active) || active.saving}>
                        Discard
                      </button>
                    )}
                    <button onClick={() => cancelEdit(active.path)} disabled={active.saving}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    {active.saveState === 'saved' && <span className="save-state">Saved</span>}
                    <button onClick={() => startEdit(active.path)} disabled={errorActive !== ''}>
                      Edit
                    </button>
                    <button onClick={() => void toggleGitDiff(active.path)} disabled={active.gitDiffLoading || errorActive !== ''}>
                      {active.gitDiffLoading ? 'Loading…' : active.gitDiff?.path === active.loaded.path ? 'Close Diff' : 'Git Diff'}
                    </button>
                  </>
                )}
              </div>
            )}

            <div
              className={`content-body${tfLogOpen ? ' tf-log-mode' : ''}${settings.wordWrap ? '' : ' wrap-off'}`}
              style={contentBodyStyle}
            >
            <TerraformPanel
              key={tfKey}
              dirPath={tfDir}
              projectDir={tfProjectDir}
              onLoadProject={handleLoadTfProject}
              onFmtApplied={handleExternalChanges}
              logOpen={tfLogOpen}
              onToggleLog={() => setTfLogPath(p => (p === activePath ? null : activePath))}
              onOpenLog={() => setTfLogPath(activePath)}
              findAvailable={findAvailable}
              findActive={fileFindOpen}
              onToggleFind={() => setFileFindOpen(o => !o)}
            />

            {/* Code area — hidden while the Terraform Log view is open */}
            {!tfLogOpen && (
              <>
            {loadingActive && <p className="file-status">Loading…</p>}
            {errorActive !== '' && (
              <>
                <p className="file-status error">{errorActive}</p>
                {active.editing && (
                  <button className="toolbar-button" onClick={() => reloadFromDisk(active.path)}>
                    Reload from disk
                  </button>
                )}
              </>
            )}

            {active.gitDiffError !== '' && <p className="file-status error">{active.gitDiffError}</p>}
            {!loadingActive && active.gitDiff !== null && !active.editing && (
              <FileDiff
                oldContent={active.gitDiff.oldContent}
                newContent={active.gitDiff.newContent}
                hint={active.gitDiff.untracked ? 'untracked file — all lines added' : 'changes vs HEAD'}
              />
            )}
            {!loadingActive && active.loaded !== null && active.editing && active.reviewing && (
              <FileDiff oldContent={active.loaded.content} newContent={active.draft} />
            )}
            {!loadingActive && active.loaded !== null && active.editing && !active.reviewing && (
              // key remounts the editor per file so cursor/search state resets.
              <FileEditor
                key={active.path}
                value={active.draft}
                filePath={active.path}
                wrap={settings.wordWrap}
                onChange={d => updateTab(active.path, { draft: d })}
                findOpen={fileFindOpen}
                onFindRequest={() => setFileFindOpen(true)}
                onFindToggle={() => setFileFindOpen(o => !o)}
                onFindClose={() => setFileFindOpen(false)}
                onToggleWrap={() => patchSettings({ wordWrap: !settings.wordWrap })}
              />
            )}
            {!loadingActive && errorActive === '' && active.loaded !== null && !active.editing && active.gitDiff === null && active.loaded.content !== '' && (
              <>
                {fileFindOpen && contentLines !== null && (
                  <div className="find-bar">
                    <input
                      autoFocus
                      value={roQuery}
                      onChange={e => {
                        const q = e.target.value
                        setRoQuery(q)
                        // Jump to the first match as the query is typed (IDE behavior).
                        if (q !== '' && active?.loaded) {
                          const ms = findMatches(active.loaded.content, q)
                          if (ms.length > 0) {
                            ;(roRowsRef.current?.children[ms[0].line] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
                          }
                        }
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          if (roMatches.length > 0) {
                            const next = (roMatchIdx + 1) % roMatches.length
                            setRoNav({ key: roKey, idx: next })
                            scrollToRoMatch(next)
                          }
                        } else if (e.key === 'Escape') {
                          e.stopPropagation()
                          setFileFindOpen(false)
                        }
                      }}
                      placeholder="Find"
                      aria-label="Find in file"
                    />
                    <span className={`find-count${roQuery !== '' && roMatches.length === 0 ? ' none' : ''}`}>
                      {roQuery === '' ? '' : roMatches.length === 0 ? 'no matches' : `${(roMatchIdx % roMatches.length) + 1}/${roMatches.length}`}
                    </span>
                    <button
                      onClick={() => {
                        if (roMatches.length === 0) return
                        const prev = (roMatchIdx - 1 + roMatches.length) % roMatches.length
                        setRoNav({ key: roKey, idx: prev })
                        scrollToRoMatch(prev)
                      }}
                    >
                      Prev
                    </button>
                    <button
                      onClick={() => {
                        if (roMatches.length === 0) return
                        const next = (roMatchIdx + 1) % roMatches.length
                        setRoNav({ key: roKey, idx: next })
                        scrollToRoMatch(next)
                      }}
                    >
                      Next
                    </button>
                    <button title="Close find bar (Esc)" onClick={() => setFileFindOpen(false)}>
                      ×
                    </button>
                  </div>
                )}
                {contentLines !== null ? (
                  // One row per logical line: the gutter number stays glued to its
                  // first visual line even when soft-wrap reflows it. --fc-digits is
                  // the DIGIT COUNT of the last line number (2 for 24 lines, 3 for
                  // 100), which sizes the gutter column.
                  <div className="file-content-rows" style={{ '--fc-digits': String(contentLines.length).length } as CSSProperties} ref={roRowsRef}>
                    {contentLines.map((lineHtml, i) => (
                      <div key={i} className="fc-row">
                        <span className="fc-ln" aria-hidden="true">
                          {i + 1}
                        </span>
                        <span className="fc-code" dangerouslySetInnerHTML={{ __html: lineHtml === '' ? '&nbsp;' : lineHtml }} />
                      </div>
                    ))}
                  </div>
                ) : (
                  // Very large files: plain pre, no gutter.
                  <pre className="file-content">
                    {highlighted !== null ? (
                      <code dangerouslySetInnerHTML={{ __html: highlighted }} />
                    ) : (
                      active.loaded.content
                    )}
                  </pre>
                )}
              </>
            )}
            {!loadingActive && errorActive === '' && active.loaded !== null && !active.editing && active.gitDiff === null && active.loaded.content === '' && (
              <p className="file-status">(empty file)</p>
            )}
              </>
            )}
            </div>
          </>
        ) : (
          // No open tabs: the Terraform panel still renders — with the loaded
          // project if there is one, otherwise in "load a project" mode.
          <div className={`content-body${tfLogOpen ? ' tf-log-mode' : ''}`}>
            <TerraformPanel
              key={`empty:${tfProjectDir ?? 'none'}#${tfRootNonce}`}
              dirPath={tfProjectDir}
              projectDir={tfProjectDir}
              onLoadProject={handleLoadTfProject}
              onFmtApplied={handleExternalChanges}
              logOpen={tfLogOpen}
              onToggleLog={() => setTfLogPath(p => (p === activePath ? null : activePath))}
              onOpenLog={() => setTfLogPath(activePath)}
            />
          </div>
        )}
      </main>

      {gitCtx.dirPath !== '' && sidebarVis.right && (
        <>
          <div
            className="sb-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the right sidebar"
            title="Drag to resize — double-click to reset (Ctrl+Shift+B hides this sidebar)"
            onPointerDown={startResize('right')}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onDoubleClick={resetRightWidth}
          />
          <aside className="git-sidebar" style={{ flexBasis: rightWidth }}>
            <h3>Git</h3>
            {/* key remounts the panel per browsed folder so branch/log state resets. */}
            <GitPanel
              key={gitCtx.dirPath}
              dirPath={gitCtx.dirPath}
              isRepo={gitCtx.status?.isRepo ?? false}
              entries={gitCtx.status?.entries ?? []}
              refreshKey={treeBump}
              onRefresh={() => setTreeBump(k => k + 1)}
              onOpenCommit={(dir, hash) => void handleOpenCommit(dir, hash)}
              openCommitHash={commitView?.hash ?? null}
            />
          </aside>
        </>
      )}

      {paletteOpen && (
        <CommandPalette
          refreshKey={treeBump}
          recentFiles={recentFiles}
          onSelect={path => {
            handleSelectFile(path)
            setPaletteOpen(false)
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      </div>
    </>
  )
}

export default App
