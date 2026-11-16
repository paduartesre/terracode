// In-file search for the read-only file view. Line-level matches (line + 1-based
// column) so the UI can scroll to a row without touching its highlighted HTML —
// injecting <mark> into syntax-highlighted markup would break across tags.

export type TextMatch = { line: number; col: number }

// Cap so a one-character query in a huge file cannot build an unbounded list.
const MAX_MATCHES = 5000

export function findMatches(content: string, query: string): TextMatch[] {
  if (query === '') return []
  const matches: TextMatch[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
    let idx = lines[i].indexOf(query)
    while (idx !== -1 && matches.length < MAX_MATCHES) {
      matches.push({ line: i, col: idx + 1 })
      idx = lines[i].indexOf(query, idx + 1)
    }
  }
  return matches
}
