import { useState, type ReactElement } from 'react'
import { createEntry, getRegistryModule, readFileContent, saveFileContent, type RegistryModule } from './api'

// Well-known public modules as quick picks (namespace/name/provider).
const QUICK_PICKS = [
  'hashicorp/consul/aws',
  'terraform-aws-modules/vpc/aws',
  'terraform-aws-modules/s3-bucket/aws',
  'hashicorp/time/null'
]

// The file module blocks are appended to, inside the project directory.
const MODULES_FILE = 'modules-registry.tf'

type RegistryPanelProps = {
  dirPath: string
  // Called after a successful write so App can refresh open views (the SSE
  // watcher suppresses API-originated writes and would not echo them).
  onFileWritten?: (path: string) => void
}

// Parse "namespace/name/provider" — the standard way modules are referenced.
function parseModuleRef(input: string): { ns: string; name: string; provider: string } | null {
  const parts = input.trim().split('/').map(p => p.trim())
  if (parts.length !== 3 || parts.some(p => p === '')) return null
  return { ns: parts[0], name: parts[1], provider: parts[2] }
}

function moduleBlock(name: string, source: string, version: string): string {
  const lines = [`module "${name}" {`, `  source  = "${source}"`]
  if (version !== '') lines.push(`  version = "${version}"`)
  lines.push('}')
  return lines.join('\n')
}

const RegistryPanel = ({ dirPath, onFileWritten }: RegistryPanelProps): ReactElement => {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [module, setModule] = useState<RegistryModule | null>(null)
  const [version, setVersion] = useState('')
  const [error, setError] = useState('')
  const [writing, setWriting] = useState(false)
  const [writeMsg, setWriteMsg] = useState('')

  const lookup = async (ref: string) => {
    if (busy || writing) return
    const parsed = parseModuleRef(ref)
    if (!parsed) {
      setError('Enter the module as namespace/name/provider, e.g. hashicorp/consul/aws')
      setModule(null)
      return
    }
    setBusy(true)
    setError('')
    setWriteMsg('')
    setModule(null)
    try {
      const m = await getRegistryModule(parsed.ns, parsed.name, parsed.provider)
      setModule(m)
      setVersion(m.versions.length > 0 ? m.versions[0].version : '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lookup failed')
    } finally {
      setBusy(false)
    }
  }

  const targetPath = `${dirPath}/${MODULES_FILE}`

  // Append the module block to modules-registry.tf using the conflict-safe
  // write path (expectedMtimeMs rejects if the file changed since we read it).
  const insertModule = async () => {
    if (!module || writing) return
    setWriting(true)
    setError('')
    setWriteMsg('')
    try {
      let existing: string | null = null
      let mtimeMs: number | null = null
      try {
        const data = await readFileContent(targetPath)
        existing = data.content
        mtimeMs = data.mtimeMs
      } catch (err) {
        if (!(err instanceof Error && /404|not found/i.test(err.message))) throw err
        // File does not exist yet: create it, then read back for its mtime.
        await createEntry(targetPath, 'file')
        const data = await readFileContent(targetPath)
        existing = data.content
        mtimeMs = data.mtimeMs
      }
      if (existing !== null && new RegExp(`module\\s+"${module.name}"\\s*\\{`).test(existing)) {
        setWriteMsg(`A module "${module.name}" block already exists in ${MODULES_FILE} — nothing was written.`)
        return
      }
      const next = `${(existing ?? '').trimEnd()}${existing !== null && existing.trim() !== '' ? '\n\n' : ''}${moduleBlock(module.name, module.source, version)}\n`
      await saveFileContent(targetPath, next, mtimeMs ?? 0)
      setWriteMsg(`Added module "${module.name}" to ${MODULES_FILE}. Run Init to download it.`)
      onFileWritten?.(targetPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to write the module block')
    } finally {
      setWriting(false)
    }
  }

  return (
    <div className="tf-registry">
      <form
        className="tf-console-form"
        onSubmit={e => {
          e.preventDefault()
          void lookup(query)
        }}
      >
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="namespace/name/provider, e.g. hashicorp/consul/aws"
          aria-label="Module to look up in the Terraform registry"
          disabled={busy || writing}
        />
        <button type="submit" disabled={busy || writing || query.trim() === ''}>
          {busy ? 'Looking up…' : 'Look up'}
        </button>
      </form>

      <div className="tf-registry-picks">
        {QUICK_PICKS.map(ref => (
          <button key={ref} onClick={() => void lookup(ref)} disabled={busy || writing} title={`Look up ${ref}`}>
            {ref}
          </button>
        ))}
      </div>

      {module !== null && (
        <div className="tf-registry-result">
          <p className="tf-registry-source" title={module.source}>
            <code>{module.source}</code>
            {typeof module.downloads === 'number' ? ` · ${module.downloads.toLocaleString()} downloads` : ''}
          </p>
          {module.description !== undefined && <p className="tf-registry-desc">{module.description}</p>}
          {module.versions.length > 0 ? (
            <label className="tf-vf-label" title="Version pinned in the module block (latest first)">
              version
              <select value={version} onChange={e => setVersion(e.target.value)} disabled={writing}>
                {module.versions.map(v => (
                  <option key={v.version} value={v.version}>
                    {v.version}
                    {v.publishedAt ? ` · ${v.publishedAt.slice(0, 10)}` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="tf-status">No versions published for this module.</p>
          )}
          <button onClick={() => void insertModule()} disabled={writing || version === ''}>
            {writing ? 'Writing…' : `Add to ${MODULES_FILE}`}
          </button>
        </div>
      )}

      {error !== '' && <p className="tf-status error">{error}</p>}
      {writeMsg !== '' && <p className="tf-status ok">{writeMsg}</p>}
    </div>
  )
}

export default RegistryPanel
