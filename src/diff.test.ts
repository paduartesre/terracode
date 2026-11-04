import { describe, expect, it } from 'vitest'
import { diffLines, type DiffLine } from './diff'

// Reconstruct old/new texts from a diff and assert they round-trip exactly.
function reconstruct(lines: DiffLine[]): { oldText: string; newText: string } {
  const oldParts: string[] = []
  const newParts: string[] = []
  for (const line of lines) {
    if (line.type !== 'added') oldParts.push(line.text)
    if (line.type !== 'removed') newParts.push(line.text)
  }
  return { oldText: oldParts.join('\n'), newText: newParts.join('\n') }
}

function expectRoundTrip(oldText: string, newText: string): DiffLine[] {
  const lines = diffLines(oldText, newText)
  const { oldText: o, newText: n } = reconstruct(lines)
  expect(o).toBe(oldText)
  expect(n).toBe(newText)
  return lines
}

describe('diffLines', () => {
  it('returns all-same for identical content', () => {
    const text = 'a\nb\nc'
    const lines = diffLines(text, text)
    expect(lines).toHaveLength(3)
    expect(lines.every(l => l.type === 'same')).toBe(true)
    expectRoundTrip(text, text)
  })

  it('detects a word replacement as remove + add', () => {
    const lines = expectRoundTrip('keep\nfoo bar\nbaz', 'keep\nfoo xar\nbaz')
    expect(lines.map(l => l.type)).toEqual(['same', 'removed', 'added', 'same'])
    expect(lines[1].text).toBe('foo bar')
    expect(lines[2].text).toBe('foo xar')
  })

  it('detects a line insertion in the middle', () => {
    const lines = expectRoundTrip('a\nb\nc', 'a\nNEW\nb\nc')
    expect(lines.map(l => l.type)).toEqual(['same', 'added', 'same', 'same'])
    expect(lines[1].newNo).toBe(2)
  })

  it('detects a line deletion', () => {
    const lines = expectRoundTrip('a\nb\nc', 'a\nc')
    expect(lines.map(l => l.type)).toEqual(['same', 'removed', 'same'])
    expect(lines[1].oldNo).toBe(2)
  })

  it('handles empty to content (untracked file)', () => {
    const lines = expectRoundTrip('', 'x\ny')
    // An empty old side has no lines, so everything is added — no phantom blank.
    expect(lines.map(l => l.type)).toEqual(['added', 'added'])
  })

  it('handles content to empty (deleted file)', () => {
    const lines = expectRoundTrip('x\ny', '')
    // An empty new side has no lines, so everything is removed — no phantom blank.
    expect(lines.map(l => l.type)).toEqual(['removed', 'removed'])
  })

  it('detects a trailing newline addition', () => {
    const lines = expectRoundTrip('a\nb', 'a\nb\n')
    expect(lines.at(-1)?.type).toBe('added')
    expect(lines.at(-1)?.text).toBe('')
  })

  it('detects a block move as remove + add (LCS has no move op)', () => {
    const lines = expectRoundTrip('a\nb\nc\nd', 'c\nd\na\nb')
    expect(lines.filter(l => l.type === 'removed')).toHaveLength(2)
    expect(lines.filter(l => l.type === 'added')).toHaveLength(2)
  })

  it('assigns correct old/new line numbers', () => {
    const lines = diffLines('one\ntwo\nthree', 'one\nTWO\nthree')
    expect(lines[1]).toMatchObject({ type: 'removed', oldNo: 2, newNo: null, text: 'two' })
    expect(lines[2]).toMatchObject({ type: 'added', oldNo: null, newNo: 2, text: 'TWO' })
  })

  it('degrades to remove-all/add-all above the size guard', () => {
    // 3001 * 1401 > 4_000_000 cells -> degraded path.
    const a = Array.from({ length: 3001 }, (_, i) => `old-${i}`).join('\n')
    const b = Array.from({ length: 1401 }, (_, i) => `new-${i}`).join('\n')
    const lines = diffLines(a, b)
    expect(lines).toHaveLength(3001 + 1401)
    expect(lines.slice(0, 3001).every(l => l.type === 'removed')).toBe(true)
    expect(lines.slice(3001).every(l => l.type === 'added')).toBe(true)
  })

  it('round-trips a realistic multi-hunk edit', () => {
    const oldText = [
      'resource "aws_s3_bucket" "logs" {',
      '  bucket = "app-logs"',
      '}',
      '',
      'output "arn" {',
      '  value = aws_s3_bucket.logs.arn',
      '}',
    ].join('\n')
    const newText = [
      'resource "aws_s3_bucket" "logs" {',
      '  bucket = "app-logs"',
      '  force_destroy = true',
      '}',
      '',
      'output "arn" {',
      '  value       = aws_s3_bucket.logs.arn',
      '  description = "Bucket ARN"',
      '}',
    ].join('\n')
    const lines = expectRoundTrip(oldText, newText)
    expect(lines.filter(l => l.type === 'added')).toHaveLength(3)
    expect(lines.filter(l => l.type === 'removed')).toHaveLength(1)
  })
})
