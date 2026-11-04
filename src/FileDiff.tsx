import { useMemo, type ReactElement } from 'react'
import { diffLines } from './diff'

type FileDiffProps = {
  oldContent: string
  newContent: string
  hint?: string
}

const FileDiff = ({ oldContent, newContent, hint = 'changes since last save' }: FileDiffProps): ReactElement => {
  const { lines, added, removed } = useMemo(() => {
    const lines = diffLines(oldContent, newContent)
    let added = 0
    let removed = 0
    for (const line of lines) {
      if (line.type === 'added') added++
      else if (line.type === 'removed') removed++
    }
    return { lines, added, removed }
  }, [oldContent, newContent])

  return (
    <div className="diff-view">
      <div className="diff-summary">
        <span className="diff-count added">+{added}</span>
        <span className="diff-count removed">-{removed}</span>
        <span className="diff-hint">{added === 0 && removed === 0 ? 'No changes' : hint}</span>
      </div>
      <div className="diff-body">
        {lines.map((line, index) => (
          <div key={index} className={`diff-line ${line.type}`}>
            <span className="diff-no old">{line.oldNo ?? ''}</span>
            <span className="diff-no new">{line.newNo ?? ''}</span>
            <span className="diff-sign">
              {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
            </span>
            <span className="diff-text">{line.text === '' ? ' ' : line.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default FileDiff
