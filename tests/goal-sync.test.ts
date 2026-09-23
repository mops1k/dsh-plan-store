import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'

import { mergeConfig, type PlanStoreConfig } from '../src/core/config'
import type { PlanTree } from '../src/core/types'
import {
  GOAL_PREFIX,
  goalObjective,
  isOwnGoal,
  syncPlanGoal,
  type GoalRefLike,
  type GoalViewLike,
} from '../src/dsh/goal-sync'
import { makeHarness, type TestHarness } from './helpers'

let harness: TestHarness

beforeEach(() => {
  harness = makeHarness()
})

afterEach(() => {
  harness.cleanup()
})

/** Config with the goal sync toggle under test. */
function config(overrides: Partial<PlanStoreConfig> = {}): PlanStoreConfig {
  return mergeConfig(overrides)
}

/** Create a plan and return its tree. */
function seedPlan(): PlanTree {
  return harness.engine.createPlan({
    title: 'Goal plan',
    workspace: 'demo',
    workspaceRoot: harness.workspace,
    status: 'active',
    phases: [{ title: 'Core', tasks: [{ title: 'first' }] }],
  })
}

/** Recording double of `ctx.goals`. */
function fakeGoals(current: GoalViewLike | null) {
  const calls: string[] = []
  let goal = current
  return {
    calls,
    get(): GoalViewLike | null {
      return goal
    },
    create(_agent: unknown, request: { objective: string }): GoalViewLike {
      calls.push(`create:${request.objective}`)
      goal = { id: 'goal-1', revision: 1, objective: request.objective, phase: 'active' }
      return goal
    },
    edit(_agent: unknown, ref: GoalRefLike, request: { objective?: string }): GoalViewLike {
      calls.push(`edit:${ref.id}:${request.objective}`)
      goal = { id: ref.id, revision: ref.revision + 1, objective: request.objective ?? '', phase: 'active' }
      return goal
    },
    clear(_agent: unknown, ref: GoalRefLike): unknown {
      calls.push(`clear:${ref.id}`)
      goal = null
      return undefined
    },
    disarm(): unknown {
      calls.push('disarm')
      return undefined
    },
  }
}

/** Context double carrying the agents and goals services. */
function fakeContext(goals: unknown): Context {
  return {
    agents: { get: (id: string) => ({ id }) },
    goals,
    logger: { warn: () => {} },
  } as unknown as Context
}

const exec = { agent: { id: 'session-1' } }

describe('goal objective', () => {
  it('renders the plan title behind the plugin prefix', () => {
    const tree = seedPlan()
    expect(goalObjective(tree)).toBe(`${GOAL_PREFIX}Goal plan`)
  })

  it('recognizes only its own goals', () => {
    expect(isOwnGoal({ id: 'g', revision: 1, objective: `${GOAL_PREFIX}x`, phase: 'active' })).toBe(true)
    expect(isOwnGoal({ id: 'g', revision: 1, objective: 'Do something else', phase: 'active' })).toBe(false)
    expect(isOwnGoal(null)).toBe(false)
  })
})

describe('syncPlanGoal', () => {
  it('creates the goal and disarms it when the session has none', () => {
    const goals = fakeGoals(null)
    const tree = seedPlan()
    expect(syncPlanGoal(fakeContext(goals), exec, tree, config())).toBe(true)
    expect(goals.calls).toEqual([`create:${GOAL_PREFIX}Goal plan`, 'disarm'])
  })

  it('leaves a foreign goal untouched', () => {
    const goals = fakeGoals({ id: 'goal-x', revision: 3, objective: 'User objective', phase: 'active' })
    const tree = seedPlan()
    expect(syncPlanGoal(fakeContext(goals), exec, tree, config())).toBe(false)
    expect(goals.calls).toEqual([])
  })

  it('edits its own goal when the plan title changed and keeps it otherwise', () => {
    const goals = fakeGoals({ id: 'goal-1', revision: 2, objective: `${GOAL_PREFIX}Old title`, phase: 'active' })
    const tree = seedPlan()
    expect(syncPlanGoal(fakeContext(goals), exec, tree, config())).toBe(true)
    expect(goals.calls).toEqual([`edit:goal-1:${GOAL_PREFIX}Goal plan`])

    goals.calls.length = 0
    const again = { ...tree, title: 'Goal plan' }
    expect(syncPlanGoal(fakeContext(goals), exec, again, config())).toBe(true)
    expect(goals.calls).toEqual([])
  })

  it('replaces a completed goal of its own with a fresh one', () => {
    const goals = fakeGoals({ id: 'goal-1', revision: 4, objective: `${GOAL_PREFIX}Goal plan`, phase: 'complete' })
    const tree = seedPlan()
    expect(syncPlanGoal(fakeContext(goals), exec, tree, config())).toBe(true)
    expect(goals.calls).toEqual([`create:${GOAL_PREFIX}Goal plan`, 'disarm'])
  })

  it('clears its own goal when the plan is finished or gone', () => {
    const finished = seedPlan()
    harness.engine.updateTask(finished.phases[0]!.tasks[0]!.id, { status: 'done' })
    const tree = harness.engine.requireTree(finished.id, 0)
    expect(tree.status).toBe('done')
    const goals = fakeGoals({ id: 'goal-1', revision: 5, objective: `${GOAL_PREFIX}Goal plan`, phase: 'active' })
    expect(syncPlanGoal(fakeContext(goals), exec, tree, config())).toBe(true)
    expect(goals.calls).toEqual(['clear:goal-1'])

    goals.calls.length = 0
    expect(syncPlanGoal(fakeContext(goals), exec, null, config())).toBe(true)
    expect(goals.calls).toEqual([])
  })

  it('does nothing when the sync is disabled or the host has no goal service', () => {
    const goals = fakeGoals(null)
    const tree = seedPlan()
    expect(syncPlanGoal(fakeContext(goals), exec, tree, config({ syncGoal: false }))).toBe(false)
    expect(goals.calls).toEqual([])
    expect(syncPlanGoal({ logger: { warn: () => {} } } as unknown as Context, exec, tree, config())).toBe(false)
  })
})
