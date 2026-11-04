import type { LanguageFn } from 'highlight.js'

const terraform: LanguageFn = () => ({
  name: 'Terraform',
  aliases: ['tf'],
  keywords: [
    'resource',
    'variable',
    'output',
    'module',
    'data',
    'locals',
    'provider',
    'terraform',
    'backend',
    'required_providers',
    'lifecycle',
    'provisioner',
    'connection',
    'dynamic'
  ],
  contains: [
    { className: 'comment', begin: /#|\/\//, end: /$/, relevance: 0 },
    {
      className: 'string',
      begin: /"/,
      end: /"/,
      contains: [
        { begin: /\\./, relevance: 0 },
        { className: 'subst', begin: /\$\{/, end: /\}/ }
      ],
      relevance: 0
    },
    { className: 'number', begin: /\b\d+(\.\d+)?\b/ },
    { className: 'literal', begin: /\b(?:true|false|null)\b/ },
    { className: 'attr', begin: /\b[a-zA-Z_][a-zA-Z0-9_-]*(?=\s*=)/, relevance: 0 },
    { className: 'title', begin: /\b[a-zA-Z_][a-zA-Z0-9_.-]*(?=[(])/ }
  ]
})

export default terraform
