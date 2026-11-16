import { useEffect, useState, type ReactElement } from 'react'
import { CLOUD_PROVIDER_LABELS, CREDENTIALS_CHANGED_EVENT, cloudLogin, cloudLogout, getCloudStatus, type CloudProvider } from './api'
import { useCredentialStatus } from './useCredentialStatus'

type CloudLoginProps = {
  onClose?: () => void
}

// The Login button's panel: pick a registered cloud provider and authenticate
// against it. The server performs the real login via the installed CLI (aws /
// az / gcloud); while a session is active, terraform runs receive that
// provider's credentials as environment variables.
const CloudLogin = ({ onClose }: CloudLoginProps): ReactElement => {
  const { status, refresh } = useCredentialStatus(getCloudStatus)
  const [passphrase, setPassphrase] = useState('')
  const [busyProvider, setBusyProvider] = useState<CloudProvider | null>(null)
  const [feedback, setFeedback] = useState<{ provider: CloudProvider; ok: boolean; text: string }[]>([])

  useEffect(() => {
    const clearFeedback = () => setFeedback([])
    window.addEventListener(CREDENTIALS_CHANGED_EVENT, clearFeedback)
    window.addEventListener('focus', clearFeedback)
    return () => {
      window.removeEventListener(CREDENTIALS_CHANGED_EVENT, clearFeedback)
      window.removeEventListener('focus', clearFeedback)
    }
  }, [])

  const handleLogin = async (provider: CloudProvider) => {
    if (busyProvider !== null || status === null) return
    setBusyProvider(provider)
    setFeedback(f => f.filter(x => x.provider !== provider))
    try {
      await cloudLogin(provider, passphrase !== '' ? passphrase : undefined)
      setPassphrase('')
      const latest = await refresh()
      const session = latest?.unlocked ? latest.sessions[provider] : undefined
      if (session) {
        setFeedback(f => [{ provider, ok: true, text: `Logged in as ${session.identity}` }, ...f.filter(x => x.provider !== provider)])
      }
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
      const latest = await refresh()
      if (latest && (!latest.unlocked || !latest.sessions[provider])) {
        setFeedback(f => [{ provider, ok: true, text: 'Logged out — terraform runs no longer receive these credentials.' }, ...f.filter(x => x.provider !== provider)])
      }
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
            {status.providers.filter((p): p is CloudProvider => Object.hasOwn(CLOUD_PROVIDER_LABELS, p)).map(provider => {
              const session = status.unlocked ? status.sessions[provider] : undefined
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
