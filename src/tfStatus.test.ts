import { describe, expect, it } from 'vitest'
import type { TfCostResult } from './api'
import { costFailureDetail, costNeedsApiKey, driftOutcome } from './tfStatus'

function cost(partial: Partial<TfCostResult>): TfCostResult {
  return {
    exitCode: 1,
    timedOut: false,
    currencySymbol: '$',
    totalMonthlyCost: null,
    resources: [],
    errors: [],
    warnings: [],
    ...partial
  }
}

describe('driftOutcome', () => {
  it('maps a clean plan to ok without a message', () => {
    expect(driftOutcome({ drifted: false, timedOut: false, exitCode: 0, output: '' })).toEqual({ status: 'ok' })
  })

  it('maps changes to drifted', () => {
    expect(driftOutcome({ drifted: true, timedOut: false, exitCode: 2, output: '' }).status).toBe('drifted')
  })

  it('reports a timeout as an error', () => {
    expect(driftOutcome({ drifted: null, timedOut: true, exitCode: null, output: '' })).toEqual({
      status: 'error',
      message: 'timed out'
    })
  })

  it('explains the missing-configuration case instead of a bare exit code', () => {
    const out = driftOutcome({
      drifted: null,
      timedOut: false,
      exitCode: 1,
      output: 'Error: No configuration files\nPlan requires configuration to be present.'
    })
    expect(out).toEqual({ status: 'error', message: 'no Terraform configuration in this folder yet' })
  })

  it('falls back to the exit code for other failures', () => {
    const out = driftOutcome({ drifted: null, timedOut: false, exitCode: 1, output: 'Error: something else' })
    expect(out).toEqual({ status: 'error', message: 'plan exited with code 1' })
  })

  it('uses ? when the exit code is unknown', () => {
    const out = driftOutcome({ drifted: null, timedOut: false, exitCode: null, output: '' })
    expect(out.message).toBe('plan exited with code ?')
  })
})

describe('costFailureDetail', () => {
  it('is empty when the estimate parsed fine', () => {
    expect(costFailureDetail(cost({ totalMonthlyCost: 12.5 }))).toBe('')
  })

  it('folds JSON error notes into the detail', () => {
    const d = costFailureDetail(cost({ errors: ['Could not price aws_instance.x'] }))
    expect(d).toContain('Could not price aws_instance.x')
  })

  it('falls back to the raw output when there are no notes', () => {
    const d = costFailureDetail(cost({ output: 'Error: INFRACOST_API_KEY is not set' }))
    expect(d).toBe('Error: INFRACOST_API_KEY is not set')
  })

  it('strips ANSI color codes from the raw output', () => {
    const d = costFailureDetail(cost({ output: '\u001b[91mError:\u001b[0m bad thing' }))
    expect(d).toBe('Error: bad thing')
  })

  it('caps very long details', () => {
    const d = costFailureDetail(cost({ output: 'x'.repeat(5000) }))
    expect(d.length).toBeLessThanOrEqual(1201)
    expect(d.endsWith('…')).toBe(true)
  })

  it('is empty when there is nothing to show', () => {
    expect(costFailureDetail(cost({}))).toBe('')
  })
})

describe('costNeedsApiKey', () => {
  it('detects the missing API key in raw output', () => {
    expect(costNeedsApiKey(cost({ output: 'Error: INFRACOST_API_KEY is not set but is required' }))).toBe(true)
  })

  it('detects the missing API key in JSON notes', () => {
    expect(costNeedsApiKey(cost({ errors: ['INFRACOST_API_KEY must be configured'] }))).toBe(true)
  })

  it('is false for other failures and successful estimates', () => {
    expect(costNeedsApiKey(cost({ output: 'Error: something else' }))).toBe(false)
    expect(costNeedsApiKey(cost({ totalMonthlyCost: 0, output: 'INFRACOST_API_KEY whatever' }))).toBe(false)
  })
})
