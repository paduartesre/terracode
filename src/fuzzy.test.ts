import { describe, expect, it } from 'vitest'
import { fuzzyScore, rankFiles } from './fuzzy'

describe('fuzzyScore', () => {
  it('scores an empty query as a neutral match', () => {
    expect(fuzzyScore('', 'anything')).toBe(1)
  })

  it('returns 0 when the query is not an ordered subsequence', () => {
    expect(fuzzyScore('xyz', 'abc')).toBe(0)
    // Order matters: "ba" is not a subsequence of "ab".
    expect(fuzzyScore('ba', 'ab')).toBe(0)
  })

  it('prefers consecutive matches over scattered ones', () => {
    expect(fuzzyScore('bcd', 'abcdef')).toBeGreaterThan(fuzzyScore('bdf', 'abcdef'))
  })

  it('gives a bonus when the first match starts at a word boundary', () => {
    // '/' before "app" is a boundary; 'x' is not.
    expect(fuzzyScore('app', '/src/app.tsx')).toBeGreaterThan(fuzzyScore('app', 'xapp.tsx'))
  })

  it('prefers shorter paths when the match quality ties', () => {
    expect(fuzzyScore('a', '/a')).toBeGreaterThan(fuzzyScore('a', '/aaaa'))
  })
})

describe('rankFiles', () => {
  const files = ['/repo/src/App.tsx', '/repo/docs/app-notes.md', '/repo/config.json']

  it('lists everything alphabetically for an empty query, recents first', () => {
    expect(rankFiles('', ['b.txt', 'a.txt', 'c.txt'], ['c.txt'])).toEqual(['c.txt', 'a.txt', 'b.txt'])
    expect(rankFiles('   ', files)).toEqual(['/repo/config.json', '/repo/docs/app-notes.md', '/repo/src/App.tsx'])
  })

  it('drops non-matching paths and ranks the best match first', () => {
    const ranked = rankFiles('app', files)
    expect(ranked).not.toContain('/repo/config.json')
    // "App.tsx" is an exact filename hit; "app-notes.md" matches mid-name.
    expect(ranked[0]).toBe('/repo/src/App.tsx')
    expect(ranked[1]).toBe('/repo/docs/app-notes.md')
  })

  it('matches on the bare filename even when the query only appears there', () => {
    const ranked = rankFiles('app', ['/x/y/zzz.txt', '/x/y/App.tsx'])
    expect(ranked).toEqual(['/x/y/App.tsx'])
  })

  it('is case-insensitive', () => {
    expect(rankFiles('APP', files)[0]).toBe('/repo/src/App.tsx')
  })
})
