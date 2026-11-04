import { describe, expect, it } from 'vitest'
import { getLanguage, highlightCode } from './highlight'

describe('getLanguage', () => {
  it('maps terraform extensions to the custom terraform language', () => {
    expect(getLanguage('main.tf')).toBe('terraform')
    // .tf.json is JSON syntax but still a Terraform file; keep it as json.
    expect(getLanguage('variables.tfvars')).toBe('terraform')
    expect(getLanguage('config.hcl')).toBe('terraform')
  })

  it('maps common code extensions', () => {
    expect(getLanguage('a.ts')).toBe('typescript')
    expect(getLanguage('b.tsx')).toBe('typescript')
    expect(getLanguage('c.js')).toBe('javascript')
    expect(getLanguage('d.mjs')).toBe('javascript')
    expect(getLanguage('e.py')).toBe('python')
    expect(getLanguage('f.go')).toBe('go')
    expect(getLanguage('g.rs')).toBe('rust')
  })

  it('maps the newly added extensions', () => {
    expect(getLanguage('a.ini')).toBe('ini')
    expect(getLanguage('b.conf')).toBe('ini')
    expect(getLanguage('c.cfg')).toBe('ini')
    expect(getLanguage('d.sql')).toBe('sql')
    expect(getLanguage('e.rb')).toBe('ruby')
    expect(getLanguage('f.php')).toBe('php')
    expect(getLanguage('g.java')).toBe('java')
    expect(getLanguage('h.c')).toBe('c')
    expect(getLanguage('i.h')).toBe('c')
    expect(getLanguage('j.cpp')).toBe('cpp')
    expect(getLanguage('k.cc')).toBe('cpp')
  })

  it('matches extensionless build files by filename', () => {
    expect(getLanguage('Makefile')).toBe('makefile')
    expect(getLanguage('GNUmakefile')).toBe('makefile')
    expect(getLanguage('Dockerfile')).toBe('dockerfile')
    expect(getLanguage('web.dockerfile')).toBe('dockerfile')
    expect(getLanguage('Containerfile')).toBe('dockerfile')
  })

  it('is case-insensitive for extensions and filenames', () => {
    expect(getLanguage('MAIN.TF')).toBe('terraform')
    expect(getLanguage('DOCKERFILE')).toBe('dockerfile')
    expect(getLanguage('MakeFile')).toBe('makefile')
  })

  it('returns null for unknown or extensionless files', () => {
    expect(getLanguage('README')).toBeNull()
    expect(getLanguage('.gitignore')).toBeNull()
    expect(getLanguage('data.xyz123')).toBeNull()
    expect(getLanguage('noext')).toBeNull()
  })

  it('uses only the final path segment', () => {
    expect(getLanguage('/home/user/project/src/main.tf')).toBe('terraform')
    expect(getLanguage('a/b/c/Dockerfile')).toBe('dockerfile')
  })
})

describe('highlightCode', () => {
  it('returns highlighted HTML for a known language', () => {
    const html = highlightCode('resource "aws_s3_bucket" "b" {}\n', 'main.tf')
    expect(html).not.toBeNull()
    expect(html ?? '').toContain('hljs-')
  })

  it('returns null when the file type is not recognized', () => {
    expect(highlightCode('anything\n', 'data.xyz123')).toBeNull()
  })

  it('never throws on odd input and falls back to null', () => {
    expect(() => highlightCode('', 'empty.tf')).not.toThrow()
  })
})
