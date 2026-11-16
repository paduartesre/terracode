import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import GitPanel from './GitPanel'
import { getGitBranches, getGitLog, getGitRemotes, gitCommit, type GitStatusEntry } from './api'

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  getGitBranches: vi.fn(),
  getGitLog: vi.fn(),
  getGitRemotes: vi.fn(),
  gitCommit: vi.fn(),
}))

const untracked = (path: string): GitStatusEntry => ({ path, index: '?', worktree: '?' })

describe('Git commit selection', () => {
  beforeEach(() => {
    vi.mocked(getGitBranches).mockResolvedValue({ isRepo: true, current: 'main', branches: ['main'] })
    vi.mocked(getGitRemotes).mockResolvedValue({ isRepo: true, remotes: [] })
    vi.mocked(getGitLog).mockResolvedValue({ isRepo: true, commits: [] })
    vi.mocked(gitCommit).mockResolvedValue({ committed: true, hash: 'abc1234' })
  })
  afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks() })

  it('keeps unchecked files across refreshes and handles changed entries', async () => {
    const entries = [untracked('.terraform-version'), untracked('modules-registry.tf'), untracked('tf.plan')]
    const props = { dirPath: '/project', isRepo: true, entries, onRefresh: vi.fn() }
    const { rerender } = render(<GitPanel {...props} refreshKey={0} />)
    await screen.findByRole('option', { name: 'main (current)' })
    const plan = screen.getByRole('checkbox', { name: /tf\.plan/ })
    fireEvent.click(plan)
    expect(plan).not.toBeChecked()
    rerender(<GitPanel {...props} refreshKey={1} />)
    expect(plan).not.toBeChecked()
    expect(screen.getByText('2 of 3 selected')).toBeInTheDocument()
    rerender(<GitPanel {...props} entries={[entries[0], entries[2], untracked('new.tf')]} refreshKey={2} />)
    expect(screen.getByRole('checkbox', { name: /tf\.plan/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /new\.tf/ })).toBeChecked()
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'test' } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Commit 2 of 3' }))
    await waitFor(() => expect(gitCommit).toHaveBeenCalledWith('/project', 'test', ['.terraform-version', 'new.tf']))
    await screen.findByText('Committed abc1234')
    await act(async () => rerender(<GitPanel {...props} entries={[entries[2]]} refreshKey={3} />))
    expect(screen.getByRole('checkbox', { name: /tf\.plan/ })).not.toBeChecked()
  })

  it('does not fall back to committing everything if an excluded file disappears from status', async () => {
    const entries = [untracked('module.tf'), untracked('tf.plan')]
    const props = { dirPath: '/project', isRepo: true, onRefresh: vi.fn() }
    const { rerender } = render(<GitPanel {...props} entries={entries} refreshKey={0} />)
    await screen.findByRole('option', { name: 'main (current)' })
    fireEvent.click(screen.getByRole('checkbox', { name: /tf\.plan/ }))
    rerender(<GitPanel {...props} entries={[entries[0]]} refreshKey={1} />)
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit 1 change' }))
    await waitFor(() => expect(gitCommit).toHaveBeenCalledWith('/project', 'test', ['module.tf']))
  })

  it('keeps a folder excluded when Git starts listing its files separately', async () => {
    const props = { dirPath: '/project', isRepo: true, onRefresh: vi.fn() }
    const { rerender } = render(<GitPanel {...props} entries={[untracked('examples/'), untracked('outside.tf')]} refreshKey={0} />)
    await screen.findByRole('option', { name: 'main (current)' })
    fireEvent.click(screen.getByRole('checkbox', { name: /examples\// }))
    const staged = { path: 'examples/one.tf', index: 'A', worktree: ' ' }
    const rest = untracked('examples/two.tf')
    const neighbor = untracked('examples-other.tf')
    await act(async () => rerender(<GitPanel {...props} entries={[staged, rest, neighbor]} refreshKey={1} />))
    expect(screen.getByRole('checkbox', { name: /examples\/one\.tf/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /examples\/two\.tf/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /examples-other\.tf/ })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: /examples\/one\.tf/ }))
    expect(screen.getByRole('checkbox', { name: /examples\/one\.tf/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /examples\/two\.tf/ })).not.toBeChecked()
    await act(async () => rerender(<GitPanel {...props} entries={[staged, rest, neighbor]} refreshKey={2} />))
    expect(screen.getByRole('checkbox', { name: /examples\/one\.tf/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /examples\/two\.tf/ })).not.toBeChecked()
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'test' } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Commit 2 of 3' }))
    await waitFor(() => expect(gitCommit).toHaveBeenCalledWith('/project', 'test', ['examples/one.tf', 'examples-other.tf']))
  })

  it('keeps a collapsed folder excluded when a child was unchecked', async () => {
    const props = { dirPath: '/project', isRepo: true, onRefresh: vi.fn() }
    const entries = [untracked('examples/two.tf'), untracked('outside.tf')]
    const { rerender } = render(<GitPanel {...props} entries={entries} refreshKey={0} />)
    await screen.findByRole('option', { name: 'main (current)' })
    fireEvent.click(screen.getByRole('checkbox', { name: /examples\/two\.tf/ }))
    await act(async () => rerender(<GitPanel {...props} entries={[untracked('examples/'), entries[1]]} refreshKey={1} />))
    const folder = screen.getByRole('checkbox', { name: /examples\// })
    expect(folder).not.toBeChecked()
    fireEvent.click(folder)
    expect(folder).toBeChecked()
  })

  it('preserves explicit choices within an excluded directory across nested status changes', async () => {
    const props = { dirPath: '/project', isRepo: true, onRefresh: vi.fn() }
    const { rerender } = render(<GitPanel {...props} entries={[untracked('examples/'), untracked('outside.tf')]} refreshKey={0} />)
    await screen.findByRole('option', { name: 'main (current)' })
    fireEvent.click(screen.getByRole('checkbox', { name: /examples\// }))
    await act(async () => rerender(<GitPanel {...props} entries={[untracked('examples/nested/'), untracked('outside.tf')]} refreshKey={1} />))
    fireEvent.click(screen.getByRole('checkbox', { name: /examples\/nested\// }))
    await act(async () => rerender(<GitPanel {...props} entries={[untracked('examples/nested/one.tf'), untracked('examples/nested/two.tf'), untracked('examples/other.tf')]} refreshKey={2} />))
    const one = screen.getByRole('checkbox', { name: /examples\/nested\/one\.tf/ })
    const two = screen.getByRole('checkbox', { name: /examples\/nested\/two\.tf/ })
    expect(one).toBeChecked()
    expect(two).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /examples\/other\.tf/ })).not.toBeChecked()
    fireEvent.click(two)
    expect(one).toBeChecked()
    expect(two).not.toBeChecked()
    await act(async () => rerender(<GitPanel {...props} entries={[untracked('examples/nested/'), untracked('examples/other.tf')]} refreshKey={3} />))
    expect(screen.getByRole('checkbox', { name: /examples\/nested\// })).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: /examples\/nested\// }))
    expect(screen.getByRole('checkbox', { name: /examples\/nested\// })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /examples\/other\.tf/ })).not.toBeChecked()
  })

  it('keeps a previously excluded file unchecked if Git reports a rename', async () => {
    const props = { dirPath: '/project', isRepo: true, onRefresh: vi.fn() }
    const old = { path: 'old.tf', index: ' ', worktree: 'M' }
    const renamed = { path: 'new.tf', origPath: 'old.tf', index: 'R', worktree: ' ' }
    const { rerender } = render(<GitPanel {...props} entries={[old, untracked('outside.tf')]} refreshKey={0} />)
    await screen.findByRole('option', { name: 'main (current)' })
    fireEvent.click(screen.getByRole('checkbox', { name: /old\.tf/ }))
    await act(async () => rerender(<GitPanel {...props} entries={[renamed, untracked('outside.tf')]} refreshKey={1} />))
    expect(screen.getByRole('checkbox', { name: /old\.tf.*new\.tf/ })).not.toBeChecked()
  })

  it('prevents a commit when no files are selected', async () => {
    const entries = [untracked('one.tf'), untracked('two.tf')]
    render(<GitPanel dirPath="/project" isRepo entries={entries} refreshKey={0} onRefresh={() => {}} />)
    await screen.findByRole('option', { name: 'main (current)' })
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'test' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /one\.tf/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /two\.tf/ }))
    expect(screen.getByRole('button', { name: 'Commit 0 of 2' })).toBeDisabled()
    expect(gitCommit).not.toHaveBeenCalled()
  })
})
