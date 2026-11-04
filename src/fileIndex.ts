// Builds a flat list of file paths under one or more roots for the command
// palette. The directory listing function is injected so the walker can be unit-
// tested without a server; production passes api.listDir.

import type { Entry } from './api'

export type ListDirFn = (dirPath: string) => Promise<Entry[]>

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.terraform'])
const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_MAX_DEPTH = 16

export type FileIndexOptions = {
  maxEntries?: number
  maxDepth?: number
}

/**
 * Breadth-first walk of `roots`, collecting absolute file paths. Directories in
 * SKIP_DIRS are never entered; the walk stops once `maxEntries` files are found
 * or `maxDepth` levels below a root are reached. A directory that fails to list
 * is skipped (its subtree is lost) rather than failing the whole index.
 */
export async function collectFiles(roots: string[], listDir: ListDirFn, opts?: FileIndexOptions): Promise<string[]> {
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH

  const files: string[] = []
  // Queue of [dirPath, depthBelowRoot]. BFS keeps the walk level-by-level so a
  // huge tree hits the entry cap quickly instead of descending one branch deep.
  const queue: { dir: string; depth: number }[] = roots.map(dir => ({ dir, depth: 0 }))

  while (queue.length > 0 && files.length < maxEntries) {
    const level = queue.splice(0, queue.length)
    const results = await Promise.all(
      level.map(async entry => {
        try {
          return await listDir(entry.dir)
        } catch {
          return null // unreadable directory; skip its subtree
        }
      }),
    )

    for (let i = 0; i < results.length && files.length < maxEntries; i++) {
      const entries = results[i]
      if (!entries) continue
      for (const e of entries) {
        if (files.length >= maxEntries) break
        if (e.isDirectory) {
          if (SKIP_DIRS.has(e.name)) continue
          if (level[i].depth + 1 <= maxDepth) queue.push({ dir: e.path, depth: level[i].depth + 1 })
        } else {
          files.push(e.path)
        }
      }
    }
  }

  return files
}
