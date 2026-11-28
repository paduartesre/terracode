import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TerminalPanel from './TerminalPanel'
import {
  closeTerminalSession, connectTerminalStream, createTerminalSession, getTerminalStatus,
  listTerminalSessions, resizeTerminal, restartTerminalSession, sendTerminalInput,
  type TerminalSessionInfo, type TerminalSessionState
} from './api'

// xterm renders into a canvas/real terminal; the tests only need the component's
// session-management behavior, so both packages are replaced with inert classes.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    open() {}
    write() {}
    dispose() {}
    loadAddon() {}
    onData() {}
    focus() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() {} },
}))

// jsdom has no ResizeObserver; the panel debounces fits through it.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  getTerminalStatus: vi.fn(),
  listTerminalSessions: vi.fn(),
  createTerminalSession: vi.fn(),
  closeTerminalSession: vi.fn(),
  restartTerminalSession: vi.fn(),
  connectTerminalStream: vi.fn(),
  sendTerminalInput: vi.fn(),
  resizeTerminal: vi.fn(),
}))

const sess = (id: string, state: TerminalSessionState, dir: string): TerminalSessionInfo => ({ id, state, dir })

describe('TerminalPanel session selection and limits', () => {
  beforeEach(() => {
    vi.mocked(getTerminalStatus).mockResolvedValue({ available: true, maxSessions: 4 })
    vi.mocked(listTerminalSessions).mockResolvedValue({ sessions: [] })
    vi.mocked(createTerminalSession).mockImplementation(async dir => ({ id: `s-new-${Math.random()}`, state: 'starting', dir }))
    vi.mocked(closeTerminalSession).mockResolvedValue({ id: '', state: 'closed' })
    vi.mocked(restartTerminalSession).mockResolvedValue({ id: '', state: 'starting' })
    vi.mocked(connectTerminalStream).mockImplementation(() => vi.fn())
    vi.mocked(sendTerminalInput).mockResolvedValue({ ok: true })
    vi.mocked(resizeTerminal).mockResolvedValue({ ok: true })
  })

  afterEach(() => { cleanup(); vi.resetAllMocks() })

  it('restores an existing live session and highlights it on mount', async () => {
    // A finished record listed before the live one: the restored selection must
    // still land on the live session, with its tab highlighted and host visible.
    const dead = sess('s-dead', 'exited', '/proj/old')
    const live = sess('s-live', 'running', '/proj/app')
    vi.mocked(listTerminalSessions).mockResolvedValue({ sessions: [dead, live] })

    const { container } = render(<TerminalPanel projectDir="/proj" open onToggleOpen={() => {}} />)
    const tab = await screen.findByRole('button', { name: 'app' })
    expect(tab).toHaveClass('active') // selected even though no explicit id was ever set

    const hosts = container.querySelectorAll('.terminal-host')
    expect(hosts).toHaveLength(2)
    expect(hosts[0]).toHaveClass('hidden') // the finished record stays hidden
    expect(hosts[1]).not.toHaveClass('hidden') // the restored live session is shown
  })

  it('selects and shows another available session when the active tab is closed', async () => {
    const a = sess('s-a', 'running', '/proj/alpha')
    const b = sess('s-b', 'running', '/proj/beta')
    vi.mocked(listTerminalSessions).mockResolvedValue({ sessions: [a, b] })

    const { container } = render(<TerminalPanel projectDir="/proj" open onToggleOpen={() => {}} />)
    const tabA = await screen.findByRole('button', { name: 'alpha' })
    expect(tabA).toHaveClass('active') // the first live session is selected initially

    fireEvent.click(screen.getByRole('button', { name: `Close terminal in ${a.dir}` }))
    await waitFor(() => expect(closeTerminalSession).toHaveBeenCalledWith(a.id))

    const tabB = screen.getByRole('button', { name: 'beta' })
    await waitFor(() => expect(tabB).toHaveClass('active')) // the remaining session takes over
    expect(screen.queryByRole('button', { name: 'alpha' })).toBeNull() // closed tab is gone

    const hosts = container.querySelectorAll('.terminal-host')
    expect(hosts).toHaveLength(1)
    expect(hosts[0]).not.toHaveClass('hidden') // the surviving session stays visible, not blank
  })

  it('disables New once every slot is held by a live session', async () => {
    vi.mocked(getTerminalStatus).mockResolvedValue({ available: true, maxSessions: 2 })
    vi.mocked(listTerminalSessions).mockResolvedValue({ sessions: [sess('s-a', 'running', '/proj/a'), sess('s-b', 'starting', '/proj/b')] })

    render(<TerminalPanel projectDir="/proj" open onToggleOpen={() => {}} />)
    const newBtn = await screen.findByRole('button', { name: '+' })
    expect(newBtn).toBeDisabled()
    expect(newBtn).toHaveAttribute('title', 'Session limit reached (2)')
  })

  it('counts only live sessions toward the limit, not finished records', async () => {
    vi.mocked(getTerminalStatus).mockResolvedValue({ available: true, maxSessions: 2 })
    // One live session plus two finished records: three total, but only one slot used.
    vi.mocked(listTerminalSessions).mockResolvedValue({ sessions: [sess('s-a', 'running', '/proj/a'), sess('s-b', 'exited', '/proj/b'), sess('s-c', 'failed', '/proj/c')] })

    render(<TerminalPanel projectDir="/proj" open onToggleOpen={() => {}} />)
    const newBtn = await screen.findByRole('button', { name: '+' })
    expect(newBtn).toBeEnabled() // finished records must not consume live-session slots
  })

  it('minimizing and restoring does not close or disconnect the shell', async () => {
    vi.mocked(listTerminalSessions).mockResolvedValue({ sessions: [sess('s-a', 'running', '/proj/a')] })
    const cancels: Array<() => void> = []
    vi.mocked(connectTerminalStream).mockImplementation(() => {
      const cancel = vi.fn()
      cancels.push(cancel)
      return cancel
    })

    const onToggleOpen = vi.fn()
    const { rerender } = render(<TerminalPanel projectDir="/proj" open onToggleOpen={onToggleOpen} />)
    await screen.findByRole('button', { name: 'a' })
    await waitFor(() => expect(connectTerminalStream).toHaveBeenCalledTimes(1)) // stream attached

    fireEvent.click(screen.getByRole('button', { name: /Minimize terminal/ }))
    expect(onToggleOpen).toHaveBeenCalledTimes(1)
    rerender(<TerminalPanel projectDir="/proj" open={false} onToggleOpen={onToggleOpen} />)

    // Minimized: the panel is hidden by CSS only — nothing may be closed or dropped.
    expect(closeTerminalSession).not.toHaveBeenCalled()
    for (const cancel of cancels) expect(cancel).not.toHaveBeenCalled()

    rerender(<TerminalPanel projectDir="/proj" open onToggleOpen={onToggleOpen} />) // restore
    expect(closeTerminalSession).not.toHaveBeenCalled()
    for (const cancel of cancels) expect(cancel).not.toHaveBeenCalled()
  })
})
