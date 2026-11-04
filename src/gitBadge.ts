import type { GitStatusEntry } from './api'

export type GitBadge = {
  letter: string
  cls: string
}

// Map a porcelain XY status pair to a tree badge. Priority: deleted > renamed
// > modified > untracked/added; anything else (typechange, unmerged) falls back
// to the raw index code so it is still visible.
export function badgeForEntry(index: string, worktree: string): GitBadge | null {
  const x = index === ' ' ? '' : index
  const y = worktree === ' ' ? '' : worktree
  if (!x && !y) return null
  if (x === 'D' || y === 'D') return { letter: 'D', cls: 'git-d' }
  if (x === 'R' || x === 'C' || y === 'R') return { letter: 'R', cls: 'git-r' }
  if (x === 'M' || y === 'M') return { letter: 'M', cls: 'git-m' }
  if (y === '?' || x === 'A' || x === '?') return { letter: 'U', cls: 'git-u' }
  return { letter: x || y, cls: 'git-other' }
}

// Group badges by the first path segment — the tree row at this directory level
// that a status record affects (files directly here, or anything inside a folder).
export function badgesBySegment(entries: GitStatusEntry[]): Map<string, GitBadge[]> {
  const map = new Map<string, GitBadge[]>()
  for (const e of entries) {
    const seg = e.path.split('/')[0]
    if (!seg) continue
    const badge = badgeForEntry(e.index, e.worktree)
    if (!badge) continue
    const list = map.get(seg) ?? []
    if (!list.some(b => b.letter === badge.letter)) list.push(badge)
    map.set(seg, list)
  }
  return map
}

const BADGE_LABELS: Record<string, string> = {
  M: 'modified',
  U: 'untracked',
  D: 'deleted',
  R: 'renamed'
}

export function summarizeStatus(entries: GitStatusEntry[]): string {
  const counts = new Map<string, number>()
  for (const e of entries) {
    const badge = badgeForEntry(e.index, e.worktree)
    if (!badge) continue
    counts.set(badge.letter, (counts.get(badge.letter) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([letter, n]) => `${n} ${BADGE_LABELS[letter] ?? letter}`)
    .join(' · ')
}
