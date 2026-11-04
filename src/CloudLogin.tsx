import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { CLOUD_PROVIDER_LABELS, cloudLogin, cloudLogout, getCloudStatus, type CloudProvider, type CloudStatus } from './api'

type CloudLoginProps = {
  onClose?: () => void
}

// The Login button's panel: pick a registered cloud provider and authenticate
// against it. The server performs the real login via the installed CLI (aws /
// az / gcloud); while a session is active, terraform runs receive that
// provider's credentials as environment variables.
const CloudLogin = ({ onClose }: CloudLoginProps): ReactElement => {
  const [status, setStatus] = useState<CloudStatus | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busyProvider, setBusyProvider] = useState<CloudProvider | null>(null)
  const [feedback, setFeedback] = useState<{ provider: CloudProvider; ok: boolean; text: string }[]>([])

  const refresh = useCallback(() => {
    getCloudStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleLogin = async (provider: CloudProvider) => {
    if (busyProvider !== null || status === null) return
    setBusyProvider(provider)
    setFeedback(f => f.filter(x => x.provider !== provider))
    try {
      const res = await cloudLogin(provider, passphrase.trim() !== '' ? passphrase.trim() : undefined)
      setStatus(s => (s ? { ...s, unlocked: true, sessions: { ...s.sessions, [provider]: res.session } } : s))
      setPassphrase('')
      setFeedback(f => [{ provider, ok: true, text: `Logged in as ${res.session.identity}` }, ...f.filter(x => x.provider !== provider)])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed'
      setFeedback(f => [{ provider, ok: false, text: message }, ...f.filter(x => x.provider !== provider)])
    } finally {
      setBusyProvider(null)
    }
  }

  const handleLogout = async (provider: CloudProvider) => {
    if (busyProvider !== null || status === null) return
    setBusyProvider(provider)
    try {
      await cloudLogout(provider)
      setStatus(s => {
        if (!s) return s
        const sessions = { ...s.sessions }
        delete sessions[provider]
        return { ...s, sessions }
      })
      setFeedback(f => [{ provider, ok: true, text: 'Logged out — terraform runs no longer receive these credentials.' }, ...f.filter(x => x.provider !== provider)])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Logout failed'
      setFeedback(f => [{ provider, ok: false, text: message }, ...f.filter(x => x.provider !== provider)])
    } finally {
      setBusyProvider(null)
    }
  }

  return (
    <div className="tf-creds cloud-login">
      <div className="tf-creds-header">
        <span className="tf-opt-label">Cloud login</span>
        {status?.unlocked === true && <span className="tf-chip add" title="Credential store unlocked">● unlocked</span>}
        {onClose !== undefined && (
          <button type="button" className="recent-clear" onClick={onClose} title="Close" aria-label="Close cloud login">
            ×
          </button>
        )}
      </div>

      {status === null ? (
        <p className="tf-status">Loading credential status…</p>
      ) : !status.exists ? (
        <p className="tf-status">
          No cloud credentials registered yet. Register AWS, Azure and/or Google Cloud keys in Settings (bottom of the
          left sidebar), then come back here to log in.
        </p>
      ) : (
        <>
          {!status.unlocked && (
            <div className="tf-creds-row">
              <input
                type="password"
                value={passphrase}
                onChange={e => setPassphrase(e.target.value)}
                placeholder="Store passphrase (unlocks while you log in)"
                aria-label="Credential store passphrase"
                disabled={busyProvider !== null}
              />
            </div>
          )}

          <div className="cloud-login-list">
            {status.providers.map(provider => {
              const session = status.sessions[provider]
              const busy = busyProvider === provider
              return (
                <div key={provider} className="cloud-login-row">
                  <span className={`tf-chip${session ? ' add' : ''}`} title={session ? `Logged in as ${session.identity}` : 'Not logged in'}>
                    {CLOUD_PROVIDER_LABELS[provider]}
                  </span>
                  <span className="cloud-login-identity" title={session?.identity ?? undefined}>
                    {session ? session.identity : 'not logged in'}
                  </span>
                  <span className="tf-toolbar-spacer" />
                  {session ? (
                    <button onClick={() => void handleLogout(provider)} disabled={busyProvider !== null} title="End the login session for this provider">
                      Log out
                    </button>
                  ) : (
                    <button
                      onClick={() => void handleLogin(provider)}
                      disabled={busyProvider !== null || (!status.unlocked && passphrase.trim() === '')}
                      title={`Authenticate against ${CLOUD_PROVIDER_LABELS[provider]} using the registered credentials`}
                    >
                      {busy ? 'Logging in…' : 'Log in'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {feedback.length > 0 && (
            <div className="cloud-login-feedback">
              {feedback.slice(0, 3).map(f => (
                <p key={`${f.provider}:${f.text}`} className={`tf-status ${f.ok ? 'ok' : 'error'}`}>
                  {CLOUD_PROVIDER_LABELS[f.provider]}: {f.text}
                </p>
              ))}
            </div>
          )}

          <p className="tf-status">
            While logged in, terraform runs receive this provider's credentials automatically (remote state access).
          </p>
        </>
      )}
    </div>
  )
}

export default CloudLogin
