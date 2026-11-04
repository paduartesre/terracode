export type DiffLine = {
  type: 'same' | 'added' | 'removed'
  oldNo: number | null
  newNo: number | null
  text: string
}

const MAX_CELLS = 4_000_000

export function diffLines(oldText: string, newText: string): DiffLine[] {
  // An empty string has no lines. ''.split('\n') yields [''], which would render
  // a phantom blank line for untracked (old='') or deleted (new='') files.
  const split = (s: string) => (s === '' ? [] : s.split('\n'))
  const a = split(oldText)
  const b = split(newText)
  const n = a.length
  const m = b.length

  if (n * m > MAX_CELLS) {
    // Too large for the LCS table; degrade to a remove-all/add-all view.
    const out: DiffLine[] = []
    for (let i = 0; i < n; i++) {
      out.push({ type: 'removed', oldNo: i + 1, newNo: null, text: a[i] })
    }
    for (let j = 0; j < m; j++) {
      out.push({ type: 'added', oldNo: null, newNo: j + 1, text: b[j] })
    }
    return out
  }

  // LCS table, filled bottom-up. Row i = a[i..], col j = b[j..].
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + (j + 1)] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', oldNo: i + 1, newNo: j + 1, text: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      out.push({ type: 'removed', oldNo: i + 1, newNo: null, text: a[i] })
      i++
    } else {
      out.push({ type: 'added', oldNo: null, newNo: j + 1, text: b[j] })
      j++
    }
  }
  while (i < n) {
    out.push({ type: 'removed', oldNo: i + 1, newNo: null, text: a[i] })
    i++
  }
  while (j < m) {
    out.push({ type: 'added', oldNo: null, newNo: j + 1, text: b[j] })
    j++
  }
  return out
}
