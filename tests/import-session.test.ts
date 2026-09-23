import { describe, expect, it } from 'vitest'

import {
  IMPORT_PHASE_TITLE,
  IMPORT_TAG,
  importedPhase,
  mapSessionToPlan,
  planSyncActions,
  sessionDescription,
  sessionPlanTitle,
  todoStatusToTask,
  type SessionSnapshot,
} from '../src/core/import-session'
import type { PlanTree } from '../src/core/types'
import { makeHarness } from './helpers'

/** Snapshot with a goal and three todo items. */
const SNAPSHOT: SessionSnapshot = {
  sessionId: 's-1',
  goal: {
    id: 'g_1',
    revision: 4,
    objective: 'Ship the plan store',
    phase: 'active',
    maxGoalRounds: 8,
    roundsStarted: 2,
    activation: 'armed',
  },
  todos: [
    { content: 'write the mapping', status: 'completed' },
    { content: 'wire the board tab', status: 'in_progress' },
    { content: 'run the checks', status: 'pending' },
  ],
}

describe('mapping', () => {
  it('maps todo statuses onto task statuses', () => {
    expect(todoStatusToTask('completed')).toBe('done')
    expect(todoStatusToTask('in_progress')).toBe('doing')
    expect(todoStatusToTask('pending')).toBe('todo')
  })

  it('builds a plan input from the goal and the todo list', () => {
    const input = mapSessionToPlan(SNAPSHOT, { key: 'demo', root: '/tmp/demo' })
    expect(input.title).toBe('Ship the plan store')
    expect(input.workspace).toBe('demo')
    expect(input.workspaceRoot).toBe('/tmp/demo')
    expect(input.tags).toEqual([IMPORT_TAG])
    expect(input.sessionId).toBe('s-1')
    expect(input.phases).toHaveLength(1)
    expect(input.phases?.[0]?.title).toBe(IMPORT_PHASE_TITLE)
    expect(input.phases?.[0]?.tasks).toEqual([
      { title: 'write the mapping', status: 'done' },
      { title: 'wire the board tab', status: 'doing' },
      { title: 'run the checks', status: 'todo' },
    ])
  })

  it('falls back to a todo-based title without a goal', () => {
    const snapshot: SessionSnapshot = { sessionId: 's-2', goal: null, todos: [{ content: 'a', status: 'pending' }] }
    expect(sessionPlanTitle(snapshot)).toBe('Session todos (1)')
    expect(sessionPlanTitle({ sessionId: 's-3', goal: null, todos: [] })).toBe('Session s-3')
    expect(sessionDescription(snapshot)).toContain('no goal')
  })

  it('describes the goal, its rounds and a block reason', () => {
    const description = sessionDescription({
      ...SNAPSHOT,
      goal: {
        ...SNAPSHOT.goal!,
        phase: 'blocked',
        blockedReason: { code: 'needs-input', message: 'Waiting for the API key' },
      },
    })
    expect(description).toContain('Ship the plan store')
    expect(description).toContain('- rounds: 2/8')
    expect(description).toContain('needs-input — Waiting for the API key')
    expect(description).toContain('Todo items: 3')
  })
})

describe('planSyncActions', () => {
  let tree: PlanTree

  it('imports through the engine and reports a fresh plan', () => {
    const harness = makeHarness()
    try {
      const result = harness.engine.importSession(SNAPSHOT, { key: 'demo', root: '/tmp/demo' })
      expect(result.created).toBe(true)
      expect(result.actions).toBeNull()
      expect(result.tree.title).toBe('Ship the plan store')
      expect(result.tree.sessionId).toBe('s-1')
      expect(result.tree.tags).toEqual([IMPORT_TAG])
      expect(result.tree.progress).toMatchObject({ total: 3, done: 1, doing: 1, todo: 1 })
      tree = result.tree
    } finally {
      harness.cleanup()
    }
  })

  it('computes additions, status changes and removals', () => {
    const harness = makeHarness()
    try {
      tree = harness.engine.importSession(SNAPSHOT, { key: 'demo', root: '/tmp/demo' }).tree
      const phase = importedPhase(tree)
      expect(phase?.title).toBe(IMPORT_PHASE_TITLE)

      const actions = planSyncActions(tree, [
        { content: 'wire the board tab', status: 'completed' },
        { content: 'run the checks', status: 'pending' },
        { content: 'document the tab', status: 'pending' },
      ])
      expect(actions.add.map((todo) => todo.content)).toEqual(['document the tab'])
      expect(actions.update).toEqual([
        { taskId: phase!.tasks[1]!.id, title: 'wire the board tab', status: 'done' },
      ])
      expect(actions.remove).toEqual([phase!.tasks[0]!.id])
    } finally {
      harness.cleanup()
    }
  })

  it('refreshes the imported plan instead of duplicating it', () => {
    const harness = makeHarness()
    try {
      const first = harness.engine.importSession(SNAPSHOT, { key: 'demo', root: '/tmp/demo' })
      const refreshed = harness.engine.importSession(
        {
          ...SNAPSHOT,
          goal: { ...SNAPSHOT.goal!, objective: 'Ship the plan store v2', phase: 'complete' },
          todos: [{ content: 'run the checks', status: 'completed' }],
        },
        { key: 'demo', root: '/tmp/demo' },
      )
      expect(refreshed.created).toBe(false)
      expect(refreshed.tree.id).toBe(first.tree.id)
      expect(refreshed.tree.title).toBe('Ship the plan store v2')
      expect(refreshed.tree.progress).toMatchObject({ total: 1, done: 1 })
      expect(harness.engine.listPlans({}).plans).toHaveLength(1)

      const skipped = harness.engine.importSession(SNAPSHOT, { key: 'demo', root: '/tmp/demo' }, false)
      expect(skipped.created).toBe(false)
      expect(skipped.actions).toBeNull()
      expect(skipped.tree.progress.total).toBe(1)
    } finally {
      harness.cleanup()
    }
  })
})
