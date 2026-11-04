// Pure helpers that turn raw terraform/infracost results into short UI status
// text (drift badge + cost section). Kept out of the component so they can be
// unit-tested without rendering.

import type { TfCostResult } from './api'

const NO_CONFIG_RE = /no configuration files/i
export const INFRACOST_KEY_RE = /INFRACOST_API_KEY/i
// Built from the escape code point so no control character appears in source.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const MAX_DETAIL_CHARS = 1200

export type DriftOutcome = {
  status: 'ok' | 'drifted' | 'error'
  message?: string
}

// Map a drift check result to the badge state. drifted===null means the check
// itself failed; when terraform says there is no configuration at all we say so
// instead of showing a bare exit code (empty project folders are common).
export function driftOutcome(res: {
  drifted: boolean | null
  timedOut: boolean
  exitCode: number | null
  output: string
}): DriftOutcome {
  if (res.drifted === false) return { status: 'ok' }
  if (res.drifted === true) return { status: 'drifted' }
  if (res.timedOut) return { status: 'error', message: 'timed out' }
  const code = res.exitCode ?? '?'
  if (NO_CONFIG_RE.test(res.output)) {
    return { status: 'error', message: 'no Terraform configuration in this folder yet' }
  }
  return { status: 'error', message: `plan exited with code ${code}` }
}

// Human-readable reason for a failed cost estimate ('' when there is nothing
// extra to show). Folds the JSON error/warning notes and the raw output
// (ANSI-stripped, capped) into one block.
export function costFailureDetail(result: TfCostResult): string {
  if (result.totalMonthlyCost !== null) return ''
  const notes = [...result.errors, ...result.warnings].join('\n')
  const raw = (result.output ?? '').replace(ANSI_RE, '').trim()
  const text = [notes, raw].filter(Boolean).join('\n\n')
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text
}

// True when the failure is specifically a missing Infracost API key.
export function costNeedsApiKey(result: TfCostResult): boolean {
  if (result.totalMonthlyCost !== null) return false
  const all = [...result.errors, ...result.warnings].join('\n') + '\n' + (result.output ?? '')
  return INFRACOST_KEY_RE.test(all)
}
