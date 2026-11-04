// Fuzzy subsequence ranking for the command palette (Ctrl/Cmd+P). Pure and
// dependency-free so it can be unit-tested without a DOM.

const WORD_BOUNDARY = '/.-_ '

/**
 * Score how well `query` matches `text` as an ordered, case-insensitive
 * subsequence. Returns 0 when the query is not a subsequence; higher is better.
 * An empty query scores 1 (everything matches).
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  if (q === '') return 1
  const t = text.toLowerCase()

  let score = 0
  let prevIdx = -1
  for (const ch of q) {
    const idx = t.indexOf(ch, prevIdx + 1)
    if (idx === -1) return 0
    // Consecutive matches are worth more than scattered ones.
    score += prevIdx >= 0 && idx === prevIdx + 1 ? 4 : 1
    // A match starting at a word boundary (start, '/', '.', '-', '_', ' ') is a
    // strong signal — it usually means the query hit a path segment or filename.
    if (idx === 0 || WORD_BOUNDARY.includes(t[idx - 1])) score += 3
    prevIdx = idx
  }
  // Prefer shorter paths on ties (a deep copy of the same name ranks lower).
  return score - t.length * 0.01
}

/**
 * Rank file paths against a query: best fuzzy match first, alphabetical as the
 * tie-breaker. Paths that do not match are dropped. With an empty query every
 * path matches; `recent` (when given) is listed first, then the rest alphabetically.
 */
export function rankFiles(query: string, files: string[], recent?: string[]): string[] {
  const q = query.trim()
  if (q === '') {
    const recents = new Set(recent ?? [])
    return [...files].sort((a, b) => {
      const ra = recents.has(a) ? 0 : 1
      const rb = recents.has(b) ? 0 : 1
      if (ra !== rb) return ra - rb
      return a.localeCompare(b)
    })
  }

  const scored: { path: string; score: number }[] = []
  for (const file of files) {
    // Score the full path and the bare filename, keeping the better one — typing
    // "app" should find "src/App.tsx" even though 'a' is mid-path.
    const name = file.slice(file.lastIndexOf('/') + 1)
    const score = Math.max(fuzzyScore(q, file), fuzzyScore(q, name))
    if (score > 0) scored.push({ path: file, score })
  }
  return scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path.localeCompare(b.path))).map(s => s.path)
}
