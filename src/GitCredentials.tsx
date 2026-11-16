import { useEffect, useState, type ReactElement } from 'react'
import {
  cloudCredentialAction,
  CREDENTIALS_CHANGED_EVENT,
  getGitCredentialStatus,
  GIT_CRED_PROVIDER_LABELS,
  testGitCredentials,
  type CloudCredentialsPayload,
  type GitCredProvider
} from './api'
import { useCredentialStatus } from './useCredentialStatus'

type FormMode = 'status' | 'register' | 'edit'
type Notice = { text: string; unlocked?: boolean }

// One flat state for both providers so switching sections never loses values.
type GitFields = {
  ghUser: string
  ghToken: string
  ghHost: string
  glUser: string
  glToken: string
  glHost: string
}

const EMPTY_FIELDS: GitFields = {
  ghUser: '',
  ghToken: '',
  ghHost: '',
  glUser: '',
  glToken: '',
  glHost: ''
}

function fieldsToPayload(f: GitFields, removed: GitCredProvider[]): CloudCredentialsPayload {
  const payload: CloudCredentialsPayload = {}
  if (!removed.includes('github') && (f.ghUser !== '' || f.ghToken !== '' || f.ghHost !== '')) {
    payload.github = { ...(f.ghUser !== '' ? { username: f.ghUser } : {}), ...(f.ghToken !== '' ? { token: f.ghToken } : {}), ...(f.ghHost !== '' ? { host: f.ghHost } : {}) }
  }
  if (!removed.includes('gitlab') && (f.glUser !== '' || f.glToken !== '' || f.glHost !== '')) {
    payload.gitlab = { ...(f.glUser !== '' ? { username: f.glUser } : {}), ...(f.glToken !== '' ? { token: f.glToken } : {}), ...(f.glHost !== '' ? { host: f.glHost } : {}) }
  }
  return payload
}

// Git credential registration for the system settings drawer. Shares the same
// global encrypted store as the cloud credentials; while unlocked, git
// push/pull/fetch authenticate against matching hosts automatically.
const GitCredentials = (): ReactElement => {
  const { status, refresh } = useCredentialStatus(getGitCredentialStatus)
  const [mode, setMode] = useState<FormMode>('status')
  const [fields, setFields] = useState<GitFields>(EMPTY_FIELDS)
  // Providers to drop on save (edit mode only; the server keeps the rest).
  const [removeProviders, setRemoveProviders] = useState<GitCredProvider[]>([])

  const [pass1, setPass1] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState<GitCredProvider | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    const clearNotice = () => setNotice(null)
    const clearMessages = () => { clearNotice(); setError('') }
    window.addEventListener(CREDENTIALS_CHANGED_EVENT, clearMessages)
    window.addEventListener('focus', clearNotice)
    return () => {
      window.removeEventListener(CREDENTIALS_CHANGED_EVENT, clearMessages)
      window.removeEventListener('focus', clearNotice)
    }
  }, [])

  // Leaving any form discards typed secrets from state.
  const exitForm = (next: FormMode, noticeText = '', unlocked?: boolean) => {
    setFields(EMPTY_FIELDS)
    setRemoveProviders([])
    setPass1('')
    setPass2('')
    setError('')
    setNotice(noticeText ? { text: noticeText, unlocked } : null)
    setMode(next)
  }

  const beginEdit = () => {
    exitForm('edit')
    setFields({
      ...EMPTY_FIELDS,
      ghUser: status?.stored?.github?.username ?? '',
      ghHost: status?.stored?.github?.host ?? '',
      glUser: status?.stored?.gitlab?.username ?? '',
      glHost: status?.stored?.gitlab?.host ?? ''
    })
  }

  const act = async (
    action: 'create' | 'update' | 'unlock' | 'lock' | 'delete',
    payload?: {
      passphrase?: string
      credentials?: CloudCredentialsPayload
      removeProviders?: string[]
    },
  ): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      await cloudCredentialAction(action, payload)
      refresh() // re-read status incl. stored metadata (username/host/token presence)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  const providerFilled = (provider: GitCredProvider): boolean => {
    if (provider === 'github') return fields.ghUser !== '' || fields.ghToken !== '' || fields.ghHost !== ''
    return fields.glUser !== '' || fields.glToken !== '' || fields.glHost !== ''
  }

  const providerValid = (provider: GitCredProvider): boolean => {
    if (provider === 'github') return fields.ghUser.trim() !== '' && (fields.ghToken.trim() !== '' || status?.stored?.github?.hasToken === true)
    return fields.glUser.trim() !== '' && (fields.glToken.trim() !== '' || status?.stored?.gitlab?.hasToken === true)
  }

  const handleSave = async () => {
    if (busy) return
    const isEdit = mode === 'edit'
    if (!isEdit && pass1.length < 8) {
      setError('Passphrase must be at least 8 characters.')
      return
    }
    if (!isEdit && pass1 !== pass2) {
      setError('Passphrases do not match.')
      return
    }
    const payload = fieldsToPayload(fields, removeProviders)

    for (const provider of Object.keys(payload) as GitCredProvider[]) {
      if (!providerValid(provider)) {
        setError(`Enter both a username and a personal access token for ${GIT_CRED_PROVIDER_LABELS[provider]}.`)
        return
      }
    }
    const isRegister = mode === 'register' || status?.exists !== true
    if (isRegister && Object.keys(payload).length === 0) {
      setError('Fill in at least one credential field.')
      return
    }
    const ok = await act(isRegister ? 'create' : 'update', {
      passphrase: pass1,
      credentials: payload,
      ...(isEdit && removeProviders.length > 0 ? { removeProviders } : {})
    })
    if (ok) exitForm('status', isRegister ? 'Git credentials saved and the store is unlocked.' : 'Git credentials updated.')
  }

  const handleUnlock = async () => {
    if (busy || pass1 === '') return
    const ok = await act('unlock', { passphrase: pass1 })
    if (ok) exitForm('status', 'Unlocked — git push/pull/fetch can now use the stored credentials.', true)
  }

  const handleLock = async () => {
    if (busy) return
    const ok = await act('lock')
    if (ok) exitForm('status', 'Locked — the in-memory copy was discarded.', false)
  }

  // Test with inline form values when present, otherwise the stored entry.
  const handleTest = async (provider: GitCredProvider) => {
    if (busy || testing !== null) return
    setTesting(provider)
    setError('')
    try {
      const inForm = mode === 'register' || mode === 'edit'
      const fieldsForProvider =
        provider === 'github'
          ? { username: fields.ghUser, token: fields.ghToken, host: fields.ghHost }
          : { username: fields.glUser, token: fields.glToken, host: fields.glHost }
      const inline = inForm && fieldsForProvider.token !== ''
      if (inForm && !inline && fieldsForProvider.host.trim() !== '' && fieldsForProvider.host.trim().toLowerCase() !== status?.stored?.[provider]?.host) {
        throw new Error('Enter the token to test a different host before saving.')
      }
      const res = await testGitCredentials(provider, inline ? fieldsForProvider : undefined)
      setNotice({ text: `${GIT_CRED_PROVIDER_LABELS[provider]} OK — authenticated as ${res.identity} on ${res.host}.` })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed')
      refresh()
    } finally {
      setTesting(null)
    }
  }

  const setField = (name: keyof GitFields, value: string) => {
    setFields(f => ({ ...f, [name]: value }))
  }

  const toggleRemove = (provider: GitCredProvider) => {
    setRemoveProviders(list => (list.includes(provider) ? list.filter(p => p !== provider) : [...list, provider]))
  }

  const configured = status?.providers ?? []
  const showForm = mode === 'register' || mode === 'edit'
  const isEdit = mode === 'edit'

  return (
    <div className="tf-creds git-creds">
      <div className="tf-creds-header">
        <span className="tf-opt-label">Git credentials</span>
        {status?.unlocked === true && (
          <span className="tf-chip add" title="Unlocked — git push/pull/fetch use the stored credentials">
            ● unlocked
          </span>
        )}
      </div>

      {status === null ? (
        <p className="tf-status">Loading credential status…</p>
      ) : !status.exists ? (
        <>
          <p className="tf-status">
            No credentials registered yet. Store a GitHub and/or GitLab personal access token here — encrypted on this
            machine only. While the store is unlocked, push/pull/fetch authenticate automatically; existing SSH or system
            credential setups keep working as before.
          </p>
          <div className="tf-creds-row">
            <button onClick={() => exitForm('register')} disabled={busy}>
              Register credentials…
            </button>
          </div>
        </>
      ) : (
        <div className="tf-creds-status">
          <span className="tf-opt-label">Configured:</span>
          {configured.map(p => (
            <span key={p} className="tf-chip" title={`${GIT_CRED_PROVIDER_LABELS[p as GitCredProvider]} credentials are stored`}>
              {GIT_CRED_PROVIDER_LABELS[p as GitCredProvider]}
            </span>
          ))}
          {configured.map(p => {
            const info = status.stored?.[p as GitCredProvider]
            if (!info) return null
            return (
              <p key={`detail-${p}`} className="tf-status">
                {GIT_CRED_PROVIDER_LABELS[p as GitCredProvider]}: {info.username || 'no username'} @ {info.host}
                {info.hasToken ? ' · token stored' : ' · no token stored — add one to enable git auth'}
              </p>
            )
          })}
          {!status.unlocked && (
            <div className="tf-creds-row">
              <input
                type="password"
                value={pass1}
                onChange={e => setPass1(e.target.value)}
                placeholder="Passphrase to unlock"
                aria-label="Credential store passphrase for git credentials"
                disabled={busy}
                onKeyDown={e => {
                  if (e.key === 'Enter') void handleUnlock()
                }}
              />
              <button onClick={() => void handleUnlock()} disabled={busy || pass1 === ''}>
                Unlock
              </button>
            </div>
          )}
          <div className="tf-creds-row">
            {status.unlocked && (
              <button onClick={() => void handleLock()} disabled={busy} title="Discard the in-memory copy now">
                Lock
              </button>
            )}
            {configured.map(p => (
              <button
                key={`test-${p}`}
                onClick={() => void handleTest(p as GitCredProvider)}
                disabled={busy || testing !== null || !status.unlocked}
                title={
                  status.unlocked
                    ? `Verify the stored ${GIT_CRED_PROVIDER_LABELS[p as GitCredProvider]} token against the provider API`
                    : 'Enter your passphrase above and unlock first — a stored token can only be tested while unlocked'
                }
              >
                {testing === (p as GitCredProvider) ? 'Testing…' : `Test ${GIT_CRED_PROVIDER_LABELS[p as GitCredProvider]}`}
              </button>
            ))}
            <button onClick={beginEdit} disabled={busy || !status.unlocked} title="Unlock the store to edit saved identifiers">
              Edit
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="tf-creds-form">
          {(Object.keys(GIT_CRED_PROVIDER_LABELS) as GitCredProvider[]).map(provider => {
            const removed = removeProviders.includes(provider)
            const storedInfo = status?.stored?.[provider]
            return (
              <fieldset key={provider} className={`tf-cred-block${removed ? ' removed' : ''}`}>
                <legend>
                  {GIT_CRED_PROVIDER_LABELS[provider]}
                  {configured.includes(provider) && !isEdit && <span className="tf-chip" title="Already configured">✓</span>}
                  {isEdit && (
                    <label className="tf-cred-remove">
                      <input type="checkbox" checked={removed} onChange={() => toggleRemove(provider)} /> remove
                    </label>
                  )}
                </legend>
                {isEdit && !removed && storedInfo && (
                  <p className="tf-status">
                    Stored: {storedInfo.username || 'no username'} @ {storedInfo.host}
                    {storedInfo.hasToken ? ' · token stored' : ''} — leave the fields below blank to keep it.
                  </p>
                )}
                {!removed && provider === 'github' && (
                  <>
                    <input value={fields.ghUser} onChange={e => setField('ghUser', e.target.value)} placeholder="Username" aria-label="GitHub username" />
                    <input type="password" value={fields.ghToken} onChange={e => setField('ghToken', e.target.value)} placeholder={isEdit && storedInfo?.hasToken ? 'Stored — leave blank to keep current token' : 'Personal access token'} aria-label="GitHub personal access token" autoComplete="off" />
                    <input value={fields.ghHost} onChange={e => setField('ghHost', e.target.value)} placeholder="Instance host (optional — defaults to github.com)" aria-label="GitHub instance host" />
                  </>
                )}
                {!removed && provider === 'gitlab' && (
                  <>
                    <input value={fields.glUser} onChange={e => setField('glUser', e.target.value)} placeholder="Username" aria-label="GitLab username" />
                    <input type="password" value={fields.glToken} onChange={e => setField('glToken', e.target.value)} placeholder={isEdit && storedInfo?.hasToken ? 'Stored — leave blank to keep current token' : 'Personal access token'} aria-label="GitLab personal access token" autoComplete="off" />
                    <input value={fields.glHost} onChange={e => setField('glHost', e.target.value)} placeholder="Instance host (optional — defaults to gitlab.com)" aria-label="GitLab instance host" />
                  </>
                )}
              </fieldset>
            )
          })}

          <p className="tf-status">
            2FA note: account passwords never work over HTTPS git when 2FA is on. Create a Personal Access Token instead —
            GitHub: Settings → Developer settings → Tokens (scope repo); GitLab: Preferences → Access tokens (scopes
            read_repository + write_repository) — and paste it as the token. The username can be your login name or email;
            any value works with a valid token.
          </p>

          {isEdit && (
            <p className="tf-status">Leave a provider's fields empty to keep its stored values, or tick “remove” to drop it.</p>
          )}

          <p className="tf-status">
            Stored encrypted on this machine (~/.terraform-code/credentials.enc) — it survives app restarts. After
            restarting, unlock once with your passphrase and the credentials are available again; saving keeps the store
            unlocked for 15 minutes so you can test right away.
          </p>

          <div className="tf-creds-row">
            <input
              type="password"
              value={pass1}
              onChange={e => setPass1(e.target.value)}
              placeholder={isEdit ? 'Current passphrase' : 'New passphrase (min 8 chars)'}
              aria-label={isEdit ? 'Current credential store passphrase for git credentials' : 'New credential store passphrase for git credentials'}
              disabled={busy}
            />
            {!isEdit && (
              <input
                type="password"
                value={pass2}
                onChange={e => setPass2(e.target.value)}
                placeholder="Repeat passphrase"
                aria-label="Repeat new credential store passphrase for git credentials"
                disabled={busy}
              />
            )}
          </div>
          <div className="tf-creds-row">
            {(Object.keys(GIT_CRED_PROVIDER_LABELS) as GitCredProvider[]).map(provider => (
              <button
                key={`test-${provider}`}
                onClick={() => void handleTest(provider)}
                disabled={busy || testing !== null || !providerFilled(provider)}
                title={`Verify these ${GIT_CRED_PROVIDER_LABELS[provider]} credentials before saving`}
              >
                {testing === provider ? 'Testing…' : `Test ${GIT_CRED_PROVIDER_LABELS[provider]}`}
              </button>
            ))}
            <button onClick={() => void handleSave()} disabled={busy}>
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Register credentials'}
            </button>
            <button onClick={() => exitForm('status')} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error !== '' && <p className="tf-status error">{error}</p>}
      {notice !== null && (notice.unlocked === undefined || notice.unlocked === status?.unlocked) && (
        <p className="tf-status ok">{notice.text}</p>
      )}
    </div>
  )
}

export default GitCredentials
