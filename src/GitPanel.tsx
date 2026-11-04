import { useEffect, useState, type ReactElement } from 'react'
import {
  checkoutBranch,
  createBranch,
  getGitBranches,
  getGitLog,
  getGitRemotes,
  gitCommit,
  gitFetch,
  gitPull,
  gitPush,
  initRepo,
  mergeBranch,
  rebaseOnto,
  rebaseStep,
  type GitBranches,
  type GitLogCommit,
  type GitRemote,
  type GitStatusEntry
} from './api'
import { badgeForEntry, summarizeStatus } from './gitBadge'

// The backend caps explicit file lists for a commit (GIT_MAX_COMMIT_FILES).
const SELECTIVE_COMMIT_CAP = 200
// Render cap for the changed-files list; unlisted files still count as selected.
const MAX_RENDERED_FILES = 300

// Stable identity of a status entry (renames carry both paths).
const fileKey = (e: GitStatusEntry): string => (e.origPath ? `${e.origPath}→${e.path}` : e.path)

type GitPanelProps = {
  dirPath: string
  isRepo: boolean
  entries: GitStatusEntry[]
  refreshKey: number
  onRefresh: () => void
  // Open a commit's per-file diff in the main area (Step 2 history viewer).
  onOpenCommit?: (dirPath: string, hash: string) => void
  openCommitHash?: string | null
}

type OpStatus = {
  kind: 'ok' | 'error' | 'info'
  text: string
  output?: string
}

const PLATFORM_LABEL: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab' }

const GitPanel = ({ dirPath, isRepo, entries, refreshKey, onRefresh, onOpenCommit, openCommitHash }: GitPanelProps): ReactElement => {
  const [branches, setBranches] = useState<GitBranches | null>(null)
  const [remotes, setRemotes] = useState<{ remotes: GitRemote[] } | null>(null)

  // Recent commit history for the History section (Step 2).
  const [logCommits, setLogCommits] = useState<GitLogCommit[] | null>(null)
  // How many recent commits to load (History quantity filter); re-fetches on change.
  const [logLimit, setLogLimit] = useState(5)
  // Revision search: a hash prefix or a commit-message substring.
  const [revQuery, setRevQuery] = useState('')

  // Which operation is in flight (label); non-null disables all action buttons.
  const [busy, setBusy] = useState<string | null>(null)
  const [opStatus, setOpStatus] = useState<OpStatus | null>(null)

  // Commit box state (existing behavior).
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)

  // Selective commit: paths the user unchecked (empty set = everything selected).
  const [unselected, setUnselected] = useState<Set<string>>(new Set())

  // A fresh status fetch means a new selection baseline: select all again.
  useEffect(() => {
    setUnselected(new Set()) // eslint-disable-line react/set-state-in-effect
  }, [dirPath, refreshKey])

  // New-branch form.
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')

  // Initialize-repo form (non-repo folders).
  const [initRemoteUrl, setInitRemoteUrl] = useState('')
  const [initBranch, setInitBranch] = useState('main')

  // Merge / rebase targets.
  const [mergeTarget, setMergeTarget] = useState('')
  const [rebaseTarget, setRebaseTarget] = useState('')
  const [rebaseInProgress, setRebaseInProgress] = useState(false)

  // Fetch branch + remote info for this repo (and on every tree refresh). The
  // panel is remounted per root via a key in FileExplorer, so dirPath changes
  // reset state; refreshKey re-fetches within a mount.
  useEffect(() => {
    if (!isRepo) return
    let cancelled = false
    getGitBranches(dirPath)
      .then(b => {
        if (cancelled) return
        setBranches(b)
        // Default the merge/rebase selects to the first non-current branch.
        const other = b.branches.find(x => x !== b.current) ?? ''
        setMergeTarget(prev => prev || other)
        setRebaseTarget(prev => prev || other)
      })
      .catch(() => {})
    getGitRemotes(dirPath)
      .then(r => {
        if (!cancelled) setRemotes({ remotes: r.remotes })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dirPath, isRepo, refreshKey])

  // Fetch recent history for the History section. The panel remounts per root via
  // a key in App, so dirPath changes reset state; refreshKey/logLimit re-fetch.
  useEffect(() => {
    if (!isRepo) return
    let cancelled = false
    getGitLog(dirPath, logLimit)
      .then(r => {
        if (cancelled) return
        setLogCommits(r.isRepo ? r.commits : [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dirPath, isRepo, refreshKey, logLimit])

  const runOp = async (label: string, fn: () => Promise<void>) => {
    if (busy !== null) return
    setBusy(label)
    setOpStatus(null)
    try {
      await fn()
    } catch (err) {
      setOpStatus({ kind: 'error', text: err instanceof Error ? err.message : `${label} failed` })
    } finally {
      setBusy(null)
    }
  }

  // Explicit pathspecs for a selective commit; renames contribute both paths.
  const selectedSpecs = entries
    .filter(e => !unselected.has(fileKey(e)))
    .flatMap(e => (e.origPath ? [e.origPath, e.path] : [e.path]))
  const selectedCount = entries.length - unselected.size
  // The all-inclusive path sends no file list, so the cap only bites on subsets.
  const overCap = unselected.size > 0 && selectedSpecs.length > SELECTIVE_COMMIT_CAP

  const toggleFile = (key: string) => {
    setUnselected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleCommit = async () => {
    const msg = message.trim()
    if (!msg || committing || overCap) return
    setCommitting(true)
    setOpStatus(null)
    try {
      let files: string[] | undefined
      if (unselected.size > 0) {
        const ok = window.confirm(
          `Commit only ${selectedCount} of ${entries.length} file(s)?\n` +
            `${unselected.size} change(s) will not be included in this commit.`,
        )
        if (!ok) return
        files = selectedSpecs
      }
      const result = await gitCommit(dirPath, msg, files)
      if (result.committed) {
        setMessage('')
        setOpStatus({ kind: 'ok', text: `Committed ${result.hash ?? ''}`.trim() })
        onRefresh()
      } else {
        setOpStatus({ kind: 'error', text: result.reason ?? 'Nothing to commit' })
      }
    } catch (err) {
      setOpStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Commit failed' })
    } finally {
      setCommitting(false)
    }
  }

  const handleSwitchBranch = async (ref: string) => {
    if (!ref || ref === branches?.current) return
    await runOp('switch', async () => {
      await checkoutBranch(dirPath, ref)
      setRebaseInProgress(false)
      setOpStatus({ kind: 'ok', text: `Switched to ${ref}` })
      onRefresh()
    })
  }

  const handleCreateBranch = async () => {
    const name = newBranchName.trim()
    if (!name || busy !== null) return
    await runOp('create branch', async () => {
      await createBranch(dirPath, name, { switch: true })
      setNewBranchOpen(false)
      setNewBranchName('')
      setRebaseInProgress(false)
      setOpStatus({ kind: 'ok', text: `Created and switched to ${name}` })
      onRefresh()
    })
  }

  const handleMerge = async () => {
    if (!mergeTarget || busy !== null) return
    await runOp('merge', async () => {
      const result = await mergeBranch(dirPath, mergeTarget)
      setRebaseInProgress(false)
      onRefresh()
      if (result.merged) {
        setOpStatus({ kind: 'ok', text: `Merged ${mergeTarget}`, output: result.output })
      } else {
        setOpStatus({
          kind: 'error',
          text: result.conflicted ? `Merge of ${mergeTarget} stopped with conflicts` : `Merge of ${mergeTarget} failed`,
          output: result.output,
        })
      }
    })
  }

  const handleRebase = async () => {
    if (!rebaseTarget || busy !== null) return
    if (!window.confirm(`Rebase the current branch onto "${rebaseTarget}"? This rewrites history.`)) return
    await runOp('rebase', async () => {
      const result = await rebaseOnto(dirPath, rebaseTarget)
      onRefresh()
      if (result.rebased) {
        setRebaseInProgress(false)
        setOpStatus({ kind: 'ok', text: `Rebased onto ${rebaseTarget}`, output: result.output })
      } else {
        setRebaseInProgress(true)
        setOpStatus({
          kind: 'error',
          text: `Rebase stopped with conflicts — resolve them, then continue or abort.`,
          output: result.output,
        })
      }
    })
  }

  const handleRebaseStep = async (action: 'abort' | 'continue' | 'skip') => {
    await runOp(`rebase ${action}`, async () => {
      const result = await rebaseStep(dirPath, action)
      onRefresh()
      if (action === 'abort') {
        setRebaseInProgress(false)
        setOpStatus({ kind: 'ok', text: 'Rebase aborted', output: result.output })
      } else if (result.done) {
        setRebaseInProgress(false)
        setOpStatus({ kind: 'ok', text: `Rebase ${action}ed`, output: result.output })
      } else {
        setOpStatus({ kind: 'error', text: `Rebase stopped again after ${action}`, output: result.output })
      }
    })
  }

  const handlePush = async () => {
    await runOp('push', async () => {
      const result = await gitPush(dirPath)
      onRefresh()
      if (result.success) setOpStatus({ kind: 'ok', text: 'Pushed to origin', output: result.output })
      else setOpStatus({ kind: 'error', text: 'Push failed — check your credentials/remote', output: result.output })
    })
  }

  const handlePull = async () => {
    await runOp('pull', async () => {
      const result = await gitPull(dirPath)
      onRefresh()
      if (result.success) setOpStatus({ kind: 'ok', text: 'Pulled from origin', output: result.output })
      else if (result.conflicted) setOpStatus({ kind: 'error', text: 'Pull stopped with conflicts — resolve and commit.', output: result.output })
      else setOpStatus({ kind: 'error', text: 'Pull failed', output: result.output })
    })
  }

  const handleFetch = async () => {
    await runOp('fetch', async () => {
      const result = await gitFetch(dirPath)
      onRefresh()
      if (result.success) setOpStatus({ kind: 'ok', text: 'Fetched all remotes', output: result.output })
      else setOpStatus({ kind: 'error', text: 'Fetch failed', output: result.output })
    })
  }

  const handleInit = async () => {
    const remoteUrl = initRemoteUrl.trim()
    const branch = initBranch.trim() || undefined
    if (busy !== null) return
    await runOp('init', async () => {
      const result = await initRepo(dirPath, { remoteUrl: remoteUrl || undefined, branch })
      setInitRemoteUrl('')
      onRefresh()
      if (result.initialized) {
        setOpStatus({
          kind: 'ok',
          text: `Initialized repository${result.remoteAdded ? ' and added origin' : ''}`,
        })
      } else {
        setOpStatus({ kind: 'error', text: result.error ?? 'Init failed' })
      }
    })
  }

  // Non-repository folder: offer to initialize a repo (optionally with an origin).
  if (!isRepo) {
    return (
      <div className="git-panel">
        <div className="git-section-title">Git</div>
        <p className="git-note">This folder is not a git repository.</p>
        <label className="git-field-label" htmlFor="init-remote">
          Remote origin URL (optional)
        </label>
        <input
          id="init-remote"
          className="git-input"
          value={initRemoteUrl}
          onChange={e => setInitRemoteUrl(e.target.value)}
          placeholder="https://github.com/owner/repo.git"
        />
        <label className="git-field-label" htmlFor="init-branch">
          Initial branch name
        </label>
        <input id="init-branch" className="git-input" value={initBranch} onChange={e => setInitBranch(e.target.value)} />
        <button onClick={() => void handleInit()} disabled={busy !== null}>
          {busy ? 'Working…' : initRemoteUrl.trim() ? 'Initialize + add origin' : 'Initialize repository'}
        </button>
        {opStatus && (
          <>
            <div className={`git-status ${opStatus.kind}`}>{opStatus.text}</div>
            {opStatus.output && <pre className="git-op-output">{opStatus.output}</pre>}
          </>
        )}
      </div>
    )
  }

  const current = branches?.current ?? null
  const branchOptions = (branches?.branches ?? []).filter(b => b !== current)
  const origin = remotes?.remotes.find(r => r.name === 'origin') ?? remotes?.remotes[0] ?? null

  // History search: match a hash prefix or a commit-message substring.
  const revLower = revQuery.trim().toLowerCase()
  const visibleCommits = (logCommits ?? []).filter(
    c => !revLower || c.hash.toLowerCase().startsWith(revLower) || c.subject.toLowerCase().includes(revLower),
  )
  // A valid object id typed directly that isn't in the loaded window → offer a jump.
  const canJumpToHash =
    /^[0-9a-f]{7,40}$/i.test(revQuery.trim()) && !(logCommits ?? []).some(c => c.hash.toLowerCase().startsWith(revLower))

  return (
    <div className="git-panel">
      {/* Branch */}
      <div className="git-section-title">Branch</div>
      {branches !== null ? (
        <>
          <div className="git-branch-row">
            <select
              className="git-input git-branch-select"
              value={current ?? ''}
              onChange={e => void handleSwitchBranch(e.target.value)}
              disabled={busy !== null || current === null}
              title={current ? `Current branch: ${current}` : 'Detached HEAD'}
            >
              {current === null && <option value="">(detached HEAD)</option>}
              {(branches.branches ?? []).map(b => (
                <option key={b} value={b}>
                  {b}
                  {b === current ? ' (current)' : ''}
                </option>
              ))}
            </select>
            {!newBranchOpen && (
              <button className="git-mini-btn" onClick={() => setNewBranchOpen(true)} disabled={busy !== null}>
                + New
              </button>
            )}
          </div>
          {newBranchOpen && (
            <div className="git-branch-row">
              <input
                className="git-input"
                value={newBranchName}
                onChange={e => setNewBranchName(e.target.value)}
                placeholder="feature/my-change"
                aria-label="New branch name"
              />
              <button onClick={() => void handleCreateBranch()} disabled={!newBranchName.trim() || busy !== null}>
                Create
              </button>
              <button className="git-mini-btn" onClick={() => setNewBranchOpen(false)} disabled={busy !== null}>
                Cancel
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="git-note">Loading branches…</p>
      )}

      {/* History — recent commits; click one to view its per-file diff. */}
      {logCommits !== null && logCommits.length > 0 && (
        <>
          <div className="git-section-title">History</div>

          {/* Quantity filter + revision search controls. */}
          <div className="git-history-controls">
            <select
              className="git-input git-limit-select"
              value={logLimit}
              onChange={e => setLogLimit(Number(e.target.value))}
              aria-label="Number of commits to show"
              title="How many recent commits to load"
            >
              {[5, 10, 15, 20, 30, 40].map(n => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <input
              className="git-input git-rev-search"
              value={revQuery}
              onChange={e => setRevQuery(e.target.value)}
              placeholder="Search revision / message…"
              aria-label="Search commits by hash or message"
            />
          </div>

          {canJumpToHash && (
            <button className="git-jump-btn" onClick={() => onOpenCommit?.(dirPath, revQuery.trim())}>
              Open revision {revQuery.trim().slice(0, 12)}…
            </button>
          )}

          <div className="git-history">
            {visibleCommits.length === 0 && (
              <p className="git-note">No commits match “{revQuery.trim()}”.</p>
            )}
            {visibleCommits.map(c => (
              <button
                key={c.hash}
                type="button"
                className={`git-commit-row${openCommitHash === c.hash ? ' active' : ''}`}
                onClick={() => onOpenCommit?.(dirPath, c.hash)}
                title={`${c.subject}\n${c.author}${c.email ? ` <${c.email}>` : ''} — ${c.date}`}
              >
                <span className="git-commit-hash">{c.short}</span>
                <span className="git-commit-subject">{c.subject}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Remotes */}
      {remotes !== null && remotes.remotes.length > 0 && (
        <>
          <div className="git-section-title">Remotes</div>
          {remotes.remotes.map(r => (
            <div key={r.name} className="git-remote-row" title={r.url}>
              <span className="git-remote-name">{r.name}</span>
              <span className="git-remote-url">{r.url}</span>
              {r.platform && (
                <a
                  className={`git-platform git-${r.platform}`}
                  href={r.webUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`Open on ${PLATFORM_LABEL[r.platform] ?? r.platform}`}
                >
                  {PLATFORM_LABEL[r.platform] ?? r.platform} ↗
                </a>
              )}
            </div>
          ))}
        </>
      )}

      {/* Sync (push/pull/fetch) — only when a remote exists */}
      {origin !== null && (
        <>
          <div className="git-section-title">Sync</div>
          <div className="git-btn-row">
            <button onClick={() => void handlePush()} disabled={busy !== null}>
              Push
            </button>
            <button onClick={() => void handlePull()} disabled={busy !== null}>
              Pull
            </button>
            <button onClick={() => void handleFetch()} disabled={busy !== null}>
              Fetch
            </button>
          </div>
        </>
      )}

      {/* Merge */}
      {branchOptions.length > 0 && (
        <>
          <div className="git-section-title">Merge</div>
          <div className="git-branch-row">
            <select
              className="git-input"
              value={mergeTarget}
              onChange={e => setMergeTarget(e.target.value)}
              disabled={busy !== null}
              aria-label="Branch to merge into the current one"
            >
              {branchOptions.map(b => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <button onClick={() => void handleMerge()} disabled={!mergeTarget || busy !== null}>
              Merge into current
            </button>
          </div>
        </>
      )}

      {/* Rebase */}
      {branchOptions.length > 0 && (
        <>
          <div className="git-section-title">Rebase</div>
          {rebaseInProgress ? (
            <div className="git-btn-row">
              <button onClick={() => void handleRebaseStep('continue')} disabled={busy !== null}>
                Continue
              </button>
              <button onClick={() => void handleRebaseStep('skip')} disabled={busy !== null}>
                Skip
              </button>
              <button className="git-danger" onClick={() => void handleRebaseStep('abort')} disabled={busy !== null}>
                Abort
              </button>
            </div>
          ) : (
            <div className="git-branch-row">
              <select
                className="git-input"
                value={rebaseTarget}
                onChange={e => setRebaseTarget(e.target.value)}
                disabled={busy !== null}
                aria-label="Branch to rebase the current one onto"
              >
                {branchOptions.map(b => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              <button onClick={() => void handleRebase()} disabled={!rebaseTarget || busy !== null}>
                Rebase onto
              </button>
            </div>
          )}
        </>
      )}

      {/* Commit box (only when there are changes) */}
      {entries.length > 0 && (
        <>
          <div className="git-section-title">Commit</div>
          <div className="git-summary">{summarizeStatus(entries)}</div>

          {/* Selective commit: pick which changed files go into the commit. */}
          <div className="git-changed-files">
            <div className="git-changed-header">
              <span>{selectedCount} of {entries.length} selected</span>
              {unselected.size > 0 && (
                <button type="button" className="git-mini-btn" onClick={() => setUnselected(new Set())}>
                  Select all
                </button>
              )}
            </div>
            <div className="git-changed-list">
              {entries.slice(0, MAX_RENDERED_FILES).map(e => {
                const badge = badgeForEntry(e.index, e.worktree)
                const key = fileKey(e)
                return (
                  <label key={key} className="git-file-row">
                    <input type="checkbox" checked={!unselected.has(key)} onChange={() => toggleFile(key)} />
                    {badge && <span className={`git-badge ${badge.cls}`}>{badge.letter}</span>}
                    <span className="git-file-path" title={e.origPath ? `${e.origPath} → ${e.path}` : e.path}>
                      {e.origPath ? `${e.origPath} → ${e.path}` : e.path}
                    </span>
                  </label>
                )
              })}
            </div>
            {entries.length > MAX_RENDERED_FILES && (
              <p className="git-note">
                Showing first {MAX_RENDERED_FILES} of {entries.length} — unlisted files stay selected.
              </p>
            )}
          </div>

          {overCap && (
            <p className="git-note git-warn">
              At most {SELECTIVE_COMMIT_CAP} files can be committed selectively — deselect more, or select all to commit everything.
            </p>
          )}

          <textarea
            className="git-commit-msg"
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder="Commit message…"
            rows={2}
            aria-label="Commit message"
          />
          <button
            className="git-commit-btn"
            onClick={() => void handleCommit()}
            disabled={!message.trim() || committing || overCap}
          >
            {committing
              ? 'Committing…'
              : unselected.size > 0
                ? `Commit ${selectedCount} of ${entries.length}`
                : `Commit ${entries.length} change${entries.length === 1 ? '' : 's'}`}
          </button>
        </>
      )}

      {/* Last operation status */}
      {opStatus && (
        <>
          <div className={`git-status ${opStatus.kind}`}>{opStatus.text}</div>
          {opStatus.output && <pre className="git-op-output">{opStatus.output}</pre>}
        </>
      )}
    </div>
  )
}

export default GitPanel
