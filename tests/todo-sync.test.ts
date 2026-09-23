import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'

import { mergeConfig, type PlanStoreConfig } from '../src/core/config'
import type { SessionTodo } from '../src/core/import-session'
import type { PlanTree } from '../src/core/types'
import {
  mergePlanTodos,
  planMarker,
  planTodoItems,
  readSessionTodos,
  syncPlanTodos,
  type TodoSessionLike,
} from '../src/dsh/todo-sync'
import { makeHarness, type TestHarness } from './helpers'

let harness: TestHarness

beforeEach(() => {
  harness = makeHarness()
})

afterEach(() => {
  harness.cleanup()
})

/** Config with the todo sync options under test. */
function config(overrides: Partial<PlanStoreConfig> = {}): PlanStoreConfig {
  return mergeConfig(overrides)
}

/** Create a plan with two phases and return its tree. */
function seedPlan(status: 'active' | 'archived' = 'active'): PlanTree {
  const created = harness.engine.createPlan({
    title: 'Sync me',
    workspace: 'demo',
    workspaceRoot: harness.workspace,
    status,
    phases: [
      { title: 'Core', tasks: [{ title: 'first' }, { title: 'second', status: 'doing' }] },
      { title: 'Polish', tasks: [{ title: 'third', status: 'done' }, { title: 'fourth', status: 'blocked' }] },
    ],
  })
  return created
}

/** Minimal session double that records appended events. */
function fakeSession(): TodoSessionLike & { events: Array<{ type: string; data: unknown }> } {
  const events: Array<{ type: string; data: unknown }> = []
  return {
    events,
    append(type: string, data: unknown): void {
      events.push({ type, data })
    },
    snapshotEvents(): readonly unknown[] {
      return events
    },
  }
}

/** Context double: only the logger is read by the sync. */
function fakeContext(): Context {
  return { logger: { warn: () => {} } } as unknown as Context
}

describe('planTodoItems', () => {
  it('maps task statuses and prefixes every item with the plan marker', () => {
    const tree = seedPlan()
    const items = planTodoItems(tree, config())
    expect(items.map((item) => item.status)).toEqual(['pending', 'in_progress', 'completed', 'pending'])
    expect(items.every((item) => item.content.startsWith(planMarker(tree.id)))).toBe(true)
    expect(items[0]!.content).toBe(`${planMarker(tree.id)}first`)
  })

  it('keeps a single in_progress item unless parallel work is allowed', () => {
    const tree = seedPlan()
    harness.engine.updateTask(tree.phases[0]!.tasks[0]!.id, { status: 'doing' })
    const updated = harness.engine.requireTree(tree.id, 0)
    const single = planTodoItems(updated, config())
    expect(single.filter((item) => item.status === 'in_progress')).toHaveLength(1)
    const parallel = planTodoItems(updated, config({ todoParallelInProgress: true }))
    expect(parallel.filter((item) => item.status === 'in_progress')).toHaveLength(2)
  })

  it('caps the list and skips archived plans', () => {
    const tree = seedPlan()
    expect(planTodoItems(tree, config({ todoMaxItems: 2 }))).toHaveLength(2)
    harness.engine.archivePlan(tree.id)
    expect(planTodoItems(harness.engine.requireTree(tree.id, 0), config())).toEqual([])
  })
})

describe('readSessionTodos', () => {
  it('returns the newest todo/write snapshot', () => {
    const session = fakeSession()
    const first: SessionTodo[] = [{ content: 'a', status: 'pending' }]
    const second: SessionTodo[] = [{ content: 'b', status: 'completed' }]
    session.append('todo/write', { todos: first })
    session.append('todo/write', { todos: second })
    expect(readSessionTodos(session)).toEqual(second)
  })

  it('treats a turn/start after the snapshot as a reset', () => {
    const session = fakeSession()
    session.append('todo/write', { todos: [{ content: 'a', status: 'pending' }] })
    session.append('turn/start', {})
    expect(readSessionTodos(session)).toEqual([])
  })

  it('degrades to an empty list without a readable log', () => {
    expect(readSessionTodos({ append: () => {} })).toEqual([])
  })
})

describe('mergePlanTodos', () => {
  it('keeps foreign items, refreshes own items and de-duplicates by content', () => {
    const planId = 'p_demo0001'
    const current: SessionTodo[] = [
      { content: 'manual step', status: 'pending' },
      { content: `${planMarker(planId)}stale`, status: 'pending' },
      { content: `${planMarker(planId)}kept`, status: 'pending' },
    ]
    const items: SessionTodo[] = [
      { content: `${planMarker(planId)}kept`, status: 'completed' },
      { content: `${planMarker(planId)}fresh`, status: 'in_progress' },
    ]
    expect(mergePlanTodos(current, planId, items)).toEqual([
      { content: 'manual step', status: 'pending' },
      { content: `${planMarker(planId)}kept`, status: 'completed' },
      { content: `${planMarker(planId)}fresh`, status: 'in_progress' },
    ])
  })
})

describe('syncPlanTodos', () => {
  it('appends a merged todo/write snapshot for the touched plan', () => {
    const tree = seedPlan()
    const session = fakeSession()
    session.append('todo/write', { todos: [{ content: 'manual step', status: 'pending' }] })
    const exec = { agent: { id: 'session-1', session } }
    expect(syncPlanTodos(fakeContext(), exec, tree, tree.id, config())).toBe(true)
    const last = session.events.at(-1)
    expect(last?.type).toBe('todo/write')
    const todos = (last?.data as { todos: SessionTodo[] }).todos
    expect(todos.map((todo) => todo.content)).toEqual([
      'manual step',
      `${planMarker(tree.id)}first`,
      `${planMarker(tree.id)}second`,
      `${planMarker(tree.id)}third`,
      `${planMarker(tree.id)}fourth`,
    ])
  })

  it('drops the plan items when the tree is gone', () => {
    const tree = seedPlan()
    const session = fakeSession()
    const exec = { agent: { id: 'session-1', session } }
    syncPlanTodos(fakeContext(), exec, tree, tree.id, config())
    syncPlanTodos(fakeContext(), exec, null, tree.id, config())
    const todos = (session.events.at(-1)?.data as { todos: SessionTodo[] }).todos
    expect(todos).toEqual([])
  })

  it('does nothing when the sync is disabled or the session is missing', () => {
    const tree = seedPlan()
    const session = fakeSession()
    const exec = { agent: { id: 'session-1', session } }
    expect(syncPlanTodos(fakeContext(), exec, tree, tree.id, config({ syncTodos: false }))).toBe(false)
    expect(session.events).toHaveLength(0)
    expect(syncPlanTodos(fakeContext(), { agent: { id: 'session-1' } }, tree, tree.id, config())).toBe(false)
  })
})
