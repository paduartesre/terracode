import { defineConfig } from 'vitest/config'

// Temporary config to run the deep server integration suite (server.test.mjs),
// which is excluded from vitest.config.ts by its .mjs extension. Node env, no DOM.
export default defineConfig({
  test: {
    include: ['server.test.mjs'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
})
