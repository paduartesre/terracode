import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { getTfCostAvailability, getTfStateInfo, getTfVersions, listDir, listTfVarFiles, readFileContent, runTerraform, runTerraformStream } from './api'

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  getTfCostAvailability: vi.fn(),
  getTfStateInfo: vi.fn(),
  getTfVersions: vi.fn(),
  listDir: vi.fn(),
  listTfVarFiles: vi.fn(),
  readFileContent: vi.fn(),
  runTerraform: vi.fn(),
  runTerraformStream: vi.fn(),
}))

describe('Terraform log in the application', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('terracode.tf-project-dir', '/project')
    localStorage.setItem('terracode.sidebar-visibility', JSON.stringify({ left: false, right: false }))
    vi.mocked(listDir).mockResolvedValue([])
    vi.mocked(readFileContent).mockResolvedValue({ path: '/project/main.tf', content: 'terraform {}', mtimeMs: 1 })
    vi.mocked(getTfVersions).mockResolvedValue({ tfenvAvailable: false, installed: [], active: null })
    vi.mocked(getTfStateInfo).mockResolvedValue({ initialized: false, backend: null, localState: null })
    vi.mocked(listTfVarFiles).mockResolvedValue({ files: [] })
    vi.mocked(getTfCostAvailability).mockResolvedValue({ available: false })
    vi.mocked(runTerraform).mockResolvedValue({ command: 'workspace-list', exitCode: 0, timedOut: false, workspaces: [], output: '' })
    vi.mocked(runTerraformStream).mockImplementation((command, _dir, handlers) => {
      queueMicrotask(() => {
        handlers.onChunk?.(`Output from ${command}`)
        if (command === 'fmt') handlers.onDone?.({ command, exitCode: 0, changedFiles: [] })
        else if (command === 'plan') handlers.onDone?.({ command, exitCode: 0, timedOut: false, output: 'Output from plan', previewId: null, summary: null })
        else if (command === 'init' || command === 'validate') handlers.onDone?.({ command, exitCode: 0, timedOut: false, output: `Output from ${command}` })
      })
      return () => {}
    })
  })

  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
    localStorage.clear()
  })

  it.each([false, true])('opens and retains command output with file open: %s', async fileOpen => {
    if (fileOpen) localStorage.setItem('terracode.open-tabs', JSON.stringify({ paths: ['/project/main.tf'], active: '/project/main.tf' }))
    const { container } = render(<App />)
    if (fileOpen) await screen.findByText('/project/main.tf')
    fireEvent.click(screen.getByRole('button', { name: 'Log' }))
    expect(container.querySelector('.tf-live-log')).toHaveTextContent('no command run yet')
    fireEvent.click(screen.getByRole('button', { name: 'Log' }))
    expect(container.querySelector('.tf-live-log')).not.toBeInTheDocument()

    for (const [button, command] of [['Init', 'init'], ['Format', 'fmt'], ['Validate', 'validate'], ['Plan', 'plan']]) {
      fireEvent.click(screen.getByRole('button', { name: button }))
      await waitFor(() => expect(container.querySelector('.tf-live-log')).toHaveTextContent(`Output from ${command}`))
      await waitFor(() => expect(screen.getByRole('button', { name: button })).toBeEnabled())
    }
    fireEvent.click(screen.getByRole('button', { name: 'Log' }))
    expect(container.querySelector('.tf-live-log')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Log' }))
    expect(container.querySelector('.tf-live-log')).toHaveTextContent('Output from plan')
  })
})
