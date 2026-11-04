import { describe, expect, it } from 'vitest'
import type { Entry } from './api'
import { collectFiles, type ListDirFn } from './fileIndex'

// In-memory directory tree: a name maps to null (a file) or another DirTree.
interface DirTree {
  [name: string]: DirTree | null
}

function buildListDir(root: string, tree: DirTree): ListDirFn {
  const map = new Map<string, Entry[]>()
  const walk = (dirPath: string, node: DirTree) => {
    const entries: Entry[] = Object.entries(node).map(([name, child]) => ({
      name,
      path: `${dirPath}/${name}`,
      isDirectory: child !== null
    }))
    map.set(dirPath, entries)
    for (const [name, child] of Object.entries(node)) {
      if (child !== null) walk(`${dirPath}/${name}`, child)
    }
  }
  walk(root, tree)
  return async dir => {
    const entries = map.get(dir)
    if (!entries) throw new Error(`ENOENT: ${dir}`)
    return entries
  }
}

const asSet = (paths: string[]) => [...paths].sort()

describe('collectFiles', () => {
  it('collects nested files with absolute paths', async () => {
    const listDir = buildListDir('/r', { a: { 'b.txt': null }, c: { d: { 'e.txt': null } }, 'top.txt': null })
    expect(asSet(await collectFiles(['/r'], listDir))).toEqual(['/r/a/b.txt', '/r/c/d/e.txt', '/r/top.txt'])
  })

  it('never enters skipped directories', async () => {
    const tree: DirTree = {
      'keep.txt': null,
      node_modules: { pkg: { 'index.js': null } },
      '.git': { config: null },
      dist: { 'bundle.js': null },
      src: { 'app.ts': null }
    }
    const listDir = buildListDir('/r', tree)
    expect(asSet(await collectFiles(['/r'], listDir))).toEqual(['/r/keep.txt', '/r/src/app.ts'])
  })

  it('stops at the entry cap', async () => {
    const tree: DirTree = {}
    for (let i = 0; i < 5; i++) tree[`f${i}.txt`] = null
    const listDir = buildListDir('/r', tree)
    expect(await collectFiles(['/r'], listDir, { maxEntries: 2 })).toHaveLength(2)
  })

  it('respects the depth limit (0 = files directly under the root only)', async () => {
    const tree: DirTree = { 'shallow.txt': null, deep: { deeper: { 'bottom.txt': null } }, mid: { 'file.txt': null } }
    const listDir = buildListDir('/r', tree)
    expect(asSet(await collectFiles(['/r'], listDir, { maxDepth: 0 }))).toEqual(['/r/shallow.txt'])
    expect(asSet(await collectFiles(['/r'], listDir, { maxDepth: 1 }))).toEqual(['/r/mid/file.txt', '/r/shallow.txt'])
  })

  it('unions multiple roots', async () => {
    const a = buildListDir('/a', { 'x.txt': null })
    const b = buildListDir('/b', { 'y.txt': null })
    // One listDir per root is not possible with the injected single function, so
    // merge both trees into one map-backed function.
    const merged: ListDirFn = async dir => (dir.startsWith('/a') ? a(dir) : b(dir))
    expect(asSet(await collectFiles(['/a', '/b'], merged))).toEqual(['/a/x.txt', '/b/y.txt'])
  })

  it('skips an unreadable directory instead of failing the whole index', async () => {
    const listDir: ListDirFn = async dir => {
      if (dir === '/r/broken') throw new Error('EACCES')
      return buildListDir('/r', { 'ok.txt': null, broken: { 'lost.txt': null }, fine: { 'kept.txt': null } })(dir)
    }
    expect(asSet(await collectFiles(['/r'], listDir))).toEqual(['/r/fine/kept.txt', '/r/ok.txt'])
  })

  it('returns an empty list for no roots', async () => {
    await expect(collectFiles([], buildListDir('/r', {}))).resolves.toEqual([])
  })
})
