import { useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  CLOUD_PROVIDER_LABELS,
  cloudCredentialAction,
  getCloudStatus,
  type CloudCredActionResult,
  type CloudCredentialsPayload,
  type CloudProvider,
  type CloudStatus
} from './api'

type FormMode = 'status' | 'register' | 'edit' | 'change-passphrase'

// All credential fields in one flat state so switching between provider
// sections never loses typed values.
type CredFields = {
  awsAccessKeyId: string
  awsSecretAccessKey: string
  awsSessionToken: string
  awsRegion: string
  azureClientId: string
  azureClientSecret: string
  azureTenantId: string
  azureSubscriptionId: string
  gcpServiceAccountJson: string
  gcpProjectId: string
}

const EMPTY_FIELDS: CredFields = {
  awsAccessKeyId: '',
  awsSecretAccessKey: '',
  awsSessionToken: '',
  awsRegion: '',
  azureClientId: '',
  azureClientSecret: '',
  azureTenantId: '',
  azureSubscriptionId: '',
  gcpServiceAccountJson: '',
  gcpProjectId: ''
}

function fieldsToPayload(f: CredFields): CloudCredentialsPayload {
  const payload: CloudCredentialsPayload = {}
  if (f.awsAccessKeyId !== '' || f.awsSecretAccessKey !== '' || f.awsSessionToken !== '' || f.awsRegion !== '') {
    payload.aws = {
      accessKeyId: f.awsAccessKeyId,
      secretAccessKey: f.awsSecretAccessKey,
      sessionToken: f.awsSessionToken,
      region: f.awsRegion
    }
  }
  if (f.azureClientId !== '' || f.azureClientSecret !== '' || f.azureTenantId !== '' || f.azureSubscriptionId !== '') {
    payload.azure = {
      clientId: f.azureClientId,
      clientSecret: f.azureClientSecret,
      tenantId: f.azureTenantId,
      subscriptionId: f.azureSubscriptionId
    }
  }
  if (f.gcpServiceAccountJson.trim() !== '' || f.gcpProjectId !== '') {
    payload.gcp = { serviceAccountJson: f.gcpServiceAccountJson, projectId: f.gcpProjectId }
  }
  return payload
}

// Cloud credential registration for the system settings drawer (bottom of the
// left sidebar). The store is global and encrypted; logging in against a cloud
// happens from the Terraform panel's Login button.
const CloudCredentials = (): ReactElement => {
  const [status, setStatus] = useState<CloudStatus | null>(null)
  const [mode, setMode] = useState<FormMode>('status')
  const [fields, setFields] = useState<CredFields>(EMPTY_FIELDS)
  // Providers to drop on save (edit mode only; the server keeps the rest).
  const [removeProviders, setRemoveProviders] = useState<CloudProvider[]>([])

  const [pass1, setPass1] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(() => {
    getCloudStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Leaving any form discards typed secrets from state.
  const exitForm = (next: FormMode, noticeText = '') => {
    setFields(EMPTY_FIELDS)
    setRemoveProviders([])
    setPass1('')
    setPass2('')
    setError('')
    setNotice(noticeText)
    setMode(next)
  }

  const act = async (
    action: 'create' | 'update' | 'change-passphrase' | 'unlock' | 'lock' | 'delete',
    payload?: {
      passphrase?: string
      oldPassphrase?: string
      newPassphrase?: string
      credentials?: CloudCredentialsPayload
      removeProviders?: string[]
    },
  ): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      const res: CloudCredActionResult = await cloudCredentialAction(action, payload)
      setStatus(res)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  const handleSave = async () => {
    if (busy) return
    if (pass1.length < 8) {
      setError('Passphrase must be at least 8 characters.')
      return
    }
    if (pass1 !== pass2) {
      setError('Passphrases do not match.')
      return
    }
    const payload = fieldsToPayload(fields)
    const isRegister = mode === 'register' || status?.exists !== true
    if (isRegister && Object.keys(payload).length === 0) {
      setError('Fill in at least one credential field.')
      return
    }
    const ok = await act(isRegister ? 'create' : 'update', {
      passphrase: pass1,
      credentials: payload,
      ...(mode === 'edit' && removeProviders.length > 0 ? { removeProviders } : {})
    })
    if (ok) exitForm('status', isRegister ? 'Cloud credentials registered.' : 'Cloud credentials updated.')
  }

  const handleUnlock = async () => {
    if (busy || pass1 === '') return
    const ok = await act('unlock', { passphrase: pass1 })
    if (ok) exitForm('status', 'Unlocked — you can now log in from the Terraform panel.')
  }

  const handleLock = async () => {
    if (busy) return
    const ok = await act('lock')
    if (ok) exitForm('status', 'Locked — the in-memory copy was discarded.')
  }

  const handleChangePassphrase = async () => {
    if (busy) return
    if (pass2.length < 8) {
      setError('New passphrase must be at least 8 characters.')
      return
    }
    const ok = await act('change-passphrase', { oldPassphrase: pass1, newPassphrase: pass2 })
    if (ok) exitForm('status', 'Passphrase changed.')
  }

  const handleDelete = async () => {
    if (busy || pass1 === '') return
    const ok = window.confirm(
      'Delete the registered cloud credentials? All active logins end and terraform runs stop receiving them.',
    )
    if (!ok) return
    const done = await act('delete', { passphrase: pass1 })
    if (done) exitForm('status', 'Cloud credentials deleted.')
  }

  const setField = (name: keyof CredFields, value: string) => {
    setFields(f => ({ ...f, [name]: value }))
  }

  const toggleRemove = (provider: CloudProvider) => {
    setRemoveProviders(list =>
      list.includes(provider) ? list.filter(p => p !== provider) : [...list, provider],
    )
  }

  const configured = status?.providers ?? []
  const showForm = mode === 'register' || mode === 'edit'
  const isEdit = mode === 'edit'

  return (
    <div className="tf-creds cloud-creds">
      <div className="tf-creds-header">
        <span className="tf-opt-label">Cloud credentials</span>
        {status?.unlocked === true && (
          <span className="tf-chip add" title="Unlocked — ready to log in from the Terraform panel">
            ● unlocked
          </span>
        )}
      </div>

      {status === null ? (
        <p className="tf-status">Loading credential status…</p>
      ) : !status.exists ? (
        <>
          <p className="tf-status">
            No cloud credentials registered yet. Register AWS, Azure and/or Google Cloud keys here — they are stored
            encrypted on this machine only. Log in from the Terraform panel's Login button.
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
            <span key={p} className="tf-chip" title={`${CLOUD_PROVIDER_LABELS[p]} credentials are stored`}>
              {CLOUD_PROVIDER_LABELS[p]}
            </span>
          ))}
          {!status.unlocked && (
            <div className="tf-creds-row">
              <input
                type="password"
                value={pass1}
                onChange={e => setPass1(e.target.value)}
                placeholder="Passphrase to unlock"
                aria-label="Credential store passphrase"
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
            <button onClick={() => exitForm('edit')} disabled={busy} title="Edit stored credentials (asks for the current passphrase)">
              Edit
            </button>
            <button onClick={() => exitForm('change-passphrase')} disabled={busy}>
              Change passphrase
            </button>
            <button className="danger" onClick={() => void handleDelete()} disabled={busy} title="Delete the encrypted store">
              Delete…
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="tf-creds-form">
          {(Object.keys(CLOUD_PROVIDER_LABELS) as CloudProvider[]).map(provider => {
            const removed = removeProviders.includes(provider)
            return (
              <fieldset key={provider} className={`tf-cred-block${removed ? ' removed' : ''}`}>
                <legend>
                  {CLOUD_PROVIDER_LABELS[provider]}
                  {configured.includes(provider) && !isEdit && <span className="tf-chip" title="Already configured">✓</span>}
                  {isEdit && (
                    <label className="tf-cred-remove">
                      <input type="checkbox" checked={removed} onChange={() => toggleRemove(provider)} /> remove
                    </label>
                  )}
                </legend>
                {provider === 'aws' && !removed && (
                  <>
                    <input value={fields.awsAccessKeyId} onChange={e => setField('awsAccessKeyId', e.target.value)} placeholder="Access key ID" aria-label="AWS access key ID" />
                    <input type="password" value={fields.awsSecretAccessKey} onChange={e => setField('awsSecretAccessKey', e.target.value)} placeholder="Secret access key" aria-label="AWS secret access key" autoComplete="off" />
                    <div className="tf-creds-row">
                      <input type="password" value={fields.awsSessionToken} onChange={e => setField('awsSessionToken', e.target.value)} placeholder="Session token (STS only)" aria-label="AWS session token" autoComplete="off" />
                      <input value={fields.awsRegion} onChange={e => setField('awsRegion', e.target.value)} placeholder="Region, e.g. us-east-2" aria-label="AWS region" />
                    </div>
                  </>
                )}
                {provider === 'azure' && !removed && (
                  <>
                    <input value={fields.azureClientId} onChange={e => setField('azureClientId', e.target.value)} placeholder="Client ID" aria-label="Azure client ID" />
                    <input type="password" value={fields.azureClientSecret} onChange={e => setField('azureClientSecret', e.target.value)} placeholder="Client secret" aria-label="Azure client secret" autoComplete="off" />
                    <div className="tf-creds-row">
                      <input value={fields.azureTenantId} onChange={e => setField('azureTenantId', e.target.value)} placeholder="Tenant ID" aria-label="Azure tenant ID" />
                      <input value={fields.azureSubscriptionId} onChange={e => setField('azureSubscriptionId', e.target.value)} placeholder="Subscription ID" aria-label="Azure subscription ID" />
                    </div>
                  </>
                )}
                {provider === 'gcp' && !removed && (
                  <>
                    <textarea
                      value={fields.gcpServiceAccountJson}
                      onChange={e => setField('gcpServiceAccountJson', e.target.value)}
                      placeholder='Service-account key JSON (from gcloud / the GCP console)'
                      aria-label="GCP service account key JSON"
                      rows={4}
                    />
                    <input value={fields.gcpProjectId} onChange={e => setField('gcpProjectId', e.target.value)} placeholder="Project ID (optional — defaults to the key's project)" aria-label="GCP project ID" />
                  </>
                )}
              </fieldset>
            )
          })}

          {isEdit && (
            <p className="tf-status">
              Leave a provider's fields empty to keep its stored values, or tick “remove” to drop it. Saving replaces the
              filled-in providers.
            </p>
          )}

          <div className="tf-creds-row">
            <input
              type="password"
              value={pass1}
              onChange={e => setPass1(e.target.value)}
              placeholder={isEdit ? 'Current passphrase' : 'New passphrase (min 8 chars)'}
              aria-label={isEdit ? 'Current credential store passphrase' : 'New credential store passphrase'}
              disabled={busy}
            />
            {!isEdit && (
              <input
                type="password"
                value={pass2}
                onChange={e => setPass2(e.target.value)}
                placeholder="Repeat passphrase"
                aria-label="Repeat new credential store passphrase"
                disabled={busy}
              />
            )}
          </div>
          <div className="tf-creds-row">
            <button onClick={() => void handleSave()} disabled={busy}>
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Register credentials'}
            </button>
            <button onClick={() => exitForm('status')} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === 'change-passphrase' && (
        <div className="tf-creds-form">
          <div className="tf-creds-row">
            <input type="password" value={pass1} onChange={e => setPass1(e.target.value)} placeholder="Current passphrase" aria-label="Current passphrase" disabled={busy} />
            <input type="password" value={pass2} onChange={e => setPass2(e.target.value)} placeholder="New passphrase (min 8 chars)" aria-label="New passphrase" disabled={busy} />
          </div>
          <div className="tf-creds-row">
            <button onClick={() => void handleChangePassphrase()} disabled={busy || pass1 === '' || pass2 === ''}>
              {busy ? 'Changing…' : 'Change passphrase'}
            </button>
            <button onClick={() => exitForm('status')} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error !== '' && <p className="tf-status error">{error}</p>}
      {notice !== '' && !showForm && mode !== 'change-passphrase' && <p className="tf-status ok">{notice}</p>}
    </div>
  )
}

export default CloudCredentials
