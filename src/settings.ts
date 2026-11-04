// Editor preferences shared by the toolbar (zoom) and the settings drawer.
// Persisted as one JSON object under a single namespaced localStorage key so a
// "reset to defaults" is a single removeItem.

export type ThemeMode = 'system' | 'light' | 'dark'

export type Settings = {
  // Code-text zoom, % of the base size (toolbar ± buttons use steps of 10).
  zoom: number
  // Wrap long lines in the read view and editor (off = horizontal scroll).
  wordWrap: boolean
  // Extra mono font stack for code text; '' = system default (--mono).
  fontFamily: string
  // Theme override; 'system' follows prefers-color-scheme.
  theme: ThemeMode
}

export const MIN_ZOOM = 50
export const MAX_ZOOM = 200

export const DEFAULT_SETTINGS: Settings = {
  zoom: 80,
  wordWrap: true,
  fontFamily: '',
  theme: 'system'
}

const SETTINGS_KEY = 'app-test.settings'
const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark']

export function clampZoom(zoom: number): number {
  const n = Math.round(Number.isFinite(zoom) ? zoom : DEFAULT_SETTINGS.zoom)
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n))
}

function sanitize(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS }
  const obj = raw as Record<string, unknown>
  return {
    zoom: clampZoom(typeof obj.zoom === 'number' ? obj.zoom : DEFAULT_SETTINGS.zoom),
    wordWrap: typeof obj.wordWrap === 'boolean' ? obj.wordWrap : DEFAULT_SETTINGS.wordWrap,
    fontFamily:
      typeof obj.fontFamily === 'string' && obj.fontFamily.length <= 120 ? obj.fontFamily : DEFAULT_SETTINGS.fontFamily,
    theme: THEME_MODES.includes(obj.theme as ThemeMode) ? (obj.theme as ThemeMode) : DEFAULT_SETTINGS.theme
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return sanitize(JSON.parse(raw))
  } catch {
    // storage unavailable (private mode / SSR) or corrupted JSON; start fresh
    return { ...DEFAULT_SETTINGS }
  }
}

export function storeSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // storage unavailable; the preference just won't persist
  }
}

export function clearSettings(): void {
  try {
    localStorage.removeItem(SETTINGS_KEY)
  } catch {
    // ignore — nothing to clear when storage is unavailable
  }
}
