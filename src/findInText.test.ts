import { describe, expect, it } from 'vitest'
import { findMatches } from './findInText'

describe('findMatches', () => {
  it('returns no matches for an empty query', () => {
    expect(findMatches('resource "a" {}\n', '')).toEqual([])
  })

  it('finds every occurrence per line with 1-based columns', () => {
    const content = 'foo bar foo\nbaz\nfoo'
    expect(findMatches(content, 'foo')).toEqual([
      { line: 0, col: 1 },
      { line: 0, col: 9 },
      { line: 2, col: 1 }
    ])
  })

  it('is case-sensitive and matches across the whole file', () => {
    expect(findMatches('Resource "x" {}\nresource "y" {}', 'resource')).toEqual([{ line: 1, col: 1 }])
  })

  it('handles multi-line queries as no-match (line-level search)', () => {
    expect(findMatches('a\nb', 'a\nb')).toEqual([])
  })

  it('caps the match count on pathological input', () => {
    const content = 'x'.repeat(20_000)
    expect(findMatches(content, 'x').length).toBeLessThanOrEqual(5000)
  })
})
