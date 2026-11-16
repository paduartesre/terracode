import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { getTfCostAvailability, getTfStateInfo, getTfVersions, listDir, listTfVarFiles, readFileContent, runTerraform, runTerraformStream, saveFileContent } from './api'

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
  saveFileContent: vi.fn()
}))

describe('saving a file that exceeds the size limit', () => {
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
    vi.mocked(runTerraformStream).mockImplementation(() => () => {})
  })

  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
    localStorage.clear()
  })

  it('shows the server error and keeps the unsaved text when a save is rejected', async () => {
    const draft = 'terraform {}\nresource "null_resource" "x" {}'
    localStorage.setItem('terracode.open-tabs', JSON.stringify({ paths: ['/project/main.tf'], active: '/project/main.tf' }))
    vi.mocked(saveFileContent).mockRejectedValue(new Error('Content too large (limit 1024 KB)'))

    render(<App />)
    await screen.findByText('/project/main.tf')
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = document.querySelector('textarea.editor-input') as HTMLTextAreaElement
    expect(editor).not.toBeNull()
    fireEvent.change(editor, { target: { value: draft } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(document.querySelector('.file-status.error')).toHaveTextContent('Content too large (limit 1024 KB)')
    })
    // The rejected save must not discard the user's unsaved text.
    const retained = document.querySelector('textarea.editor-input') as HTMLTextAreaElement
    expect(retained.value).toBe(draft)
  })

  it('clears the error and restores editing after a successful retry', async () => {
    localStorage.setItem('terracode.open-tabs', JSON.stringify({ paths: ['/project/main.tf'], active: '/project/main.tf' }))
    vi.mocked(saveFileContent)
      .mockRejectedValueOnce(new Error('Content too large (limit 1024 KB)'))
      .mockResolvedValueOnce({ path: '/project/main.tf', mtimeMs: 2, size: 10 })

    render(<App />)
    await screen.findByText('/project/main.tf')
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = document.querySelector('textarea.editor-input') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'oversized draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Content too large (limit 1024 KB)')
    expect(editor.value).toBe('oversized draft')

    fireEvent.change(editor, { target: { value: 'small text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved')
    expect(screen.queryByText('Content too large (limit 1024 KB)')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect((document.querySelector('textarea.editor-input') as HTMLTextAreaElement).value).toBe('small text')
  })

  it('clears a save error when the user cancels their edit', async () => {
    localStorage.setItem('terracode.open-tabs', JSON.stringify({ paths: ['/project/main.tf'], active: '/project/main.tf' }))
    vi.mocked(saveFileContent).mockRejectedValue(new Error('Content too large (limit 1024 KB)'))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      render(<App />)
      await screen.findByText('/project/main.tf')
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      const editor = document.querySelector('textarea.editor-input') as HTMLTextAreaElement
      fireEvent.change(editor, { target: { value: 'oversized draft' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await screen.findByText('Content too large (limit 1024 KB)')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(confirm).toHaveBeenCalled()
      expect(screen.queryByText('Content too large (limit 1024 KB)')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()
    } finally {
      confirm.mockRestore()
    }
  })
})
