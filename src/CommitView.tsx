import type { ReactElement } from 'react'
import FileDiff from './FileDiff'
import type { GitCommitDiff } from './api'

type CommitViewProps = {
  data: GitCommitDiff | null
  loading: boolean
  error: string
  onClose: () => void
}

const STATUS_LABEL: Record<string, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed'
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

// Read-only view of a single commit's per-file changes, shown in the main area.
const CommitView = ({ data, loading, error, onClose }: CommitViewProps): ReactElement => (
  <div className="commit-view">
    <div className="editor-toolbar commit-header">
      <span className="file-path" title={data ? `${data.hash} — ${data.subject}` : undefined}>
        {data ? `${data.short} · ${data.subject}` : 'Commit'}
      </span>
      <button onClick={onClose}>Close</button>
    </div>

    {loading && !data && <p className="file-status">Loading commit…</p>}
    {error !== '' && <p className="file-status error">{error}</p>}

    {data && (
      <>
        <div className="commit-meta">
          <span>{`${data.author}${data.email ? ' <' + data.email + '>' : ''}`}</span>
          <span>{formatDate(data.date)}</span>
        </div>

        {data.files.length === 0 && <p className="file-status">(no file changes in this commit)</p>}

        {data.files.map(f => (
          <div key={f.path} className="commit-file">
            <div className="commit-file-head">
              <span className={`commit-status commit-${f.status.toLowerCase()}`}>
                {STATUS_LABEL[f.status] ?? f.status}
              </span>
              <span className="commit-file-path">{f.path}</span>
            </div>
            {f.binaryOrLarge ? (
              <p className="file-status">(binary or too large to display)</p>
            ) : (
              <FileDiff oldContent={f.oldContent} newContent={f.newContent} hint={STATUS_LABEL[f.status] ?? f.status} />
            )}
          </div>
        ))}

        {data.truncated && <p className="file-status">Showing the first 50 files of a large commit.</p>}
      </>
    )}
  </div>
)

export default CommitView
