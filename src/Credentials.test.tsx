import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import CloudCredentials from './CloudCredentials'
import GitCredentials from './GitCredentials'
import { cloudCredentialAction, getCloudStatus, getGitCredentialStatus, testGitCredentials } from './api'

vi.mock('./api', async importOriginal => {
  const original = await importOriginal<typeof import('./api')>()
  return {
    ...original,
    cloudCredentialAction: vi.fn(),
    getCloudStatus: vi.fn(),
    getGitCredentialStatus: vi.fn(),
    testGitCredentials: vi.fn()
  }
})

describe('credential editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCloudStatus).mockResolvedValue({
      exists: true,
      providers: ['aws', 'github'],
      unlocked: true,
      sessions: {},
      details: { aws: { accessKeyId: 'DUMMY-KEY', region: 'us-east-2', hasSecretAccessKey: true, hasSessionToken: true } }
    })
    vi.mocked(getGitCredentialStatus).mockResolvedValue({
      exists: true,
      providers: ['github'],
      unlocked: true,
      stored: { github: { username: 'sample-user', host: 'git.example', hasToken: true } }
    })
    vi.mocked(cloudCredentialAction).mockResolvedValue({ ok: true, exists: true, providers: ['aws'], unlocked: true, sessions: {} })
    vi.mocked(testGitCredentials).mockResolvedValue({ ok: true, provider: 'github', host: 'git.example', identity: 'sample-user' })
  })

  it('prefills AWS identifiers and updates without sending a blank secret', async () => {
    render(<CloudCredentials />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('AWS access key ID')).toHaveValue('DUMMY-KEY')
    expect(screen.getByLabelText('AWS region')).toHaveValue('us-east-2')
    expect(screen.getByLabelText('AWS secret access key')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('AWS region'), { target: { value: 'us-east-1' } })
    fireEvent.change(screen.getByLabelText('Current credential store passphrase'), { target: { value: 'dummy-passphrase' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(cloudCredentialAction).toHaveBeenCalledWith('update', {
      passphrase: 'dummy-passphrase', credentials: { aws: { accessKeyId: 'DUMMY-KEY', region: 'us-east-1' } }
    }))
  })

  it('prefills Git identifiers and preserves an omitted token', async () => {
    render(<GitCredentials />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('GitHub username')).toHaveValue('sample-user')
    expect(screen.getByLabelText('GitHub instance host')).toHaveValue('git.example')
    expect(screen.getByLabelText('GitHub personal access token')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('Current credential store passphrase for git credentials'), { target: { value: 'dummy-passphrase' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(cloudCredentialAction).toHaveBeenCalledWith('update', {
      passphrase: 'dummy-passphrase', credentials: { github: { username: 'sample-user', host: 'git.example' } }
    }))
  })

  it('removes the Git provider using an update, without deleting the shared store', async () => {
    render(<GitCredentials />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const github = screen.getByRole('group', { name: /GitHub/ })
    fireEvent.click(within(github).getByRole('checkbox', { name: /remove/i }))
    fireEvent.change(screen.getByLabelText('Current credential store passphrase for git credentials'), { target: { value: 'dummy-passphrase' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(cloudCredentialAction).toHaveBeenCalledWith('update', {
      passphrase: 'dummy-passphrase', credentials: {}, removeProviders: ['github']
    }))
  })

  it('shows a successful credential test while the form is open', async () => {
    render(<GitCredentials />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const buttons = screen.getAllByRole('button', { name: 'Test GitHub' })
    fireEvent.click(buttons[buttons.length - 1])
    expect(await screen.findByText(/GitHub OK — authenticated as sample-user/)).toBeInTheDocument()
  })
})
