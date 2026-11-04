import { defineConfig } from 'vitest/config'

// Config to run the deep server integration suite (server.test.mjs),
// which is excluded from vitest.config.ts by its .mjs extension. Node env, no DOM.
export default defineConfig({
  test: {
    include: ['server.test.mjs'],
    environment: 'node',
    reporters: ['default', 'json', 'junit'],
    outputFile: { json: '.reports/backend.json', junit: '.reports/backend.xml' },
    coverage: {
      provider: 'v8',
      include: ['server.cjs'],
      reportsDirectory: 'coverage/backend',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportOnFailure: true,
      thresholds: { lines: 88, statements: 85, functions: 92, branches: 74 }
    },
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
})
