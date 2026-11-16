import { useEffect, useState, type ReactElement } from 'react'
import {
  CLOUD_PROVIDER_LABELS,
  CREDENTIALS_CHANGED_EVENT,
  cloudCredentialAction,
  getCloudStatus,
  type CloudCredentialsPayload,
  type CloudProvider
} from './api'
import { useCredentialStatus } from './useCredentialStatus'

type FormMode = 'status' | 'register' | 'edit' | 'change-passphrase' | 'delete'
type Notice = { text: string; unlocked?: boolean }

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

function fieldsToPayload(f: CredFields, removed: CloudProvider[], clearSession: boolean): CloudCredentialsPayload {
  const payload: CloudCredentialsPayload = {}
  if (!removed.includes('aws') && (f.awsAccessKeyId !== '' || f.awsSecretAccessKey !== '' || f.awsSessionToken !== '' || f.awsRegion !== '' || clearSession)) {
    payload.aws = {
      ...(f.awsAccessKeyId !== '' ? { accessKeyId: f.awsAccessKeyId } : {}),
      ...(f.awsSecretAccessKey !== '' ? { secretAccessKey: f.awsSecretAccessKey } : {}),
      ...(clearSession ? { sessionToken: '' } : f.awsSessionToken !== '' ? { sessionToken: f.awsSessionToken } : {}),
      ...(f.awsRegion !== '' ? { region: f.awsRegion } : {})
    }
  }
  if (!removed.includes('azure') && (f.azureClientId !== '' || f.azureClientSecret !== '' || f.azureTenantId !== '' || f.azureSubscriptionId !== '')) {
    payload.azure = {
      ...(f.azureClientId !== '' ? { clientId: f.azureClientId } : {}),
      ...(f.azureClientSecret !== '' ? { clientSecret: f.azureClientSecret } : {}),
      ...(f.azureTenantId !== '' ? { tenantId: f.azureTenantId } : {}),
      ...(f.azureSubscriptionId !== '' ? { subscriptionId: f.azureSubscriptionId } : {})
    }
  }
  if (!removed.includes('gcp') && (f.gcpServiceAccountJson.trim() !== '' || f.gcpProjectId !== '')) {
    payload.gcp = {
      ...(f.gcpServiceAccountJson.trim() !== '' ? { serviceAccountJson: f.gcpServiceAccountJson } : {}),
      ...(f.gcpProjectId !== '' ? { projectId: f.gcpProjectId } : {})
    }
  }
  return payload
}

// Cloud credential registration for the system settings drawer (bottom of the
// left sidebar). The store is global and encrypted; logging in against a cloud
// happens from the Terraform panel's Login button.
const CloudCredentials = (): ReactElement => {
  const { status, refresh } = useCredentialStatus(getCloudStatus)
  const [mode, setMode] = useState<FormMode>('status')
  const [fields, setFields] = useState<CredFields>(EMPTY_FIELDS)
  // Providers to drop on save (edit mode only; the server keeps the rest).
  const [removeProviders, setRemoveProviders] = useState<CloudProvider[]>([])
  const [clearSession, setClearSession] = useState(false)

  const [pass1, setPass1] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)
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
    setClearSession(false)
    setPass1('')
    setPass2('')
    setError('')
    setNotice(noticeText ? { text: noticeText, unlocked } : null)
    setMode(next)
  }

  const beginEdit = () => {
    exitForm('edit')
    const details = status?.details
    setFields({
      ...EMPTY_FIELDS,
      awsAccessKeyId: details?.aws?.accessKeyId ?? '',
      awsRegion: details?.aws?.region ?? '',
      azureClientId: details?.azure?.clientId ?? '',
      azureTenantId: details?.azure?.tenantId ?? '',
      azureSubscriptionId: details?.azure?.subscriptionId ?? '',
      gcpProjectId: details?.gcp?.projectId ?? ''
    })
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
      await cloudCredentialAction(action, payload)
      refresh()
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
    const isRegister = mode === 'register' || status?.exists !== true
    if (isRegister && pass1 !== pass2) {
      setError('Passphrases do not match.')
      return
    }
    const payload = fieldsToPayload(fields, removeProviders, clearSession)
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
    if (ok) exitForm('status', 'Unlocked — you can now log in from the Terraform panel.', true)
  }

  const handleLock = async () => {
    if (busy) return
    const ok = await act('lock')
    if (ok) exitForm('status', 'Locked — the in-memory copy was discarded.', false)
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
      'Delete the local credential store, including Git credentials? No cloud resources or remote accounts will be deleted.',
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

  // The shared store can also hold git providers (github/gitlab); those are
  // managed in the Git credentials section, so only cloud ones appear here.
  const configured = (status?.providers ?? []).filter((p): p is CloudProvider => Object.hasOwn(CLOUD_PROVIDER_LABELS, p))
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
          {status.unlocked && status.details && configured.map(p => {
            const d = status.details?.[p]
            if (!d) return null
            const parts = Object.values(d).filter((v): v is string => typeof v === 'string' && v !== '')
            if (parts.length === 0) return null
            return (
              <p key={`detail-${p}`} className="tf-status">
                {CLOUD_PROVIDER_LABELS[p]}: {parts.join(' · ')}
              </p>
            )
          })}
          {configured.some(p => !status.sessions[p]) && status.unlocked && (
            <p className="tf-status">Unlocked only opens the local store. Use Login in the Terraform panel to authenticate before running cloud commands.</p>
          )}
          {status.unlocked && status.details?.aws?.hasSecretAccessKey === false && (
            <p className="tf-status error">No AWS secret access key is saved in the local store. Add one in Edit to use stored AWS credentials.</p>
          )}
          {status.unlocked && status.details?.aws && status.details.aws.hasSecretAccessKey === undefined && (
            <p className="tf-status">AWS credential status could not be verified. Restart TerraCode if the server is out of date.</p>
          )}
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
            <button onClick={beginEdit} disabled={busy || !status.unlocked} title="Unlock the store to edit saved identifiers">
              Edit
            </button>
            <button onClick={() => exitForm('change-passphrase')} disabled={busy}>
              Change passphrase
            </button>
            <button className="danger" onClick={() => exitForm('delete')} disabled={busy} title="Delete the local encrypted store">
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
                    <input type="password" value={fields.awsSecretAccessKey} onChange={e => setField('awsSecretAccessKey', e.target.value)} placeholder={isEdit && status?.details?.aws?.hasSecretAccessKey ? 'Stored — leave blank to keep current secret' : 'Secret access key'} aria-label="AWS secret access key" autoComplete="off" />
                    <div className="tf-creds-row">
                      <input type="password" value={fields.awsSessionToken} onChange={e => setField('awsSessionToken', e.target.value)} placeholder="Session token (STS only)" aria-label="AWS session token" autoComplete="off" />
                      <input value={fields.awsRegion} onChange={e => setField('awsRegion', e.target.value)} placeholder="Region, e.g. us-east-2" aria-label="AWS region" />
                    </div>
                    {isEdit && status?.details?.aws?.hasSessionToken && (
                      <label className="tf-cred-remove">
                        <input type="checkbox" checked={clearSession} onChange={e => setClearSession(e.target.checked)} /> Clear saved session token
                      </label>
                    )}
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
              Identifiers are filled in for editing. Leave secret fields empty to keep their stored values; tick “remove” to remove a provider locally.
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

      {mode === 'delete' && (
        <div className="tf-creds-form">
          <p className="tf-status">Only the local credential store is removed; remote resources and accounts are not changed.</p>
          <input type="password" value={pass1} onChange={e => setPass1(e.target.value)} placeholder="Current passphrase" aria-label="Passphrase to delete local credentials" disabled={busy} />
          <div className="tf-creds-row">
            <button className="danger" onClick={() => void handleDelete()} disabled={busy || pass1 === ''}>Delete local store</button>
            <button onClick={() => exitForm('status')} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {error !== '' && <p className="tf-status error">{error}</p>}
      {notice !== null && !showForm && mode === 'status' && (notice.unlocked === undefined || notice.unlocked === status?.unlocked) && (
        <p className="tf-status ok">{notice.text}</p>
      )}
    </div>
  )
}

export default CloudCredentials
