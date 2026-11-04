import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import CloudLogin from './CloudLogin'
import PlanGraph from './PlanGraph'
import RegistryPanel from './RegistryPanel'
import TfProjectPicker from './TfProjectPicker'
import { costFailureDetail, costNeedsApiKey, driftOutcome } from './tfStatus'
import {
  getTfCost,
  getTfCostAvailability,
  getTfStateInfo,
  getTfVersions,
  installTfVersion,
  listTfVarFiles,
  runTerraform,
  runTerraformStream,
  setTfVersion,
  type TfCommand,
  type TfCostResult,
  type TfPlanSummary,
  type TfRunOptions,
  type TfRunResult,
  type TfStateInfo,
  type TfVarFile,
  type TfVersions,
  type TfWorkspace
} from './api'

type TerraformPanelProps = {
  // Effective working directory for terraform commands. null = no project loaded
  // and no file open: the panel offers to load a project folder instead.
  dirPath: string | null
  // The explicitly loaded project (null when following the open file's folder).
  projectDir?: string | null
  onLoadProject?: (dirPath: string | null) => void
  onFmtApplied?: (changedPaths: string[]) => void
  // Log view: when open, App hides the code and this panel fills the pane with
  // the live command log. Toggled by the "Log" toolbar button.
  logOpen?: boolean
  onToggleLog?: () => void
}

const TF_VERSION_RE = /^\d+\.\d+(\.\d+)?(-[A-Za-z0-9.]+)?$/
// Mirrors the server-side validation for resource addresses and workspace names,
// so bad input is caught before it reaches the backend.
const TF_ADDRESS_RE = /^[A-Za-z0-9_-]+(\[[0-9]+\])?(\.[A-Za-z0-9_-]+(\[[0-9]+\])?)*$/
const TF_WORKSPACE_RE = /^[A-Za-z0-9_-]{1,255}$/

// Commands that accept an explicit -var-file. Auto-loaded files are skipped —
// terraform already picks those up without the flag.
const VARFILE_COMMANDS: ReadonlySet<TfCommand> = new Set([
  'init',
  'init-upgrade',
  'plan-json',
  'drift',
  'plan-file',
  'plan-file-destroy'
])

// Drift auto-check interval (minutes); 0 = off. Persisted globally.
const DRIFT_INTERVAL_KEY = 'app-test.tf-drift-interval'
const DRIFT_INTERVALS = [5, 10, 30] as const

// Failed checks are status feedback, not results: they auto-dismiss so a stale
// red badge/section does not linger on screen (full output stays in the Log).
const DRIFT_ERROR_DISMISS_MS = 10_000
const COST_FAIL_DISMISS_MS = 15_000

function loadDriftInterval(): number {
  try {
    const v = Number(localStorage.getItem(DRIFT_INTERVAL_KEY))
    return (DRIFT_INTERVALS as readonly number[]).includes(v) ? v : 0
  } catch {
    return 0
  }
}

function saveDriftInterval(minutes: number): void {
  try {
    localStorage.setItem(DRIFT_INTERVAL_KEY, String(minutes))
  } catch {
    // storage unavailable; the choice just won't persist
  }
}

const VARFILES_KEY = 'app-test.tf-varfiles'

// Per-directory remembered var file choice (dirPath -> file name).
function loadVarFileMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(VARFILES_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function saveVarFileChoice(dirPath: string, name: string): void {
  try {
    const map = loadVarFileMap()
    if (name === '') delete map[dirPath]
    else map[dirPath] = name
    localStorage.setItem(VARFILES_KEY, JSON.stringify(map))
  } catch {
    // storage unavailable; the choice just won't persist
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) || p : p
}

function planHasChanges(summary: TfPlanSummary | null): boolean {
  return summary !== null && summary.add + summary.update + summary.replace + summary.destroy > 0
}

// Human label for the "Running terraform …" indicator.
function runningLabel(c: TfCommand): string {
  switch (c) {
    case 'plan-json':
      return 'plan'
    case 'drift':
      return 'plan (drift check)'
    case 'graph':
      return 'graph'
    case 'init-upgrade':
      return 'init -upgrade'
    case 'plan-file-destroy':
      return 'plan -destroy'
    default:
      return c
  }
}

// One-line summary shown above the live log in Log view.
function logStatusText(result: TfRunResult): { ok: boolean; text: string } {
  switch (result.command) {
    case 'fmt':
      return result.error
        ? { ok: false, text: `Format failed: ${result.error}` }
        : {
            ok: true,
            text:
              result.changedFiles.length === 0
                ? 'Format finished — no changes needed.'
                : `Format finished — ${result.changedFiles.length} file(s) changed.`,
          }
    case 'validate':
      return result.valid
        ? { ok: true, text: `Validate finished — configuration is valid${result.warningCount > 0 ? ` (${result.warningCount} warnings)` : ''}.` }
        : { ok: false, text: `Validate finished — ${result.errorCount} error(s).` }
    case 'init-upgrade':
      if (result.timedOut) return { ok: false, text: 'Init timed out before finishing.' }
      if (result.exitCode === 0) return { ok: true, text: 'Init finished — dependencies upgraded to the latest allowed versions.' }
      return { ok: false, text: `Init exited with code ${result.exitCode}.` }
    case 'version':
      if (result.version !== null)
        return { ok: true, text: `Terraform ${result.version}${result.platform ? ` on ${result.platform}` : ''}.` }
      return result.timedOut
        ? { ok: false, text: 'Command timed out before finishing.' }
        : { ok: false, text: 'Could not parse the version output — see the log below.' }
    case 'drift':
      if (result.timedOut) return { ok: false, text: 'Drift check timed out before finishing.' }
      if (result.drifted === true) {
        const s = result.summary
        return {
          ok: false,
          text: `Drift detected — ${s ? `${s.add} to add, ${s.update} to change, ${s.replace} to replace, ${s.destroy} to destroy` : 'changes found'}. Run Plan for details.`,
        }
      }
      if (result.drifted === false) return { ok: true, text: 'No drift — state matches the actual infrastructure.' }
      return { ok: false, text: `Drift check failed (exit code ${result.exitCode}).` }
    case 'graph':
      if (result.timedOut) return { ok: false, text: 'Graph timed out before finishing.' }
      if (result.exitCode === 0)
        return { ok: true, text: `Dependency graph built — ${result.nodes.length} node(s), ${result.edges.length} edge(s).` }
      return { ok: false, text: `terraform graph exited with code ${result.exitCode}.` }
    case 'show-plan':
      if (result.timedOut) return { ok: false, text: 'Show timed out before finishing.' }
      if (result.exitCode === 0) return { ok: true, text: 'Saved execution plan rendered from tf.plan.' }
      return { ok: false, text: `terraform show exited with code ${result.exitCode}.` }
    case 'plan-file-destroy':
      if (result.timedOut) return { ok: false, text: 'Plan timed out before finishing.' }
      if (result.exitCode === 0)
        return { ok: true, text: 'Destroy plan saved to tf.plan. Review it, then apply explicitly — applying will delete resources.' }
      return { ok: false, text: `Planning failed (exit code ${result.exitCode}).` }
    case 'import':
      if (result.timedOut) return { ok: false, text: 'Import timed out before finishing.' }
      if (result.exitCode === 0) return { ok: true, text: `Imported ${result.address} into state.` }
      return { ok: false, text: `Import exited with code ${result.exitCode}.` }
    case 'state-mv':
      if (result.timedOut) return { ok: false, text: 'State move timed out before finishing.' }
      if (result.exitCode === 0) return { ok: true, text: `Moved ${result.srcAddress} to ${result.destAddress}.` }
      return { ok: false, text: `state mv exited with code ${result.exitCode}.` }
    case 'state-rm':
      if (result.timedOut) return { ok: false, text: 'State remove timed out before finishing.' }
      if (result.exitCode === 0)
        return { ok: true, text: `Removed ${result.address} from state — the cloud resource was NOT deleted.` }
      return { ok: false, text: `state rm exited with code ${result.exitCode}.` }
    default:
      if (result.timedOut) return { ok: false, text: 'Command timed out before finishing.' }
      if (result.exitCode === 0) return { ok: true, text: 'Command finished successfully.' }
      return { ok: false, text: `Command exited with code ${result.exitCode}.` }
  }
}

type ConsoleEntry = { expr: string; output: string; ok: boolean }

const TerraformPanel = ({ dirPath, projectDir = null, onLoadProject, onFmtApplied, logOpen = false, onToggleLog }: TerraformPanelProps): ReactElement => {
  const [running, setRunning] = useState<TfCommand | null>(null)
  const [result, setResult] = useState<TfRunResult | null>(null)
  const [error, setError] = useState('')

  // The Version result is informational — it auto-hides after a short while.
  const [versionDismissed, setVersionDismissed] = useState(false)
  const versionTimerRef = useRef<number | null>(null)

  // Live command output for the Log view (accumulated SSE chunks).
  const [logText, setLogText] = useState('')
  const logRef = useRef<HTMLPreElement | null>(null)

  // Keep the live log pinned to the bottom while new output arrives.
  useEffect(() => {
    if (!logOpen) return
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logText, running, result, logOpen])

  // Clear any pending version auto-dismiss timer on unmount.
  useEffect(
    () => () => {
      if (versionTimerRef.current !== null) window.clearTimeout(versionTimerRef.current)
    },
    [],
  )

  // Guarded apply flow: after `plan-file` succeeds (applyReady), the user can
  // explicitly confirm and run `apply`, which only ever applies tf.plan.
  const [applyReady, setApplyReady] = useState(false)
  // Same guard for the destroy flow (`plan-file-destroy` -> explicit apply).
  const [destroyReady, setDestroyReady] = useState(false)

  // tfenv version management for this folder (.terraform-version pinning)
  const [tfVersions, setTfVersions] = useState<TfVersions | null>(null)
  const [versionBusy, setVersionBusy] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [installError, setInstallError] = useState('')

  // Project folder picker (load a Terraform project from a specific folder).
  const [pickerOpen, setPickerOpen] = useState(false)

  // Init options: -upgrade checkbox + backend config pairs for remote state.
  const [initOptionsOpen, setInitOptionsOpen] = useState(false)
  const [upgradeDeps, setUpgradeDeps] = useState(false)
  const [backendPairs, setBackendPairs] = useState<{ key: string; value: string }[]>([{ key: '', value: '' }])

  // State backend + workspaces + var files for the state bar.
  const [stateInfo, setStateInfo] = useState<TfStateInfo | null>(null)
  const [workspaces, setWorkspaces] = useState<TfWorkspace[] | null>(null)
  const [wsBusy, setWsBusy] = useState(false)
  const [varFiles, setVarFiles] = useState<{ files: TfVarFile[] } | null>(null)
  const [selectedVarFile, setSelectedVarFile] = useState<string>(() => (dirPath !== null ? loadVarFileMap()[dirPath] ?? '' : ''))

  // Console expression evaluator.
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleExpr, setConsoleExpr] = useState('')
  const [consoleBusy, setConsoleBusy] = useState(false)
  const [consoleHistory, setConsoleHistory] = useState<ConsoleEntry[]>([])

  // Cloud credentials (encrypted per-project store; "Login" in the toolbar).
  const [credsOpen, setCredsOpen] = useState(false)

  // Dependency graph view (terraform graph): data from the last successful run
  // plus whether the interactive section is open.
  const [graphData, setGraphData] = useState<{ nodes: { id: string; label?: string }[]; edges: [string, string][] } | null>(null)
  const [graphOpen, setGraphOpen] = useState(false)

  // Module registry browser (inline section like the console).
  const [registryOpen, setRegistryOpen] = useState(false)

  // Drift detection: last check result + auto-check interval in minutes.
  type DriftState = {
    status: 'idle' | 'checking' | 'ok' | 'drifted' | 'error'
    checkedAt?: number
    summary?: TfPlanSummary | null
    message?: string
  }
  const [drift, setDrift] = useState<DriftState>({ status: 'idle' })
  const [driftInterval, setDriftInterval] = useState<number>(loadDriftInterval)
  const driftBusyRef = useRef(false)
  const driftDismissRef = useRef<number | null>(null)

  // Cost estimation (infracost): availability + last estimate.
  const [costAvailable, setCostAvailable] = useState<boolean | null>(null)
  const [costOpen, setCostOpen] = useState(false)
  const [costBusy, setCostBusy] = useState(false)
  const [costResult, setCostResult] = useState<TfCostResult | null>(null)
  const [costError, setCostError] = useState('')
  const costDismissRef = useRef<number | null>(null)

  // Note: the panel is keyed by its working directory in App.tsx, so switching
  // folders remounts it and all result state resets naturally.

  const refreshVersions = useCallback(() => {
    let cancelled = false
    getTfVersions(dirPath ?? '')
      .then(versions => {
        if (!cancelled) setTfVersions(versions)
      })
      .catch(() => {
        // version info is optional; commands still work via PATH terraform
      })
    return () => {
      cancelled = true
    }
  }, [dirPath])

  useEffect(() => refreshVersions(), [refreshVersions])

  const handleVersionChange = async (version: string) => {
    if (!dirPath || !version || versionBusy) return
    setVersionBusy(true)
    setError('')
    // Picking a working version supersedes any earlier install failure.
    setInstallError('')
    try {
      await setTfVersion(dirPath, version)
      setTfVersions(prev => (prev ? { ...prev, active: version } : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set terraform version')
    } finally {
      setVersionBusy(false)
    }
  }

  const handleInstall = async () => {
    if (!dirPath || installing !== null || running !== null) return
    const raw = window.prompt('Terraform version to install (e.g. 1.9.8):')
    if (raw === null) return
    const version = raw.trim()
    if (!TF_VERSION_RE.test(version)) {
      setInstallError(`"${version}" is not a valid terraform version (expected e.g. 1.9.8).`)
      return
    }
    setInstalling(version)
    setInstallError('')
    try {
      const res = await installTfVersion(version)
      if (res.timedOut || (res.exitCode !== null && res.exitCode !== 0)) {
        setInstallError(
          `Install of ${version} failed${res.timedOut ? ' (timed out)' : ''}: ${res.output.slice(-300)}`,
        )
      } else {
        refreshVersions()
      }
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'Failed to install terraform version')
    } finally {
      setInstalling(null)
    }
  }

  // --- State bar data: backend info, workspaces, var files -------------------

  const refreshStateInfo = useCallback(() => {
    if (!dirPath) return
    getTfStateInfo(dirPath).then(setStateInfo).catch(() => setStateInfo(null))
  }, [dirPath])

  // workspace-list needs a running terraform + initialized backend; failures
  // just hide the workspace controls.
  const refreshWorkspaces = useCallback(() => {
    if (!dirPath) return
    runTerraform('workspace-list', dirPath)
      .then(res => {
        if (res.command === 'workspace-list') setWorkspaces(res.workspaces)
      })
      .catch(() => setWorkspaces(null))
  }, [dirPath])

  useEffect(() => {
    refreshStateInfo()
  }, [refreshStateInfo])

  useEffect(() => {
    if (!dirPath) return
    listTfVarFiles(dirPath).then(setVarFiles).catch(() => setVarFiles(null))
  }, [dirPath])

  // Fetch workspaces once the backend is known to be initialized.
  useEffect(() => {
    if (stateInfo?.initialized === true) refreshWorkspaces()
  }, [stateInfo, refreshWorkspaces])

  const handleWorkspaceSelect = async (name: string) => {
    if (!dirPath || wsBusy || running !== null || name === '') return
    if (workspaces?.find(w => w.current)?.name === name) return
    setWsBusy(true)
    setError('')
    try {
      await runTerraform('workspace-select', dirPath, { name })
      refreshStateInfo()
      refreshWorkspaces()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch workspace')
    } finally {
      setWsBusy(false)
    }
  }

  const handleNewWorkspace = async () => {
    if (!dirPath || wsBusy || running !== null) return
    const raw = window.prompt('Name for the new workspace (letters, digits, - and _):')
    if (raw === null) return
    const name = raw.trim()
    if (!TF_WORKSPACE_RE.test(name)) {
      setError(`"${name}" is not a valid workspace name.`)
      return
    }
    setWsBusy(true)
    setError('')
    try {
      await runTerraform('workspace-new', dirPath, { name })
      refreshStateInfo()
      refreshWorkspaces()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
    } finally {
      setWsBusy(false)
    }
  }

  const handleVarFileChange = (name: string) => {
    setSelectedVarFile(name)
    if (dirPath !== null) saveVarFileChoice(dirPath, name)
  }

  // --- Console expression evaluator ------------------------------------------

  const submitConsole = async () => {
    if (!dirPath || consoleBusy) return
    const expr = consoleExpr.trim()
    if (expr === '') return
    setConsoleBusy(true)
    try {
      const res = await runTerraform('console-eval', dirPath, { expression: expr })
      if (res.command === 'console-eval') {
        const ok = !res.timedOut && res.exitCode === 0
        const output = (ok ? res.output : `exit code ${res.exitCode}\n${res.output}`).trim()
        setConsoleHistory(h => [{ expr, output, ok }, ...h].slice(0, 10))
        if (ok) setConsoleExpr('')
      } else {
        setConsoleHistory(h => [{ expr, output: 'Unexpected response from server.', ok: false }, ...h].slice(0, 10))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Evaluation failed'
      setConsoleHistory(h => [{ expr, output: message, ok: false }, ...h].slice(0, 10))
    } finally {
      setConsoleBusy(false)
    }
  }

  // --- Drift detection --------------------------------------------------------
  // A drift check is a plain (non-streaming) plan with -detailed-exitcode so it
  // can run in the background without touching the Log view. Exit code 0 means
  // state matches reality, 2 means changes were detected.

  const clearDriftDismiss = useCallback(() => {
    if (driftDismissRef.current !== null) {
      window.clearTimeout(driftDismissRef.current)
      driftDismissRef.current = null
    }
  }, [])

  // A failed check reverts to idle after a while so the red badge does not
  // linger; the full output stays in the Log view.
  const scheduleDriftDismiss = useCallback(() => {
    clearDriftDismiss()
    driftDismissRef.current = window.setTimeout(() => {
      driftDismissRef.current = null
      setDrift(d => (d.status === 'error' ? { status: 'idle' } : d))
    }, DRIFT_ERROR_DISMISS_MS)
  }, [clearDriftDismiss])

  useEffect(() => clearDriftDismiss, [clearDriftDismiss])

  const checkDrift = useCallback(async () => {
    if (!dirPath || driftBusyRef.current) return
    driftBusyRef.current = true
    clearDriftDismiss()
    setDrift({ status: 'checking' })
    try {
      let opts: TfRunOptions | undefined
      if (selectedVarFile !== '' && varFiles?.files.some(f => f.name === selectedVarFile && !f.autoLoaded)) {
        opts = { varFile: selectedVarFile }
      }
      const res = await runTerraform('drift', dirPath, opts)
      if (res.command === 'drift') {
        const out = driftOutcome(res)
        setDrift({ status: out.status, checkedAt: Date.now(), summary: res.summary, message: out.message })
        if (out.status === 'error') scheduleDriftDismiss()
      }
    } catch (err) {
      setDrift({ status: 'error', checkedAt: Date.now(), message: err instanceof Error ? err.message : 'Drift check failed' })
      scheduleDriftDismiss()
    } finally {
      driftBusyRef.current = false
    }
  }, [dirPath, selectedVarFile, varFiles, clearDriftDismiss, scheduleDriftDismiss])

  // Periodic re-check while the panel is open (0 = off). The interval resets if
  // the remembered var file changes; checks never overlap.
  useEffect(() => {
    if (!dirPath || driftInterval === 0) return
    const id = window.setInterval(() => void checkDrift(), driftInterval * 60_000)
    return () => window.clearInterval(id)
  }, [dirPath, driftInterval, checkDrift])

  // --- Cost estimation (infracost) --------------------------------------------

  useEffect(() => {
    let cancelled = false
    getTfCostAvailability()
      .then(a => {
        if (!cancelled) setCostAvailable(a.available)
      })
      .catch(() => {
        if (!cancelled) setCostAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const clearCostDismiss = useCallback(() => {
    if (costDismissRef.current !== null) {
      window.clearTimeout(costDismissRef.current)
      costDismissRef.current = null
    }
  }, [])

  // A failed estimate closes the section after a while so it does not linger;
  // clicking Cost again re-runs it. Successful estimates stay open.
  const scheduleCostClose = useCallback(() => {
    clearCostDismiss()
    costDismissRef.current = window.setTimeout(() => {
      costDismissRef.current = null
      setCostOpen(false)
    }, COST_FAIL_DISMISS_MS)
  }, [clearCostDismiss])

  useEffect(() => clearCostDismiss, [clearCostDismiss])

  const runCost = async () => {
    if (!dirPath || costBusy) return
    clearCostDismiss()
    setCostOpen(true)
    setCostBusy(true)
    setCostError('')
    try {
      const res = await getTfCost(dirPath)
      setCostResult(res)
      if (res.totalMonthlyCost === null) scheduleCostClose()
    } catch (err) {
      let message = err instanceof Error ? err.message : 'Cost estimation failed'
      if (/infracost executable not found/i.test(message)) {
        message += ' — install it on the machine running this app, e.g. curl -sSfL https://raw.githubusercontent.com/infracost/infracost/main/install.sh | sh'
      }
      setCostError(message)
      scheduleCostClose()
    } finally {
      setCostBusy(false)
    }
  }

  const toggleCost = () => {
    if (costOpen && !costBusy) {
      clearCostDismiss()
      setCostOpen(false)
      return
    }
    void runCost()
  }

  // --- Dependency graph ---------------------------------------------------------

  const toggleGraph = () => {
    if (running !== null) return
    if (graphData === null) {
      void run('graph')
      return
    }
    setGraphOpen(o => !o)
  }

  // --- Command runner ---------------------------------------------------------

  const run = async (command: TfCommand, opts?: TfRunOptions) => {
    if (!dirPath || running !== null) return
    let effectiveOpts = opts
    // Attach the remembered var file to commands that accept one. Auto-loaded
    // files are already picked up by terraform, so skip them.
    if (selectedVarFile !== '' && VARFILE_COMMANDS.has(command)) {
      const vf = varFiles?.files.find(f => f.name === selectedVarFile)
      if (vf !== undefined && !vf.autoLoaded) effectiveOpts = { ...effectiveOpts, varFile: selectedVarFile }
    }
    setRunning(command)
    setError('')
    setResult(null)
    setApplyReady(false)
    setDestroyReady(false)
    // A new command supersedes a stale install error.
    setInstallError('')
    if (versionTimerRef.current !== null) {
      window.clearTimeout(versionTimerRef.current)
      versionTimerRef.current = null
    }
    setVersionDismissed(false)
    setLogText('')
    try {
      const res = await new Promise<TfRunResult>((resolve, reject) => {
        runTerraformStream(
          command,
          dirPath,
          {
            onChunk: text => setLogText(prev => prev + text),
            onDone: r => resolve(r),
            onError: msg => reject(new Error(msg))
          },
          effectiveOpts,
        )
      })
      setResult(res)
      if (res.command === 'version') {
        // Informational line — let it disappear on its own after a while.
        versionTimerRef.current = window.setTimeout(() => {
          versionTimerRef.current = null
          setVersionDismissed(true)
        }, 15000)
      }
      if (res.command === 'plan-file' && res.exitCode === 0) setApplyReady(true)
      if (res.command === 'plan-file-destroy' && res.exitCode === 0) setDestroyReady(true)
      if (res.command === 'graph' && !res.timedOut && res.exitCode === 0) {
        setGraphData({ nodes: res.nodes, edges: res.edges })
        setGraphOpen(true)
      }
      if (res.command === 'fmt' && res.changedFiles.length > 0) {
        onFmtApplied?.(res.changedFiles.map(f => f.path))
      }
      // Commands that change state or the backend: refresh the state bar.
      const mutatesState =
        res.command === 'init' ||
        res.command === 'init-upgrade' ||
        res.command === 'apply' ||
        res.command === 'import' ||
        res.command === 'state-mv' ||
        res.command === 'state-rm'
      if (mutatesState) {
        const r = res as Extract<TfRunResult, { command: 'init' | 'init-upgrade' | 'apply' | 'import' | 'state-mv' | 'state-rm' }>
        if (!r.timedOut && r.exitCode === 0) {
          refreshStateInfo()
          refreshWorkspaces()
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Terraform command failed')
    } finally {
      setRunning(null)
    }
  }

  // Step 1 of the guarded apply flow: create a fresh execution plan file.
  const startApplyFlow = () => {
    if (running !== null) return
    const ok = window.confirm(
      'This creates a fresh execution plan (tf.plan) in this folder. Nothing is applied yet — review its output first.',
    )
    if (!ok) return
    void run('plan-file')
  }

  // Step 2: apply the saved plan file after an explicit confirmation.
  const applySavedPlan = () => {
    if (running !== null || !applyReady) return
    const ok = window.confirm(
      'terraform apply will now modify REAL INFRASTRUCTURE using the saved plan tf.plan. Continue?',
    )
    if (!ok) return
    void run('apply')
  }

  // Destroy flow: guarded like apply — plan -destroy first, explicit confirm after.
  const startDestroyFlow = () => {
    if (running !== null) return
    const ok = window.confirm(
      'This creates a DESTROY plan (tf.plan) that would delete ALL resources in state. Nothing is destroyed yet — review its output first.',
    )
    if (!ok) return
    void run('plan-file-destroy')
  }

  const applyDestroyPlan = () => {
    if (running !== null || !destroyReady) return
    const ok = window.confirm(
      'terraform apply will now DESTROY ALL resources in state using the saved plan tf.plan. This cannot be undone. Continue?',
    )
    if (!ok) return
    void run('apply')
  }

  // --- State surgery: import / mv / rm ----------------------------------------

  const importResource = async () => {
    if (running !== null) return
    const rawAddress = window.prompt(
      'Address of the resource to import, e.g. aws_instance.web or module.vpc.aws_vpc.main:',
    )
    if (rawAddress === null) return
    const address = rawAddress.trim()
    if (!TF_ADDRESS_RE.test(address)) {
      setError(`"${address}" is not a valid resource address.`)
      return
    }
    const rawId = window.prompt('Existing resource ID to import (from the cloud provider console):')
    if (rawId === null) return
    const importId = rawId.trim()
    if (importId === '' || importId.startsWith('-')) {
      setError('The existing resource ID must not be empty.')
      return
    }
    void run('import', { address, importId })
  }

  const mvResource = async (srcAddress: string) => {
    if (running !== null) return
    const rawDest = window.prompt(`Move ${srcAddress} to a new address:`)
    if (rawDest === null) return
    const destAddress = rawDest.trim()
    if (!TF_ADDRESS_RE.test(destAddress)) {
      setError(`"${destAddress}" is not a valid resource address.`)
      return
    }
    void run('state-mv', { srcAddress, destAddress })
  }

  const rmResource = (address: string) => {
    if (running !== null) return
    const ok = window.confirm(
      `Remove ${address} from state?\n\nThe resource is NOT deleted in the cloud — it just stops being tracked by Terraform.`,
    )
    if (!ok) return
    void run('state-rm', { address })
  }

  // --- Init options helpers ----------------------------------------------------

  const updatePair = (i: number, field: 'key' | 'value', value: string) => {
    setBackendPairs(pairs => pairs.map((p, j) => (j === i ? { ...p, [field]: value } : p)))
  }

  const hasInitOptions = upgradeDeps || backendPairs.some(p => p.key.trim() !== '')

  const startInit = () => {
    if (running !== null) return
    const pairs = backendPairs.map(p => ({ key: p.key.trim(), value: p.value })).filter(p => p.key !== '')
    void run(upgradeDeps ? 'init-upgrade' : 'init', pairs.length > 0 ? { backendConfig: pairs } : undefined)
  }

  // --- Derived display values ---------------------------------------------------

  const tfenvOn = tfVersions?.tfenvAvailable === true
  const selectValue =
    tfenvOn && tfVersions !== null && tfVersions.active !== null && tfVersions.installed.includes(tfVersions.active)
      ? tfVersions.active
      : ''

  const logStatus = !running && result !== null ? logStatusText(result) : null

  const currentWorkspace = workspaces?.find(w => w.current)?.name ?? ''

  // Backend badge text for the state bar.
  let backendBadge: { className: string; text: string; title: string } | null = null
  if (stateInfo !== null && dirPath !== null) {
    const type = stateInfo.backend?.type ?? 'local'
    if (!stateInfo.initialized) {
      backendBadge = { className: 'none', text: 'Not initialized — run Init first', title: 'terraform init has not been run in this folder yet.' }
    } else if (type === 'local') {
      const n = stateInfo.localState?.resources
      backendBadge = {
        className: 'local',
        text: `Local state${n !== null && n !== undefined ? ` · ${n} resource${n === 1 ? '' : 's'}` : ''}`,
        title: 'State is stored in the local terraform.tfstate file.'
      }
    } else {
      const cfg = stateInfo.backend?.config ?? {}
      backendBadge = {
        className: 'remote',
        text: `${type} backend`,
        title: `Remote state backend "${type}" (credential values redacted): ${JSON.stringify(cfg)}`
      }
    }
  }

  // Drift badge text for the status row.
  const driftTime =
    drift.checkedAt !== undefined ? new Date(drift.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

  // Raw reason for a failed cost estimate (notes + output), shown in the section.
  const costDetail = costResult !== null ? costFailureDetail(costResult) : ''
  let driftBadgeText: string
  switch (drift.status) {
    case 'checking':
      driftBadgeText = 'Checking for drift…'
      break
    case 'ok':
      driftBadgeText = `No drift${driftTime ? ` · ${driftTime}` : ''}`
      break
    case 'drifted': {
      const s = drift.summary
      driftBadgeText = s
        ? `Drift: +${s.add} ~${s.update} ↻${s.replace} −${s.destroy}${driftTime ? ` · ${driftTime}` : ''}`
        : `Drift detected${driftTime ? ` · ${driftTime}` : ''}`
      break
    }
    case 'error':
      driftBadgeText = `Drift check failed${drift.message ? `: ${drift.message}` : ''}${driftTime ? ` · ${driftTime}` : ''}`
      break
    default:
      driftBadgeText = 'Drift: not checked yet'
  }

  // --- No working directory mode -------------------------------------------------

  if (dirPath === null) {
    return (
      <div className="tf-panel">
        <div className="tf-toolbar">
          <span className="tf-label">Terraform</span>
          <button onClick={() => setPickerOpen(true)}>Load Terraform project…</button>
        </div>
        <p className="tf-status">No Terraform project loaded. Load a folder to run commands here, or pick a file in the working tree.</p>
        {pickerOpen && (
          <TfProjectPicker onSelect={d => onLoadProject?.(d)} onClose={() => setPickerOpen(false)} />
        )}
      </div>
    )
  }

  return (
    <div className={`tf-panel${logOpen ? ' log-only' : ''}`}>
      {/* Row 1: project folder + log toggle */}
      <div className="tf-toolbar">
        <span className="tf-label">Terraform</span>
        <button
          className={`tf-project-chip${projectDir === null ? ' follows' : ''}`}
          onClick={() => setPickerOpen(true)}
          title={
            projectDir !== null
              ? `Loaded project: ${dirPath} — click to change`
              : `Following the open file's folder: ${dirPath} — click to load a specific project`
          }
        >
          📁 {basename(dirPath)}
        </button>
        {projectDir !== null && onLoadProject !== undefined && (
          <button
            className="tf-chip-clear"
            onClick={() => onLoadProject(null)}
            title="Clear the loaded project — follow the open file's folder again"
          >
            ×
          </button>
        )}
        <span className="tf-toolbar-spacer" />
        <button
          onClick={onToggleLog}
          className={`tf-log-toggle${logOpen ? ' active' : ''}`}
          title="Show/hide the command execution log (hides code while open)"
        >
          Log
        </button>
      </div>

      {/* Row 2: version + commands */}
      <div className="tf-toolbar">
        {tfenvOn && tfVersions !== null ? (
          <>
            <select
              className="tf-version-select"
              value={selectValue}
              onChange={e => void handleVersionChange(e.target.value)}
              disabled={versionBusy || running !== null || installing !== null}
              title={`Terraform version for ${dirPath} (.terraform-version)`}
            >
              {tfVersions.installed.length === 0 && <option value="">No versions installed</option>}
              {selectValue === '' && tfVersions.installed.length > 0 && (
                <option value="" disabled>
                  Select version…
                </option>
              )}
              {tfVersions.installed.map(v => (
                <option key={v} value={v}>
                  {v}
                  {tfVersions.active === v ? ' (active)' : ''}
                </option>
              ))}
            </select>
            <button onClick={() => void handleInstall()} disabled={installing !== null || running !== null}>
              Install…
            </button>
          </>
        ) : (
          <span className="tf-version-note">no tfenv — using terraform from PATH</span>
        )}
        <button onClick={startInit} disabled={running !== null} title="Initialize the backend and install providers">
          Init
        </button>
        <button
          onClick={() => setInitOptionsOpen(o => !o)}
          className={`tf-log-toggle${initOptionsOpen ? ' active' : ''}`}
          disabled={running !== null}
          title="Init options: upgrade dependencies, remote backend config"
        >
          Init ⚙{hasInitOptions ? ' •' : ''}
        </button>
        <button onClick={() => void run('fmt')} disabled={running !== null}>
          Format
        </button>
        <button onClick={() => void run('validate')} disabled={running !== null}>
          Validate
        </button>
        <button onClick={() => void run('plan-json')} disabled={running !== null}>
          Plan
        </button>
        <button
          onClick={toggleGraph}
          className={`tf-log-toggle${graphOpen ? ' active' : ''}`}
          disabled={running !== null}
          title="Build and show the resource dependency graph (terraform graph)"
        >
          Graph
        </button>
        <button
          onClick={() => void checkDrift()}
          disabled={running !== null || drift.status === 'checking'}
          title="Compare state against the actual cloud resources (plan -detailed-exitcode, read-only)"
        >
          {drift.status === 'checking' ? 'Checking…' : 'Drift'}
        </button>
        <button
          onClick={toggleCost}
          className={`tf-log-toggle${costOpen ? ' active' : ''}`}
          disabled={costBusy || costAvailable === false}
          title={
            costAvailable === false
              ? 'infracost is not installed on the server — install it to enable cost estimates'
              : 'Estimate monthly costs of the configuration with Infracost (read-only)'
          }
        >
          {costBusy ? 'Estimating…' : 'Cost'}
        </button>
        <span className="tf-toolbar-sep" />
        <button onClick={() => void run('output')} disabled={running !== null} title="Show output values from state">
          Outputs
        </button>
        <button onClick={() => void run('state-list')} disabled={running !== null} title="List resources in state">
          State
        </button>
        <button
          onClick={() => setConsoleOpen(o => !o)}
          className={`tf-log-toggle${consoleOpen ? ' active' : ''}`}
          disabled={running !== null || wsBusy}
          title="Evaluate Terraform expressions against the current configuration"
        >
          Console
        </button>
        <button
          onClick={() => setRegistryOpen(o => !o)}
          className={`tf-log-toggle${registryOpen ? ' active' : ''}`}
          disabled={running !== null}
          title="Browse public modules in the Terraform registry and add them to this project"
        >
          Registry
        </button>
        <button onClick={() => void run('version')} disabled={running !== null} title="Show the terraform version in use">
          Version
        </button>
        <span className="tf-toolbar-sep" />
        <button
          className="danger"
          onClick={startDestroyFlow}
          disabled={running !== null || !stateInfo?.initialized}
          title="Plan to destroy all resources (guarded: review before applying)"
        >
          Destroy…
        </button>
        <span className="tf-toolbar-sep" />
        <button
          onClick={() => setCredsOpen(o => !o)}
          className={`tf-log-toggle${credsOpen ? ' active' : ''}`}
          title="Cloud login: pick a registered provider and authenticate against it (register credentials in Settings)"
        >
          Login
        </button>
      </div>

      {initOptionsOpen && (
        <div className="tf-init-options">
          <label className="tf-opt-row">
            <input type="checkbox" checked={upgradeDeps} onChange={e => setUpgradeDeps(e.target.checked)} />
            Upgrade dependencies (<code>-upgrade</code>) — refresh provider/plugin versions to the latest allowed
          </label>
          <div className="tf-bc-block">
            <span className="tf-opt-label">Backend config (remote state, e.g. S3 bucket/region):</span>
            {backendPairs.map((p, i) => (
              <div key={i} className="tf-bc-row">
                <input value={p.key} placeholder="key" onChange={e => updatePair(i, 'key', e.target.value)} aria-label={`Backend config key ${i + 1}`} />
                <input value={p.value} placeholder="value" onChange={e => updatePair(i, 'value', e.target.value)} aria-label={`Backend config value ${i + 1}`} />
                <button onClick={() => setBackendPairs(pairs => pairs.filter((_, j) => j !== i))} title="Remove" aria-label={`Remove backend option ${i + 1}`}>
                  ×
                </button>
              </div>
            ))}
            <button className="tf-bc-add" onClick={() => setBackendPairs(pairs => [...pairs, { key: '', value: '' }])}>
              + Add backend option
            </button>
          </div>
        </div>
      )}

      {/* Cloud login: pick a registered provider and authenticate against it */}
      {credsOpen && <CloudLogin onClose={() => setCredsOpen(false)} />}

      {/* State bar: backend badge, workspaces, var file choice */}
      {backendBadge !== null && (
        <div className="tf-state-bar">
          <span className={`tf-backend-badge ${backendBadge.className}`} title={backendBadge.title}>
            {backendBadge.text}
          </span>
          {stateInfo?.initialized === true && workspaces !== null && workspaces.length > 0 && (
            <>
              <label className="tf-ws-label" title="Active workspace — switching changes which state file is used">
                workspace
                <select value={currentWorkspace} onChange={e => void handleWorkspaceSelect(e.target.value)} disabled={wsBusy || running !== null}>
                  {currentWorkspace === '' && (
                    <option value="" disabled>
                      …
                    </option>
                  )}
                  {workspaces.map(w => (
                    <option key={w.name} value={w.name}>
                      {w.name}
                      {w.current ? ' ✓' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => void handleNewWorkspace()} disabled={wsBusy || running !== null} title="Create a new workspace">
                + ws
              </button>
            </>
          )}
          {varFiles !== null && varFiles.files.length > 0 && (
            <label className="tf-vf-label" title="Extra variable values for Init/Plan commands. Files marked auto are loaded by terraform automatically.">
              vars
              <select value={selectedVarFile} onChange={e => handleVarFileChange(e.target.value)}>
                <option value="">(none)</option>
                {varFiles.files.map(f => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                    {f.autoLoaded ? ' · auto' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {/* Drift status + auto-check interval (status feedback, always visible) */}
      <div className="tf-drift-row">
        <button
          className={`tf-drift-badge ${drift.status}`}
          onClick={() => void checkDrift()}
          disabled={running !== null || drift.status === 'checking'}
          title="Compare state against the actual cloud resources — click to re-check"
        >
          {driftBadgeText}
        </button>
        <label className="tf-ws-label" title="Re-check for drift automatically while this panel is open">
          auto
          <select
            value={String(driftInterval)}
            onChange={e => {
              const m = Number(e.target.value)
              setDriftInterval(m)
              saveDriftInterval(m)
            }}
          >
            <option value="0">off</option>
            <option value="5">every 5 min</option>
            <option value="10">every 10 min</option>
            <option value="30">every 30 min</option>
          </select>
        </label>
      </div>

      {/* Console expression evaluator */}
      {consoleOpen && (
        <div className="tf-console">
          <form
            className="tf-console-form"
            onSubmit={e => {
              e.preventDefault()
              void submitConsole()
            }}
          >
            <input
              value={consoleExpr}
              onChange={e => setConsoleExpr(e.target.value)}
              placeholder='Terraform expression, e.g. length(var.instances) or "a" + "b"'
              aria-label="Terraform expression to evaluate"
              disabled={consoleBusy}
            />
            <button type="submit" disabled={consoleBusy || consoleExpr.trim() === ''}>
              {consoleBusy ? 'Evaluating…' : 'Evaluate'}
            </button>
          </form>
          {consoleHistory.map((h, i) => (
            <div key={`${i}:${h.expr}`} className="tf-console-entry">
              <code>{h.expr}</code>
              <pre className={`tf-console-out${h.ok ? '' : ' error'}`}>{h.output || '(no output)'}</pre>
            </div>
          ))}
        </div>
      )}

      {/* Dependency graph view */}
      {graphOpen && graphData !== null && (
        <div className="tf-graph-section">
          <PlanGraph nodes={graphData.nodes} edges={graphData.edges} />
        </div>
      )}

      {/* Module registry browser */}
      {registryOpen && <RegistryPanel dirPath={dirPath} onFileWritten={p => onFmtApplied?.([p])} />}

      {/* Cost estimation (infracost) */}
      {costOpen && (
        <div className="tf-cost">
          {costBusy && (
            <p className="tf-running">Running infracost breakdown… the first run downloads price data and can take a while.</p>
          )}
          {!costBusy && costError !== '' && <p className="tf-status error">{costError}</p>}
          {!costBusy && costResult !== null && (
            <>
              {costResult.totalMonthlyCost !== null ? (
                <>
                  <p className="tf-cost-total">
                    Estimated total: <strong>{costResult.currencySymbol}{costResult.totalMonthlyCost.toFixed(2)}</strong> /month
                  </p>
                  {costResult.errors.length > 0 && (
                    <ul className="tf-cost-notes">
                      {costResult.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                  {costResult.warnings.length > 0 && (
                    <ul className="tf-cost-notes warn">
                      {costResult.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                  {costResult.resources.length > 0 ? (
                    <table className="tf-cost-table">
                      <thead>
                        <tr>
                          <th>Resource</th>
                          <th className="num">{costResult.currencySymbol}/month</th>
                        </tr>
                      </thead>
                      <tbody>
                        {costResult.resources.map(r => (
                          <tr key={r.address}>
                            <td>
                              <code>{r.address}</code>
                            </td>
                            <td className="num">{r.monthlyCost !== null ? r.monthlyCost.toFixed(2) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    costResult.totalMonthlyCost === 0 && <p className="tf-status ok">No billable resources found in the configuration.</p>
                  )}
                </>
              ) : (
                <>
                  <p className="tf-status error">
                    {costDetail !== '' ? 'Cost estimation failed — details below.' : 'Could not parse the cost estimate'}
                  </p>
                  {costDetail !== '' && <pre className="tf-cost-output">{costDetail}</pre>}
                  {costNeedsApiKey(costResult) && (
                    <p className="tf-status">
                      Infracost needs an API key: set INFRACOST_API_KEY in the environment of the app process (free at infracost.io), then restart it.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {installing !== null && (
        <p className="tf-running">Installing terraform {installing}… this downloads from releases.hashicorp.com.</p>
      )}
      {!installing && installError !== '' && <p className="tf-status error">{installError}</p>}

      {error && <p className="tf-status error">{error}</p>}
      {running && (
        <p className="tf-running">
          Running terraform {runningLabel(running)}…
          {(running === 'plan-json' || running === 'drift' || running === 'plan-file' || running === 'plan-file-destroy') &&
            ' this can take a while.'}
        </p>
      )}

      {/* Version info line — auto-hides after a short while; other results live in the Log view */}
      {!logOpen && !running && result?.command === 'version' && !versionDismissed && (
        <p className={`tf-status ${result.timedOut || result.exitCode !== 0 ? 'error' : 'ok'}`}>
          {result.version !== null
            ? `Terraform ${result.version}${result.platform ? ` on ${result.platform}` : ''}`
            : 'Could not parse the version output — see the full output in the Log view.'}
        </p>
      )}

      {/* Log view — live command output fills the pane, code is hidden by App */}
      {logOpen && (
        <div className="tf-log-view">
          {logStatus !== null && (
            <p className={`tf-status ${logStatus.ok ? 'ok' : 'error'}`}>{logStatus.text}</p>
          )}
          <pre ref={logRef} className="tf-output tf-live-log">
            {logText !== ''
              ? logText
              : running !== null
                ? 'Waiting for terraform output…'
                : result === null
                  ? '(no command run yet — press Init, Format, Validate or Plan above)'
                  : ''}
          </pre>
          {!running && result !== null && (
            <div className="tf-toolbar tf-actions">
              {result.command === 'plan-json' && result.exitCode === 0 && !result.timedOut && planHasChanges(result.summary) && (
                <button className="danger" onClick={startApplyFlow}>
                  Save plan &amp; prepare apply…
                </button>
              )}
              {result.command === 'plan-json' && result.exitCode === 0 && !result.timedOut && costAvailable === true && (
                <button onClick={toggleCost} title="Estimate the monthly cost of this configuration with Infracost">
                  Estimate costs
                </button>
              )}
              {result.command === 'plan-file' && applyReady && (
                <>
                  <button onClick={() => void run('show-plan')}>Review saved plan</button>{' '}
                  <button className="danger" onClick={applySavedPlan}>
                    Apply saved plan
                  </button>
                </>
              )}
              {result.command === 'plan-file-destroy' && destroyReady && (
                <>
                  <button onClick={() => void run('show-plan')}>Review destroy plan</button>{' '}
                  <button className="danger" onClick={applyDestroyPlan}>
                    Apply destroy plan — delete resources
                  </button>
                </>
              )}
              {result.command === 'apply' && result.exitCode === 0 && !result.timedOut && (
                <button onClick={() => void run('plan-json')}>Verify with a new plan</button>
              )}
              {(result.command === 'state-show' || result.command === 'import' || result.command === 'state-mv' || result.command === 'state-rm') && (
                <button onClick={() => void run('state-list')}>Refresh state list</button>
              )}
            </div>
          )}

          {/* State surgery controls — reachable from the Log view only */}
          {!running && result?.command === 'state-list' && !result.timedOut && result.exitCode === 0 && (
            <>
              {result.addresses.length > 0 ? (
                <div className="tf-state-list">
                  {result.addresses.map(a => (
                    <div key={a} className="tf-state-row">
                      <button onClick={() => void run('state-show', { address: a })} title={`Show state for ${a}`}>
                        {a}
                      </button>
                      <span className="tf-state-actions">
                        <button
                          onClick={() => void mvResource(a)}
                          disabled={running !== null}
                          title="Move to a new address (state only — nothing is recreated)"
                        >
                          mv
                        </button>
                        <button
                          className="danger"
                          onClick={() => rmResource(a)}
                          disabled={running !== null}
                          title="Remove from state — does NOT delete the cloud resource"
                        >
                          rm
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="tf-status ok">State is empty — no resources tracked.</p>
              )}
              <button onClick={() => void importResource()} disabled={running !== null}>
                Import existing resource…
              </button>
            </>
          )}
        </div>
      )}

      {pickerOpen && (
        <TfProjectPicker initialDir={dirPath} onSelect={d => onLoadProject?.(d)} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  )
}

export default TerraformPanel
