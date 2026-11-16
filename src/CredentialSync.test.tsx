import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import CloudCredentials from './CloudCredentials'
import CloudLogin from './CloudLogin'
import GitCredentials from './GitCredentials'
import {
  CREDENTIALS_CHANGED_EVENT, cloudCredentialAction, cloudLogin, cloudLogout,
  getCloudStatus, getGitCredentialStatus, type CloudStatus, type GitCredentialStatus
} from './api'

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  cloudCredentialAction: vi.fn(),
  cloudLogin: vi.fn(),
  cloudLogout: vi.fn(),
  getCloudStatus: vi.fn(),
  getGitCredentialStatus: vi.fn()
}))

const session = { loggedInAt: 1, identity: 'dummy-aws-user' }
const unlockedStatus = (loggedIn = true): CloudStatus => ({
  exists: true,
  providers: ['aws', 'github'],
  unlocked: true,
  sessions: loggedIn ? { aws: session } : {},
  details: { aws: { accessKeyId: 'DUMMY-KEY', region: 'us-test-1', hasSecretAccessKey: true, hasSessionToken: false } }
})
const lockedStatus = (): CloudStatus => ({ exists: true, providers: ['aws', 'github'], unlocked: false, sessions: {} })

describe('credential status synchronization', () => {
  beforeEach(() => vi.resetAllMocks())
  afterEach(() => cleanup())

  it('synchronizes lock and login across cloud, Git, and the login panel', async () => {
    let cloud = unlockedStatus()
    vi.mocked(getCloudStatus).mockImplementation(async () => cloud)
    vi.mocked(getGitCredentialStatus).mockImplementation(async (): Promise<GitCredentialStatus> => ({
      exists: true, providers: ['github'], unlocked: cloud.unlocked,
      stored: { github: { username: 'dummy', host: 'github.com', hasToken: true } }
    }))
    vi.mocked(cloudCredentialAction).mockImplementation(async action => {
      if (action === 'lock') cloud = lockedStatus()
      window.dispatchEvent(new Event(CREDENTIALS_CHANGED_EVENT))
      return { ok: true, ...cloud }
    })
    vi.mocked(cloudLogin).mockImplementation(async () => {
      cloud = unlockedStatus()
      window.dispatchEvent(new Event(CREDENTIALS_CHANGED_EVENT))
      return { ok: true, provider: 'aws', session }
    })
    const { container } = render(<><CloudCredentials /><GitCredentials /><CloudLogin /></>)
    const cloudSection = container.querySelector('.cloud-creds') as HTMLElement
    const gitSection = container.querySelector('.git-creds') as HTMLElement
    const loginSection = container.querySelector('.cloud-login') as HTMLElement
    fireEvent.click(await within(cloudSection).findByRole('button', { name: 'Lock' }))
    expect(await within(cloudSection).findByText(/Locked — the in-memory copy was discarded/)).toBeInTheDocument()
    expect(await within(gitSection).findByRole('button', { name: 'Unlock' })).toBeInTheDocument()
    expect(await within(loginSection).findByText('not logged in')).toBeInTheDocument()
    fireEvent.change(within(loginSection).getByLabelText('Credential store passphrase'), { target: { value: 'dummy-passphrase' } })
    fireEvent.click(within(loginSection).getByRole('button', { name: 'Log in' }))
    expect(await within(loginSection).findByText('dummy-aws-user')).toBeInTheDocument()
    await waitFor(() => expect(within(cloudSection).queryByText(/Locked — the in-memory copy was discarded/)).not.toBeInTheDocument())
    expect(within(gitSection).getByRole('button', { name: 'Lock' })).toBeInTheDocument()
    expect(within(cloudSection).queryByText(/secret access key is missing/)).not.toBeInTheDocument()
    expect(await within(loginSection).findByText(/Logged in as dummy-aws-user/)).toBeInTheDocument()
    fireEvent.click(within(gitSection).getByRole('button', { name: 'Lock' }))
    expect(await within(loginSection).findByText('not logged in')).toBeInTheDocument()
    expect(within(loginSection).queryByText(/Logged in as dummy-aws-user/)).not.toBeInTheDocument()
    expect(await within(cloudSection).findByRole('button', { name: 'Unlock' })).toBeInTheDocument()
  })

  it('allows logout and login without requesting the passphrase again', async () => {
    let cloud = unlockedStatus()
    vi.mocked(getCloudStatus).mockImplementation(async () => cloud)
    vi.mocked(cloudLogout).mockImplementation(async () => {
      cloud = unlockedStatus(false)
      window.dispatchEvent(new Event(CREDENTIALS_CHANGED_EVENT))
      return { ok: true, provider: 'aws' }
    })
    vi.mocked(cloudLogin).mockImplementation(async () => {
      cloud = unlockedStatus()
      window.dispatchEvent(new Event(CREDENTIALS_CHANGED_EVENT))
      return { ok: true, provider: 'aws', session }
    })
    render(<CloudLogin />)
    fireEvent.click(await screen.findByRole('button', { name: 'Log out' }))
    expect(await screen.findByText('not logged in')).toBeInTheDocument()
    expect(screen.queryByLabelText('Credential store passphrase')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    await waitFor(() => expect(cloudLogin).toHaveBeenCalledWith('aws', undefined))
    expect(await screen.findByText('dummy-aws-user')).toBeInTheDocument()
  })

  it('uses the latest authenticated identity in login feedback', async () => {
    const latestSession = { loggedInAt: 2, identity: 'newer-dummy-user' }
    vi.mocked(getCloudStatus).mockResolvedValueOnce(unlockedStatus(false))
      .mockResolvedValue({ ...unlockedStatus(), sessions: { aws: latestSession } })
    vi.mocked(cloudLogin).mockResolvedValue({ ok: true, provider: 'aws', session })
    render(<CloudLogin />)
    fireEvent.click(await screen.findByRole('button', { name: 'Log in' }))
    expect(await screen.findByText(/Logged in as newer-dummy-user/)).toBeInTheDocument()
    expect(screen.queryByText(/Logged in as dummy-aws-user/)).not.toBeInTheDocument()
  })

  it('does not claim a secret is missing when an older API omits its status', async () => {
    const cloud = unlockedStatus()
    delete cloud.details!.aws!.hasSecretAccessKey
    vi.mocked(getCloudStatus).mockResolvedValue(cloud)
    render(<CloudCredentials />)
    expect(await screen.findByText(/credential status could not be verified/i)).toBeInTheDocument()
    expect(screen.queryByText(/secret access key is missing/i)).not.toBeInTheDocument()
  })

  it('reports a missing stored secret without claiming cloud authentication is impossible', async () => {
    const cloud = unlockedStatus(false)
    cloud.details!.aws!.hasSecretAccessKey = false
    vi.mocked(getCloudStatus).mockResolvedValue(cloud)
    render(<CloudCredentials />)
    expect(await screen.findByText(/No AWS secret access key is saved in the local store/)).toBeInTheDocument()
    expect(screen.queryByText(/before logging in/i)).not.toBeInTheDocument()
  })

  it('does not show a locked notice until the status reflects the lock', async () => {
    let finishRefresh!: (value: CloudStatus) => void
    vi.mocked(getCloudStatus).mockResolvedValueOnce(unlockedStatus())
      .mockImplementation(() => new Promise(resolve => { finishRefresh = resolve }))
    vi.mocked(cloudCredentialAction).mockResolvedValue({ ok: true, ...lockedStatus() })
    render(<CloudCredentials />)
    fireEvent.click(await screen.findByRole('button', { name: 'Lock' }))
    await waitFor(() => expect(cloudCredentialAction).toHaveBeenCalledWith('lock', undefined))
    expect(screen.queryByText(/Locked — the in-memory copy was discarded/)).not.toBeInTheDocument()
    await act(async () => { finishRefresh(lockedStatus()) })
    expect(await screen.findByText(/Locked — the in-memory copy was discarded/)).toBeInTheDocument()
  })

  it('does not display an AWS session while the shared store is locked', async () => {
    vi.mocked(getCloudStatus).mockResolvedValue({ ...lockedStatus(), sessions: { aws: session } })
    render(<CloudLogin />)
    expect(await screen.findByText('not logged in')).toBeInTheDocument()
    expect(screen.queryByText('dummy-aws-user')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument()
  })

  it('ignores an older response that arrives after a newer status', async () => {
    let finishOlder!: (value: CloudStatus) => void
    let finishNewer!: (value: CloudStatus) => void
    vi.mocked(getCloudStatus).mockResolvedValueOnce(unlockedStatus())
      .mockImplementationOnce(() => new Promise(resolve => { finishOlder = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNewer = resolve }))
    render(<CloudCredentials />)
    await screen.findByRole('button', { name: 'Lock' })
    await act(async () => {
      window.dispatchEvent(new Event(CREDENTIALS_CHANGED_EVENT))
      window.dispatchEvent(new Event(CREDENTIALS_CHANGED_EVENT))
    })
    await act(async () => { finishNewer(unlockedStatus()) })
    await act(async () => { finishOlder(lockedStatus()) })
    expect(screen.getByRole('button', { name: 'Lock' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unlock' })).not.toBeInTheDocument()
  })
})
