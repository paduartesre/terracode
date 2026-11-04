export type Entry = {
  name: string
  path: string
  isDirectory: boolean
}

const API_BASE = 'http://localhost:3001'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = init ? await fetch(url, init) : await fetch(url)
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // non-JSON error body; keep the default message
    }
    throw new Error(message)
  }
  return (await res.json()) as T
}

export function listDir(dirPath: string): Promise<Entry[]> {
  return request<Entry[]>(`${API_BASE}/api/files?path=${encodeURIComponent(dirPath)}`)
}

export type FileData = {
  path: string
  content: string
  mtimeMs: number
}

export function readFileContent(filePath: string): Promise<FileData> {
  return request<FileData>(`${API_BASE}/api/file-content?path=${encodeURIComponent(filePath)}`)
}

export type SaveResult = {
  path: string
  mtimeMs: number
  size: number
}

export function saveFileContent(
  filePath: string,
  content: string,
  expectedMtimeMs: number,
): Promise<SaveResult> {
  return request<SaveResult>(`${API_BASE}/api/file-content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content, mtimeMs: expectedMtimeMs })
  })
}

export type SearchMatch = {
  line: number
  text: string
}

export type SearchResult = {
  name: string
  path: string
  isDirectory: boolean
  mtimeMs?: number
  matches?: SearchMatch[]
}

// Optional search filters. regex treats the query as a regular expression;
// caseSensitive makes literal matching case-sensitive (regex uses /i otherwise);
// ext restricts results to files with one of these extensions ("ts,tsx").
export type SearchOptions = {
  regex?: boolean
  caseSensitive?: boolean
  ext?: string
}

// encodeURIComponent leaves '*' unescaped; percent-encode it too so regex
// queries survive any intermediary that treats a bare asterisk as a wildcard.
const encQuery = (s: string) => encodeURIComponent(s).replace(/\*/g, '%2A')

export function searchFiles(query: string, rootPath: string, opts?: SearchOptions): Promise<SearchResult[]> {
  let qs = `q=${encQuery(query)}&path=${encQuery(rootPath)}`
  if (opts?.regex) qs += '&regex=1'
  if (opts?.caseSensitive) qs += '&case=1'
  if (opts?.ext && opts.ext.trim()) qs += `&ext=${encQuery(opts.ext.trim())}`
  return request<SearchResult[]>(`${API_BASE}/api/search?${qs}`)
}

export type ReplaceResult = {
  replaced: number
  path: string
  mtimeMs: number
}

// Replace occurrences of `find` in a single file. Reuses the conflict-safe write
// path (pass expectedMtimeMs to reject if the file changed since it was read).
export function replaceInFile(
  filePath: string,
  find: string,
  replacement: string,
  expectedMtimeMs?: number,
  opts?: SearchOptions,
): Promise<ReplaceResult> {
  return request<ReplaceResult>(`${API_BASE}/api/replace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: filePath,
      find,
      replacement,
      ...(typeof expectedMtimeMs === 'number' ? { mtimeMs: expectedMtimeMs } : {}),
      regex: opts?.regex ?? false,
      caseSensitive: opts?.caseSensitive ?? false
    })
  })
}

export function createEntry(targetPath: string, type: 'file' | 'directory'): Promise<Entry> {
  return request<Entry>(`${API_BASE}/api/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: targetPath, type })
  })
}

export function renameEntry(fromPath: string, toPath: string): Promise<Entry> {
  return request<Entry>(`${API_BASE}/api/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromPath, to: toPath })
  })
}

export function deleteEntry(entryPath: string): Promise<{ deleted: string }> {
  return request<{ deleted: string }>(`${API_BASE}/api/files?path=${encodeURIComponent(entryPath)}`, {
    method: 'DELETE'
  })
}

export type RootsResult = {
  roots: string[]
  // Runtime-added roots that can be removed via removeRoot. The default and any
  // static BASE_DIRS roots are absent from this list (not removable).
  removableRoots?: string[]
}

export function listRoots(): Promise<RootsResult> {
  return request<RootsResult>(`${API_BASE}/api/roots`)
}

// Allow the backend to serve a folder outside its configured root (e.g. another
// repository). The server is localhost-only, so this only widens local access.
export function openFolder(dirPath: string): Promise<RootsResult> {
  return request<RootsResult>(`${API_BASE}/api/roots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath })
  })
}

// Remove a runtime-added root (one present in RootsResult.removableRoots). The
// default and static roots cannot be removed.
export function removeRoot(dirPath: string): Promise<RootsResult> {
  return request<RootsResult>(`${API_BASE}/api/roots?path=${encodeURIComponent(dirPath)}`, { method: 'DELETE' })
}

export type TfChangedFile = {
  path: string
  before: string
  after: string
}

export type TfDiagnostic = {
  severity?: 'error' | 'warning'
  summary: string
  detail?: string
}

// One attribute-level change inside a planned resource (plan deep-dive).
// `after` is null with unknown:true when the value is only known after apply.
export type TfAttributeChange = {
  path: string
  before: unknown
  after: unknown
  unknown?: boolean
}

export type TfPlanResource = {
  address: string
  type: string
  name: string
  actions: string[]
  // Attribute diffs for this resource; absent on older server responses.
  changes?: TfAttributeChange[]
}

export type TfPlanSummary = { add: number; update: number; replace: number; destroy: number }

export type TfOutputValue = { value: unknown; type?: string; sensitive?: boolean }

// One node of the configuration dependency graph (terraform graph).
export type TfGraphNode = { id: string; label?: string }

export type TfCommand =
  | 'fmt'
  | 'validate'
  | 'plan'
  | 'plan-json'
  | 'drift'
  | 'graph'
  | 'init'
  | 'init-upgrade'
  | 'output'
  | 'state-list'
  | 'state-show'
  | 'version'
  | 'workspace-list'
  | 'workspace-new'
  | 'workspace-select'
  | 'show-plan'
  | 'import'
  | 'state-mv'
  | 'state-rm'
  | 'console-eval'
  | 'plan-file'
  | 'apply'
  | 'plan-file-destroy'

// Client-supplied arguments for the arg-taking commands. Each field is only
// read by the server for its own command (validated there).
export type TfRunOptions = {
  address?: string // state-show, state-rm, import
  name?: string // workspace-new, workspace-select
  srcAddress?: string // state-mv
  destAddress?: string // state-mv
  importId?: string // import
  expression?: string // console-eval (piped to terraform console's stdin)
  varFile?: string // top-level .tfvars file name (init/plan family only)
  backendConfig?: { key: string; value: string }[] // init/init-upgrade only
}

export type TfWorkspace = { name: string; current: boolean }

export type TfRunResult =
  | { command: 'fmt'; exitCode: number; changedFiles: TfChangedFile[]; error?: string }
  | {
      command: 'validate'
      valid: boolean
      errorCount: number
      warningCount: number
      diagnostics: TfDiagnostic[]
    }
  | { command: 'plan'; exitCode: number | null; output: string; timedOut: boolean }
  | {
      command: 'plan-json'
      exitCode: number | null
      timedOut: boolean
      summary: TfPlanSummary | null
      resources: TfPlanResource[]
      output: string
    }
  | {
      // Drift check (plan -detailed-exitcode): drifted is false when state
      // matches reality, true when changes were detected, null when the check
      // itself failed (error exit or timeout).
      command: 'drift'
      exitCode: number | null
      timedOut: boolean
      drifted: boolean | null
      summary: TfPlanSummary | null
      resources: TfPlanResource[]
      output: string
    }
  | {
      // Dependency graph of the configuration (terraform graph, DOT parsed).
      command: 'graph'
      exitCode: number | null
      timedOut: boolean
      nodes: TfGraphNode[]
      edges: [string, string][]
      output: string
    }
  | { command: 'init'; exitCode: number | null; output: string; timedOut: boolean }
  | { command: 'init-upgrade'; exitCode: number | null; output: string; timedOut: boolean }
  | {
      command: 'output'
      exitCode: number | null
      timedOut: boolean
      outputs: Record<string, TfOutputValue> | null
      output: string
    }
  | { command: 'state-list'; exitCode: number | null; timedOut: boolean; addresses: string[]; output: string }
  | { command: 'state-show'; exitCode: number | null; timedOut: boolean; address: string; output: string }
  | { command: 'version'; exitCode: number | null; timedOut: boolean; version: string | null; platform: string | null; output: string }
  | { command: 'workspace-list'; exitCode: number | null; timedOut: boolean; workspaces: TfWorkspace[]; output: string }
  | { command: 'workspace-new'; exitCode: number | null; timedOut: boolean; name: string; output: string }
  | { command: 'workspace-select'; exitCode: number | null; timedOut: boolean; name: string; output: string }
  | { command: 'show-plan'; exitCode: number | null; timedOut: boolean; output: string }
  | { command: 'import'; exitCode: number | null; timedOut: boolean; address: string; output: string }
  | { command: 'state-mv'; exitCode: number | null; timedOut: boolean; srcAddress: string; destAddress: string; output: string }
  | { command: 'state-rm'; exitCode: number | null; timedOut: boolean; address: string; output: string }
  | { command: 'console-eval'; exitCode: number | null; timedOut: boolean; output: string }
  | { command: 'plan-file'; exitCode: number | null; output: string; timedOut: boolean }
  | { command: 'apply'; exitCode: number | null; output: string; timedOut: boolean }
  | { command: 'plan-file-destroy'; exitCode: number | null; output: string; timedOut: boolean }

export function runTerraform(command: TfCommand, dirPath: string, opts?: TfRunOptions): Promise<TfRunResult> {
  return request<TfRunResult>(`${API_BASE}/api/tf/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, path: dirPath, ...opts })
  })
}

export type TfStreamHandlers = {
  onChunk?: (text: string) => void
  onDone?: (result: TfRunResult) => void
  onError?: (message: string) => void
}

// Run a terraform command with live output streaming over SSE. Chunks arrive via
// onChunk while the command runs; exactly one of onDone/onError fires at the end.
// Returns a cancel function (aborts the fetch; the server-side run still finishes).
export function runTerraformStream(
  command: TfCommand,
  dirPath: string,
  handlers: TfStreamHandlers,
  opts?: TfRunOptions,
): () => void {
  const params = new URLSearchParams({ command, path: dirPath })
  if (opts?.address) params.set('address', opts.address)
  if (opts?.name) params.set('name', opts.name)
  if (opts?.srcAddress) params.set('srcAddress', opts.srcAddress)
  if (opts?.destAddress) params.set('destAddress', opts.destAddress)
  if (opts?.importId !== undefined && opts.importId !== '') params.set('importId', opts.importId)
  if (opts?.expression !== undefined && opts.expression !== '') params.set('expression', opts.expression)
  if (opts?.varFile) params.set('varFile', opts.varFile)
  if (opts?.backendConfig && opts.backendConfig.length > 0) {
    params.set('backendConfig', JSON.stringify(opts.backendConfig))
  }

  let settled = false
  const controller = new AbortController()

  fetch(`${API_BASE}/api/tf/run-stream?${params.toString()}`, { signal: controller.signal })
    .then(async res => {
      // Non-SSE responses are validation errors (400/409/5xx JSON).
      if (!res.ok || !res.body) {
        let message = `Request failed (${res.status})`
        try {
          const j = (await res.json()) as { error?: string }
          if (j?.error) message = j.error
        } catch {
          // non-JSON body; keep the status-based message
        }
        throw new Error(message)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // SSE frames are separated by a blank line.
        let sep
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue
            let msg: { type?: string; text?: string; status?: number; result?: TfRunResult; error?: string }
            try {
              msg = JSON.parse(line.slice(6))
            } catch {
              continue
            }
            if (msg.type === 'chunk' && typeof msg.text === 'string') {
              handlers.onChunk?.(msg.text)
            } else if (msg.type === 'done') {
              settled = true
              const status = msg.status ?? 200
              if (status >= 400) {
                const body = msg.result as { error?: string } | undefined
                throw new Error(body?.error ?? `Terraform run failed (${status})`)
              }
              handlers.onDone?.(msg.result as TfRunResult)
            } else if (msg.type === 'error') {
              settled = true
              throw new Error(msg.error ?? 'Terraform run failed')
            }
          }
        }
      }
      // Stream ended without a done/error frame (e.g. server restart mid-run).
      if (!settled) handlers.onError?.('Connection closed before the command finished')
    })
    .catch(err => {
      if (err instanceof Error && err.name === 'AbortError') return
      handlers.onError?.(err instanceof Error ? err.message : String(err))
    })

  return () => controller.abort()
}

export type TfVersions = {
  tfenvAvailable: boolean
  installed: string[]
  active: string | null
}

export function getTfVersions(dirPath: string): Promise<TfVersions> {
  return request<TfVersions>(`${API_BASE}/api/tf/versions?path=${encodeURIComponent(dirPath)}`)
}

// Pin a terraform version for a directory (writes <dir>/.terraform-version,
// the format tfenv expects).
export function setTfVersion(
  dirPath: string,
  version: string,
): Promise<{ path: string; version: string }> {
  return request<{ path: string; version: string }>(`${API_BASE}/api/tf/version`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, version })
  })
}

export type TfInstallResult = {
  exitCode: number | null
  output: string
  timedOut: boolean
}

// Install a terraform version via `tfenv install <version>`.
export function installTfVersion(version: string): Promise<TfInstallResult> {
  return request<TfInstallResult>(`${API_BASE}/api/tf/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version })
  })
}

// State backend of a project, read from the files terraform init writes (no
// terraform process needed). `backend.config` values that look like credentials
// are redacted server-side. localState is null when there is no local state file.
export type TfBackendInfo = { type: string; config: Record<string, unknown> }

export type TfLocalState = { exists: boolean; resources: number | null; serial: number | null }

export type TfStateInfo = {
  initialized: boolean
  backend: TfBackendInfo | null
  localState: TfLocalState | null
}

export function getTfStateInfo(dirPath: string): Promise<TfStateInfo> {
  return request<TfStateInfo>(`${API_BASE}/api/tf/state-info?path=${encodeURIComponent(dirPath)}`)
}

// A top-level .tfvars file. autoLoaded files (terraform.tfvars, *.auto.tfvars)
// are picked up by terraform without -var-file; the others need an explicit choice.
export type TfVarFile = { name: string; autoLoaded: boolean }

export function listTfVarFiles(dirPath: string): Promise<{ files: TfVarFile[] }> {
  return request<{ files: TfVarFile[] }>(`${API_BASE}/api/tf/var-files?path=${encodeURIComponent(dirPath)}`)
}

// --- Terraform module registry (server-side proxy of the public API) --------

export type RegistryModuleVersion = { version: string; publishedAt?: string }

export type RegistryModule = {
  namespace: string
  name: string
  provider: string
  // The `source` value to put in a module block.
  source: string
  description?: string
  downloads?: number
  versions: RegistryModuleVersion[]
}

// Look up a public module by its registry coordinates (namespace/name/provider).
export function getRegistryModule(ns: string, name: string, provider: string): Promise<RegistryModule> {
  const qs = `ns=${encodeURIComponent(ns)}&name=${encodeURIComponent(name)}&provider=${encodeURIComponent(provider)}`
  return request<RegistryModule>(`${API_BASE}/api/tf/registry/module?${qs}`)
}

// --- Infracost cost estimation (optional binary on the server's PATH) -------

export type TfCostResource = { address: string; monthlyCost: number | null }

export type TfCostResult = {
  exitCode: number | null
  timedOut: boolean
  currencySymbol: string
  totalMonthlyCost: number | null
  resources: TfCostResource[]
  errors: string[]
  warnings: string[]
  output?: string
}

// Estimated monthly cost of the configuration in dirPath. Rejects with a
// message (and hint) when infracost is not installed on the server.
export function getTfCost(dirPath: string): Promise<TfCostResult> {
  return request<TfCostResult>(`${API_BASE}/api/tf/cost`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath })
  })
}

export function getTfCostAvailability(): Promise<{ available: boolean }> {
  return request<{ available: boolean }>(`${API_BASE}/api/tf/cost-availability`)
}

// --- Cloud credentials (global encrypted store) + real cloud logins ----------
// Credential values are whitelisted server-side; the encrypted file lives in
// ~/.terraform-code and no endpoint ever returns plaintext. `unlocked` means
// the server holds a TTL-bounded in-memory copy. A provider only appears in
// `sessions` after a successful, real authentication against that cloud (via
// the installed aws/az/gcloud CLI); terraform runs receive credentials as env
// for session providers only.

export type CloudProvider = 'aws' | 'azure' | 'gcp'

export const CLOUD_PROVIDER_LABELS: Record<CloudProvider, string> = {
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'Google Cloud'
}

export type CloudCredentialsPayload = {
  aws?: { accessKeyId: string; secretAccessKey: string; sessionToken: string; region: string }
  azure?: { clientId: string; clientSecret: string; tenantId: string; subscriptionId: string }
  gcp?: { serviceAccountJson: string; projectId: string }
}

export type CloudSession = { loggedInAt: number; identity: string } & Record<string, unknown>

export type CloudStatus = {
  exists: boolean
  providers: CloudProvider[]
  unlocked: boolean
  sessions: Partial<Record<CloudProvider, CloudSession>>
}

export function getCloudStatus(): Promise<CloudStatus> {
  return request<CloudStatus>(`${API_BASE}/api/cloud/status`)
}

export type CloudCredActionResult = { ok: true } & CloudStatus

// action + fields are validated server-side; passphrases travel only over the
// localhost API and are never stored or logged by the server.
export function cloudCredentialAction(
  action: 'create' | 'update' | 'change-passphrase' | 'unlock' | 'lock' | 'delete',
  payload?: {
    passphrase?: string
    oldPassphrase?: string
    newPassphrase?: string
    credentials?: CloudCredentialsPayload
    // update only: providers to drop (the server keeps all others as-is)
    removeProviders?: string[]
  },
): Promise<CloudCredActionResult> {
  return request<CloudCredActionResult>(`${API_BASE}/api/cloud/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  })
}

// Authenticate against a cloud provider using the registered credentials. The
// server performs the real login via the installed CLI; an optional passphrase
// unlocks the store first when it is locked.
export type CloudLoginResult = { ok: true; provider: CloudProvider; session: CloudSession }

export function cloudLogin(provider: CloudProvider, passphrase?: string): Promise<CloudLoginResult> {
  return request<CloudLoginResult>(`${API_BASE}/api/cloud/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, ...(passphrase ? { passphrase } : {}) })
  })
}

export function cloudLogout(provider: CloudProvider): Promise<{ ok: true; provider: CloudProvider }> {
  return request<{ ok: true; provider: CloudProvider }>(`${API_BASE}/api/cloud/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider })
  })
}

export type GitStatusEntry = {
  index: string
  worktree: string
  path: string
  origPath?: string
}

export type GitStatusResult = {
  isRepo: boolean
  entries: GitStatusEntry[]
}

// Porcelain v1 status for a directory; non-repo paths get isRepo:false.
export function getGitStatus(dirPath: string): Promise<GitStatusResult> {
  return request<GitStatusResult>(`${API_BASE}/api/git/status?path=${encodeURIComponent(dirPath)}`)
}

export type GitFileDiff = {
  path: string
  oldContent: string
  newContent: string
  untracked: boolean
}

// File content at HEAD (oldContent) and in the worktree (newContent). Untracked
// files have empty oldContent; deleted files have empty newContent.
export function getGitFileDiff(dirPath: string, file: string): Promise<GitFileDiff> {
  const params = new URLSearchParams({ path: dirPath, file })
  return request<GitFileDiff>(`${API_BASE}/api/git/diff?${params.toString()}`)
}

export type GitLogCommit = {
  hash: string
  short: string
  author: string
  email: string
  date: string
  subject: string
}

export type GitLogResult = {
  isRepo: boolean
  commits: GitLogCommit[]
}

// Recent commit history for a directory (newest first). Non-repos get isRepo:false.
export function getGitLog(dirPath: string, limit?: number): Promise<GitLogResult> {
  const params = new URLSearchParams({ path: dirPath })
  if (limit) params.set('limit', String(limit))
  return request<GitLogResult>(`${API_BASE}/api/git/log?${params.toString()}`)
}

export type GitCommitDiffFile = {
  path: string
  status: string
  oldContent: string
  newContent: string
  binaryOrLarge?: boolean
}

// The per-file changes a single commit introduced (vs its parent).
export type GitCommitDiff = {
  hash: string
  short: string
  author: string
  email: string
  date: string
  subject: string
  files: GitCommitDiffFile[]
  truncated: boolean
}

export function getGitCommitDiff(dirPath: string, hash: string): Promise<GitCommitDiff> {
  const params = new URLSearchParams({ path: dirPath, hash })
  return request<GitCommitDiff>(`${API_BASE}/api/git/commit-diff?${params.toString()}`)
}

export type GitCommitResult = {
  committed: boolean
  hash?: string
  message?: string
  reason?: string
}

// Stage everything under dirPath (git add -A), or only the listed files when
// `files` is given (relative paths; renames should include both old and new).
export function gitCommit(dirPath: string, message: string, files?: string[]): Promise<GitCommitResult> {
  const body: Record<string, unknown> = { path: dirPath, message }
  if (files && files.length > 0) body.files = files
  return request<GitCommitResult>(`${API_BASE}/api/git/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export type GitBranches = {
  isRepo: boolean
  current: string | null
  branches: string[]
}

// Current branch (null when detached) and the list of local branches. Non-repo
// paths get isRepo:false so the UI can offer "initialize" instead.
export function getGitBranches(dirPath: string): Promise<GitBranches> {
  return request<GitBranches>(`${API_BASE}/api/git/branches?path=${encodeURIComponent(dirPath)}`)
}

export type GitRemote = {
  name: string
  url: string
  platform: 'github' | 'gitlab' | null
  webUrl: string | null
}

export type GitRemotes = {
  isRepo: boolean
  remotes: GitRemote[]
}

// Configured remotes, with detected hosting platform and a derived "open in
// browser" web URL (GitHub / GitLab / self-hosted).
export function getGitRemotes(dirPath: string): Promise<GitRemotes> {
  return request<GitRemotes>(`${API_BASE}/api/git/remotes?path=${encodeURIComponent(dirPath)}`)
}

export type CreateBranchResult = {
  created: string
  switched: boolean
}

// Create a new branch. With switch:true it also checks the branch out.
export function createBranch(
  dirPath: string,
  name: string,
  opts?: { from?: string; switch?: boolean },
): Promise<CreateBranchResult> {
  return request<CreateBranchResult>(`${API_BASE}/api/git/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, name, from: opts?.from, switch: opts?.switch })
  })
}

export type CheckoutResult = {
  checkedOut: string
}

// Switch to an existing branch (or detach at a ref).
export function checkoutBranch(dirPath: string, ref: string): Promise<CheckoutResult> {
  return request<CheckoutResult>(`${API_BASE}/api/git/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, ref })
  })
}

export type GitMergeResult = {
  merged: boolean
  conflicted?: boolean
  branch: string
  output: string
  hint?: string
}

// Merge a branch into the current one. Conflicts come back with conflicted:true.
export function mergeBranch(dirPath: string, branch: string): Promise<GitMergeResult> {
  return request<GitMergeResult>(`${API_BASE}/api/git/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, branch })
  })
}

export type GitRebaseResult = {
  rebased: boolean
  conflicted?: boolean
  branch: string
  output: string
  hint?: string
}

// Rebase the current branch onto another. Conflicts come back with conflicted:true.
export function rebaseOnto(dirPath: string, branch: string): Promise<GitRebaseResult> {
  return request<GitRebaseResult>(`${API_BASE}/api/git/rebase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, branch })
  })
}

export type GitRebaseStepResult = {
  action: string
  done: boolean
  output: string
}

// Advance a stopped rebase (abort | continue | skip).
export function rebaseStep(dirPath: string, action: 'abort' | 'continue' | 'skip'): Promise<GitRebaseStepResult> {
  return request<GitRebaseStepResult>(`${API_BASE}/api/git/rebase-step`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, action })
  })
}

export type GitInitResult = {
  initialized: boolean
  error?: string
  path?: string
  branch?: string | null
  remoteUrl?: string | null
  remoteAdded?: boolean
}

// Initialize a repository in an imported/empty folder and optionally add an
// `origin` remote so the user can push to a new GitHub/GitLab repo.
export function initRepo(
  dirPath: string,
  opts?: { remoteUrl?: string; branch?: string },
): Promise<GitInitResult> {
  return request<GitInitResult>(`${API_BASE}/api/git/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, remoteUrl: opts?.remoteUrl, branch: opts?.branch })
  })
}

export type GitPushResult = {
  success: boolean
  branch?: string
  output: string
}

// Push the current (or named) branch to origin. Failures resolve with
// success:false and the full git output (e.g. auth errors).
export function gitPush(dirPath: string, opts?: { branch?: string; setUpstream?: boolean }): Promise<GitPushResult> {
  return request<GitPushResult>(`${API_BASE}/api/git/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, branch: opts?.branch, setUpstream: opts?.setUpstream })
  })
}

export type GitPullResult = {
  success: boolean
  conflicted?: boolean
  branch?: string
  output: string
}

// Pull from origin (current or named branch). Conflicts come back with conflicted:true.
export function gitPull(dirPath: string, opts?: { branch?: string }): Promise<GitPullResult> {
  return request<GitPullResult>(`${API_BASE}/api/git/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, branch: opts?.branch })
  })
}

export type GitFetchResult = {
  success: boolean
  output: string
}

// Fetch all remotes (updates remote-tracking refs).
export function gitFetch(dirPath: string): Promise<GitFetchResult> {
  return request<GitFetchResult>(`${API_BASE}/api/git/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath })
  })
}

export type FsChangeEvent = {
  type: string
  paths?: string[]
}

// Open the server's Server-Sent Events stream of file-system changes (files
// rewritten externally, e.g. by terraform fmt). onChange receives each batched
// list of changed absolute paths. Returns a function that closes the stream.
export function openFileEvents(onChange: (paths: string[]) => void): () => void {
  const source = new EventSource(`${API_BASE}/api/events`)
  source.onmessage = e => {
    try {
      const payload = JSON.parse(e.data) as FsChangeEvent
      if (payload.type === 'fs-change' && Array.isArray(payload.paths)) onChange(payload.paths)
    } catch {
      // malformed event; ignore it
    }
  }
  return () => source.close()
}
