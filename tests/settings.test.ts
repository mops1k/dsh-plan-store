import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { SETTINGS_NAMESPACE, registerPlanSettings, type PlanStoreSettings } from '../src/dsh/settings'
import { makeHarness, type TestHarness } from './helpers'

interface SettingsHarness {
  ctx: Context
  namespaces: string[]
  options: Array<{ base: PlanStoreSettings; applies?: string }>
  watchers: Array<(next: PlanStoreSettings) => void>
  warnings: string[]
  fail: boolean
}

/** Build a host context that records the registered settings namespace. */
function makeSettingsHarness(fail = false): SettingsHarness {
  const namespaces: string[] = []
  const options: Array<{ base: PlanStoreSettings; applies?: string }> = []
  const watchers: Array<(next: PlanStoreSettings) => void> = []
  const warnings: string[] = []
  const state: SettingsHarness = {
    ctx: undefined as unknown as Context,
    namespaces,
    options,
    watchers,
    warnings,
    fail,
  }
  const ctx = {
    logger: { warn: (message: string) => warnings.push(message) },
    settings: {
      register(namespace: string, _schema: unknown, registerOptions: { base: PlanStoreSettings; applies?: string }) {
        if (fail) throw new Error('namespace already registered')
        namespaces.push(namespace)
        options.push(registerOptions)
        return {
          get: () => registerOptions.base,
          watch(callback: (next: PlanStoreSettings) => void): () => void {
            watchers.push(callback)
            return () => {}
          },
        }
      },
    },
  } as unknown as Context
  state.ctx = ctx
  return state
}

let harness: TestHarness

beforeEach(() => {
  harness = makeHarness()
})

afterEach(() => {
  harness.cleanup()
})

describe('settings namespace', () => {
  it('registers the namespace as live with the resolved base', () => {
    const settings = makeSettingsHarness()
    registerPlanSettings(settings.ctx, harness.engine, harness.config)

    expect(settings.namespaces).toEqual([SETTINGS_NAMESPACE])
    expect(settings.options[0]?.applies).toBe('live')
    expect(settings.options[0]?.base).toMatchObject({
      webPath: '/plan-store',
      exportDir: '.kilo/plans',
      autoExport: true,
      promptActivePlans: true,
      promptActiveLimit: 5,
      stalePlanDays: 14,
    })
    expect(settings.watchers).toHaveLength(1)
  })

  it('applies watched values to the live config without a restart', () => {
    const settings = makeSettingsHarness()
    registerPlanSettings(settings.ctx, harness.engine, harness.config)

    const base = settings.options[0]!.base
    settings.watchers[0]?.({ ...base, promptActiveLimit: 2, exportDir: 'plans', stalePlanDays: 30 })

    expect(harness.config.promptActiveLimit).toBe(2)
    expect(harness.config.exportDir).toBe('plans')
    expect(harness.config.stalePlanDays).toBe(30)
    expect(harness.engine.config.exportDir).toBe('plans')
    expect(settings.warnings).toHaveLength(0)
  })

  it('warns that a storage root change needs a restart', () => {
    const settings = makeSettingsHarness()
    registerPlanSettings(settings.ctx, harness.engine, harness.config)

    const base = settings.options[0]!.base
    settings.watchers[0]?.({ ...base, storageRoot: '/tmp/elsewhere' })

    expect(settings.warnings).toHaveLength(1)
    expect(settings.warnings[0]).toContain('storageRoot changed')
    expect(harness.engine.dbPath).toContain(harness.root)
  })

  it('warns instead of failing when the namespace is taken', () => {
    const settings = makeSettingsHarness(true)
    expect(() => registerPlanSettings(settings.ctx, harness.engine, harness.config)).not.toThrow()
    expect(settings.warnings[0]).toContain('was not registered')
  })
})
