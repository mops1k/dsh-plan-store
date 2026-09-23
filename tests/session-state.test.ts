import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import {
  SessionStateError,
  applyGoalAction,
  liveSessionIds,
  readSessionState,
  toGoal,
  toTodos,
  writeTodos,
} from '../src/dsh/session-state'

/** Build a host context with live sessions, agents, goals and projections. */
function makeContext(
  options: { live?: boolean; goal?: unknown; todos?: unknown; goalService?: boolean; log?: unknown[] } = {},
): {
  ctx: Context
  appended: Array<{ type: string; data: unknown }>
  calls: string[]
} {
  const live = options.live !== false
  const appended: Array<{ type: string; data: unknown }> = []
  const calls: string[] = []
  const session = {
    id: 's-1',
    header: { cwd: '/home/mops1k/Development/demo-project' },
    append(type: string, data: unknown): void {
      appended.push({ type, data })
    },
    snapshotEvents: () => options.log ?? [],
  }
  const goalView =
    options.goal === undefined
      ? {
          id: 'g_1',
          revision: 7,
          objective: 'Ship the plan store',
          phase: 'active',
          maxGoalRounds: 8,
          roundsStarted: 3,
          activation: 'armed',
        }
      : options.goal
  const todos = options.todos === undefined ? [{ content: 'write tests', status: 'in_progress' }] : options.todos
  // Mutable goal state so a mutation is visible to the following read.
  let current: Record<string, unknown> | null =
    goalView === null ? null : { ...(goalView as Record<string, unknown>) }
  const goals =
    options.goalService === false
      ? undefined
      : {
          get: () => {
            calls.push('get')
            return current
          },
          pause: () => {
            calls.push('pause')
            current = { ...(current as object), phase: 'paused' }
            return current
          },
          resume: () => {
            calls.push('resume')
            current = { ...(current as object), phase: 'active' }
            return current
          },
          complete: () => {
            calls.push('complete')
            current = { ...(current as object), phase: 'complete' }
            return current
          },
          block: (_agent: unknown, _ref: unknown, reason: unknown) => {
            calls.push('block:' + JSON.stringify(reason))
            current = { ...(current as object), phase: 'blocked', blockedReason: reason }
            return current
          },
          edit: (_agent: unknown, _ref: unknown, request: unknown) => {
            calls.push('edit:' + JSON.stringify(request))
            current = { ...(current as object), ...(request as object) }
            return current
          },
          clear: () => {
            calls.push('clear')
            current = null
            return {}
          },
        }
  const ctx = {
    sessions: { get: (id: string) => (live && id === 's-1' ? session : undefined), list: () => (live ? [session] : []) },
    agents: { get: (id: string) => (live && id === 's-1' ? { id } : undefined) },
    goals,
    sessionProjections: {
      stateOf: (_session: unknown, key: string) =>
        key === 'todos' ? todos : { current: current === null ? null : { goal: current } },
    },
  } as unknown as Context
  return { ctx, appended, calls }
}

describe('toGoal and toTodos', () => {
  it('normalizes unknown shapes', () => {
    expect(toGoal(null)).toBeNull()
    expect(toGoal({})).toBeNull()
    expect(toGoal({ id: 'g', objective: 'o', revision: '3', phase: 'weird' })).toMatchObject({
      id: 'g',
      objective: 'o',
      revision: 3,
      phase: 'active',
    })
    expect(toTodos([{ content: ' a ', status: 'nope' }, { content: '' }, 'x'])).toEqual([{ content: 'a', status: 'pending' }])
    expect(toTodos(null)).toEqual([])
  })
})

describe('readSessionState', () => {
  it('reads the live goal and todo list plus the session workspace', () => {
    const { ctx } = makeContext()
    const state = readSessionState(ctx, 's-1')
    expect(state.sessionId).toBe('s-1')
    expect(state.workspace).toEqual({ key: 'demo-project', root: '/home/mops1k/Development/demo-project' })
    expect(state.goal).toMatchObject({ id: 'g_1', phase: 'active', roundsStarted: 3, activation: 'armed' })
    expect(state.todos).toEqual([{ content: 'write tests', status: 'in_progress' }])
  })

  it('falls back to the projection when the goal service is absent', () => {
    const { ctx } = makeContext({ goalService: false })
    const state = readSessionState(ctx, 's-1')
    expect(state.goal?.id).toBe('g_1')
    expect(state.goalSource).toBe('projection')
    expect(state.todosSource).toBe('projection')
  })

  it('reads the todo list from the session log when the projection is stale', () => {
    const { ctx } = makeContext({
      todos: null,
      log: [
        { type: 'todo/write', data: { todos: [{ content: 'старое', status: 'pending' }] } },
        { type: 'assistant/message', data: {} },
        { type: 'todo/write', data: { todos: [{ content: 'свежее', status: 'completed' }, { content: 'второе', status: 'in_progress' }] } },
      ],
    })
    const state = readSessionState(ctx, 's-1')
    expect(state.todosSource).toBe('log')
    expect(state.todos).toEqual([
      { content: 'свежее', status: 'completed' },
      { content: 'второе', status: 'in_progress' },
    ])
  })

  it('reads the goal from the session log when the service and projection are silent', () => {
    const { ctx } = makeContext({
      goal: null,
      goalService: false,
      log: [
        { type: 'goal/change', data: { operation: 'create', goal: { id: 'g_9', revision: 2, objective: 'Из журнала', phase: 'paused', maxGoalRounds: 3, roundsStarted: 1 } } },
      ],
    })
    const state = readSessionState(ctx, 's-1')
    expect(state.goalSource).toBe('log')
    expect(state.goal).toMatchObject({ id: 'g_9', objective: 'Из журнала', phase: 'paused' })
  })

  it('treats a cleared goal in the log as no goal', () => {
    const { ctx } = makeContext({
      goal: null,
      goalService: false,
      log: [
        { type: 'goal/change', data: { operation: 'create', goal: { id: 'g_9', objective: 'x' } } },
        { type: 'goal/change', data: { operation: 'clear' } },
      ],
    })
    const state = readSessionState(ctx, 's-1')
    expect(state.goal).toBeNull()
  })

  it('rejects a session that is not live here', () => {
    const { ctx } = makeContext({ live: false })
    expect(() => readSessionState(ctx, 's-9')).toThrow(SessionStateError)
    expect(() => readSessionState(ctx, 's-9')).toThrow(/not live/u)
    expect(() => readSessionState(ctx, '  ')).toThrow(/sessionId is required/u)
    expect(liveSessionIds(ctx)).toEqual([])
  })
})

describe('applyGoalAction', () => {
  it('runs the lifecycle actions with the current revision', () => {
    const { ctx, calls } = makeContext()
    expect(applyGoalAction(ctx, 's-1', 'pause').goal?.phase).toBe('paused')
    applyGoalAction(ctx, 's-1', 'resume')
    applyGoalAction(ctx, 's-1', 'complete')
    applyGoalAction(ctx, 's-1', 'block', { reason: 'waiting for input', code: 'needs-input' })
    applyGoalAction(ctx, 's-1', 'edit', { objective: 'new objective', maxGoalRounds: 4 })
    applyGoalAction(ctx, 's-1', 'clear')
    expect(calls).toContain('pause')
    expect(calls).toContain('resume')
    expect(calls).toContain('complete')
    expect(calls).toContain('block:{"code":"needs-input","message":"waiting for input"}')
    expect(calls).toContain('edit:{"objective":"new objective","maxGoalRounds":4}')
    expect(calls).toContain('clear')
  })

  it('rejects an edit without changes and a session without a goal', () => {
    const { ctx } = makeContext()
    expect(() => applyGoalAction(ctx, 's-1', 'edit', {})).toThrow(/objective or maxGoalRounds/u)

    const noGoal = makeContext({ goal: null })
    expect(() => applyGoalAction(noGoal.ctx, 's-1', 'pause')).toThrow(/no goal/u)
    expect(() => applyGoalAction(noGoal.ctx, 's-1', 'pause')).toThrow(SessionStateError)
  })

  it('requires a live agent', () => {
    const { ctx } = makeContext({ live: false })
    expect(() => applyGoalAction(ctx, 's-2', 'pause')).toThrow(/not live/u)
  })
})

describe('writeTodos', () => {
  it('appends a whole-list snapshot to the session', () => {
    const { ctx, appended } = makeContext()
    const state = writeTodos(ctx, 's-1', [
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'pending' },
    ])
    expect(appended).toEqual([
      { type: 'todo/write', data: { todos: [{ content: 'first', status: 'completed' }, { content: 'second', status: 'pending' }] } },
    ])
    expect(state.todos).toHaveLength(2)
  })

  it('rejects a session without an appendable log', () => {
    const { ctx } = makeContext()
    ;(ctx.sessions as unknown as { get: () => unknown }).get = () => ({ id: 's-1' })
    expect(() => writeTodos(ctx, 's-1', [])).toThrow(/cannot record a todo list/u)
  })
})
