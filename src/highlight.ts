import hljs from 'highlight.js/lib/core'
import terraform from './languages/terraform'
import yaml from 'highlight.js/lib/languages/yaml'
import json from 'highlight.js/lib/languages/json'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import css from 'highlight.js/lib/languages/css'
import markdown from 'highlight.js/lib/languages/markdown'
import bash from 'highlight.js/lib/languages/bash'
import xml from 'highlight.js/lib/languages/xml'
import python from 'highlight.js/lib/languages/python'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import ini from 'highlight.js/lib/languages/ini'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import makefile from 'highlight.js/lib/languages/makefile'
import sql from 'highlight.js/lib/languages/sql'
import ruby from 'highlight.js/lib/languages/ruby'
import php from 'highlight.js/lib/languages/php'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'

hljs.registerLanguage('terraform', terraform)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('json', json)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('css', css)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('python', python)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('makefile', makefile)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('php', php)
hljs.registerLanguage('java', java)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)

const EXT_TO_LANGUAGE: Record<string, string> = {
  tf: 'terraform',
  tfvars: 'terraform',
  hcl: 'terraform',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  css: 'css',
  scss: 'css',
  less: 'css',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  py: 'python',
  go: 'go',
  rs: 'rust',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  sql: 'sql',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hh: 'cpp',
  hpp: 'cpp'
}

export function getLanguage(filePath: string): string | null {
  const name = filePath.split('/').pop() ?? ''
  const lower = name.toLowerCase()
  // Extensionless build files, matched by filename.
  if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile'
  if (lower.endsWith('dockerfile') || lower === 'containerfile') return 'dockerfile'
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return EXT_TO_LANGUAGE[name.slice(dot + 1).toLowerCase()] ?? null
}

export function highlightCode(content: string, filePath: string): string | null {
  const language = getLanguage(filePath)
  if (!language) return null
  try {
    return hljs.highlight(content, { language, ignoreIllegals: true }).value
  } catch {
    return null
  }
}
