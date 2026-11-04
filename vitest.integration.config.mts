import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    reporters: ['default', 'json', 'junit'],
    outputFile: { json: '.reports/integration.json', junit: '.reports/integration.xml' },
    testTimeout: 30_000,
    hookTimeout: 15_000
  }
})
