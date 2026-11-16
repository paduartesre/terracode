import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import TerraformPanel from './TerraformPanel'
import { getTfCostAvailability, getTfStateInfo, getTfVersions, getTerraformPlanJson, listTfVarFiles, runTerraformStream } from './api'

vi.mock('./api', async importOriginal => {
  const original = await importOriginal<typeof import('./api')>()
  return {
    ...original,
    getTfCostAvailability: vi.fn(),
    getTfStateInfo: vi.fn(),
    getTfVersions: vi.fn(),
    getTerraformPlanJson: vi.fn(),
    listTfVarFiles: vi.fn(),
    runTerraformStream: vi.fn()
  }
})

describe('Terraform plan view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getTfVersions).mockResolvedValue({ tfenvAvailable: false, installed: [], active: null })
    vi.mocked(getTfStateInfo).mockResolvedValue({ initialized: false, backend: null, localState: null })
    vi.mocked(listTfVarFiles).mockResolvedValue({ files: [] })
    vi.mocked(getTfCostAvailability).mockResolvedValue({ available: false })
    vi.mocked(getTerraformPlanJson).mockResolvedValue({ rawJson: '{"example":"dummy-sensitive-value"}' })
  })

  afterEach(() => vi.restoreAllMocks())

  it('shows text first and requests raw JSON only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(runTerraformStream).mockImplementation((_command, _path, handlers) => {
      queueMicrotask(() => {
        handlers.onChunk?.('Plan: 1 to add, 0 to change, 0 to destroy.')
        handlers.onDone?.({ command: 'plan', exitCode: 0, timedOut: false, summary: { add: 1, update: 0, replace: 0, destroy: 0 }, output: 'Plan: 1 to add', previewId: 'a'.repeat(32) })
      })
      return () => {}
    })
    render(<TerraformPanel dirPath="/project" logOpen />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    const view = await screen.findByRole('button', { name: 'View raw JSON…' })
    expect(getTerraformPlanJson).not.toHaveBeenCalled()
    fireEvent.click(view)
    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(getTerraformPlanJson).toHaveBeenCalledWith('/project', 'a'.repeat(32)))
    expect(await screen.findByText(/dummy-sensitive-value/)).toBeInTheDocument()
    expect(screen.getByText(/Raw plan JSON can include sensitive values/)).toBeInTheDocument()
  })

  it('explains the difference between an unlocked store and an AWS login', async () => {
    vi.mocked(runTerraformStream).mockImplementation((_command, _path, handlers) => {
      queueMicrotask(() => handlers.onDone?.({ command: 'plan', exitCode: 1, timedOut: false, summary: null, output: 'Error: No valid credential sources found', previewId: null }))
      return () => {}
    })
    render(<TerraformPanel dirPath="/project" logOpen />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    expect(await screen.findByText(/unlocking the store alone does not start a cloud session/)).toBeInTheDocument()
  })
})
