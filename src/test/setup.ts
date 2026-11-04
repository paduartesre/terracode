import '@testing-library/jest-dom/vitest'

// Mock localStorage for tests that use it
const storage = {} as Record<string, string>
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, val: string) => { storage[key] = val },
    removeItem: (key: string) => { delete storage[key] },
    clear: () => { Object.keys(storage).forEach(k => delete storage[k]) }
  },
  writable: true
})

// Mock EventSource for tests that use it
class MockEventSource {
  url: string
  onmessage: ((e: any) => void) | null = null
  constructor(url: string) { this.url = url }
  close() {}
}
Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource, writable: true })
