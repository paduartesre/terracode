import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clampZoom, clearSettings, DEFAULT_SETTINGS, loadSettings, storeSettings, type Settings } from './settings'

// Minimal in-memory localStorage for the node test environment.
function makeLocalStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  }
}

const KEY = 'app-test.settings'

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: makeLocalStorage(), configurable: true })
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage
})

describe('clampZoom', () => {
  it('keeps values inside the range', () => {
    expect(clampZoom(80)).toBe(80)
    expect(clampZoom(49)).toBe(50)
    expect(clampZoom(201)).toBe(200)
  })

  it('rounds and falls back to the default for non-finite input', () => {
    expect(clampZoom(76.4)).toBe(76)
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_SETTINGS.zoom)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SETTINGS.zoom)
  })
})

describe('loadSettings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips a stored object', () => {
    const s: Settings = { zoom: 120, wordWrap: false, fontFamily: 'Menlo, monospace', theme: 'dark' }
    storeSettings(s)
    expect(loadSettings()).toEqual(s)
  })

  it('clamps out-of-range and repairs invalid fields from stored JSON', () => {
    localStorage.setItem(KEY, JSON.stringify({ zoom: 999, wordWrap: 'yes', fontFamily: 42, theme: 'neon' }))
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, zoom: 200 })
  })

  it('falls back to defaults on corrupted JSON or non-object payloads', () => {
    localStorage.setItem(KEY, '{not json')
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    localStorage.setItem(KEY, '["array"]')
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    localStorage.setItem(KEY, 'null')
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('rejects an over-long font stack', () => {
    localStorage.setItem(KEY, JSON.stringify({ fontFamily: 'x'.repeat(121) }))
    expect(loadSettings().fontFamily).toBe('')
  })
})

describe('storeSettings / clearSettings', () => {
  it('stores under the namespaced key and clears it again', () => {
    storeSettings(DEFAULT_SETTINGS)
    expect(localStorage.getItem(KEY)).not.toBeNull()
    clearSettings()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('does not throw when storage is unavailable', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true })
    expect(() => storeSettings(DEFAULT_SETTINGS)).not.toThrow()
    expect(() => clearSettings()).not.toThrow()
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })
})
