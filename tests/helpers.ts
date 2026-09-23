import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mergeConfig, type PlanStoreConfig } from '../src/core/config'
import { PlanEngine } from '../src/core/engine'
import { PlanStore } from '../src/core/store'
import type { Phase, Plan, Task } from '../src/core/types'

/** Create an isolated temporary directory for a test. */
export function makeTempRoot(prefix = 'dsh-plan-store-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Remove a temporary directory, ignoring failures. */
export function cleanupRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

/** A store, an engine and a workspace directory bound to temporary paths. */
export interface TestHarness {
  root: string
  workspace: string
  config: PlanStoreConfig
  store: PlanStore
  engine: PlanEngine
  cleanup(): void
}

/** Build a harness with temporary storage, an optional clock and config overrides. */
export function makeHarness(overrides: Partial<PlanStoreConfig> = {}, now?: () => Date): TestHarness {
  const root = makeTempRoot()
  const workspace = makeTempRoot('dsh-plan-store-ws-')
  const config = mergeConfig(overrides)
  const store = new PlanStore({ root })
  const engine = new PlanEngine({ store, config, ...(now === undefined ? {} : { now }) })
  return {
    root,
    workspace,
    config,
    store,
    engine,
    cleanup(): void {
      engine.close()
      cleanupRoot(root)
      cleanupRoot(workspace)
    },
  }
}

/** Fixed timestamp used by row factories. */
export const FIXED_TIME = '2026-09-23T10:00:00.000Z'

/** Build a plan row with sane defaults. */
export function planRow(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'p_test0001',
    title: 'Alpha plan',
    description: 'First plan',
    status: 'backlog',
    priority: 'normal',
    workspace: 'demo',
    workspaceRoot: '',
    tags: [],
    exportPath: null,
    sessionId: null,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    archivedAt: null,
    ...overrides,
  }
}

/** Build a phase row with sane defaults. */
export function phaseRow(planId: string, overrides: Partial<Phase> = {}): Phase {
  return {
    id: 'ph_test0001',
    planId,
    title: 'Phase one',
    status: 'todo',
    notes: '',
    position: 0,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    ...overrides,
  }
}

/** Build a task row with sane defaults. */
export function taskRow(planId: string, phaseId: string, overrides: Partial<Task> = {}): Task {
  return {
    id: 't_test0001',
    planId,
    phaseId,
    title: 'Task one',
    status: 'todo',
    notes: '',
    links: [],
    position: 0,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    completedAt: null,
    ...overrides,
  }
}
