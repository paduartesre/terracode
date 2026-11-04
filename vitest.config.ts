import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['**/*.test.{ts,tsx}', '**/tests/**/*.test.{ts,tsx}'],
    globals: true,
    reporters: ['default', 'json', 'junit'],
    outputFile: { json: '.reports/frontend.json', junit: '.reports/frontend.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
      reportsDirectory: 'coverage/frontend',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportOnFailure: true,
      thresholds: { lines: 19, statements: 18, functions: 14, branches: 12 }
    }
  },
  resolve: {
    alias: {
      '@': '/src'
    }
  }
})
