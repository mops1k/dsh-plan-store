/**
 * Host access to the goal and todo state of a live session.
 *
 * DSH keeps both in the session log (event-sourced), so this module reads them
 * through `ctx.sessionProjections` and mutates them through `ctx.goals` (a
 * compare-and-set lifecycle keyed by the live agent) and `Session.append`
 * (`todo/write`, a whole-list replacement). Everything is resolved structurally
 * and optionally: the plugin works without those services, and every operation
 * on a session that is not live in this process fails with a clear error
 * instead of writing anywhere.
 *
 * @module dsh-plan-store/dsh/session-state
 */
import type { Context } from '@deepseek-ai/cordis'

import type {
  GoalPhase,
  SessionGoal,
  SessionSnapshot,
  SessionStateSource,
  SessionTodo,
} from '../core/import-session.js'
import { readService, resolveWorkspace } from './session.js'

/** Failure modes of the session bridge. */
export type SessionStateErrorCode = 'not_live' | 'no_goal' | 'invalid'

/** Error thrown by the session bridge for expected failures. */
export class SessionStateError extends Error {
  constructor(
    readonly code: SessionStateErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SessionStateError'
  }
}

/** Structural view of `ctx.sessions` used here. */
export interface SessionStoreLike {
  get(id: string): unknown
  list?(): unknown[]
}

/** Structural view of `ctx.agents`. */
export interface AgentRegistryLike {
  get(id: string): unknown
}

/** Structural view of `ctx.sessionProjections`. */
export interface ProjectionsLike {
  stateOf(session: unknown, key: string): unknown
}

/** Structural view of `ctx.goals` (compare-and-set goal lifecycle). */
export interface GoalServiceLike {
  get(agent: unknown): unknown
  pause(agent: unknown, ref: unknown): unknown
  resume(agent: unknown, ref: unknown): unknown
  complete(agent: unknown, ref: unknown): unknown
  block(agent: unknown, ref: unknown, reason: unknown): unknown
  edit(agent: unknown, ref: unknown, request: unknown): unknown
  clear(agent: unknown, ref: unknown): unknown
}

/** Actions the board may perform on a goal. */
export type GoalAction = 'pause' | 'resume' | 'complete' | 'block' | 'edit' | 'clear'

/** Payload of a goal action. */
export interface GoalActionPayload {
  objective?: string
  maxGoalRounds?: number
  reason?: string
  code?: string
}

/** Text of a value, or an empty string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Number of a value, or a fallback. */
function number(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Narrow a value to a goal phase. */
function goalPhase(value: unknown): GoalPhase {
  return value === 'paused' || value === 'blocked' || value === 'complete' ? value : 'active'
}

/** Map an unknown goal view onto a {@link SessionGoal}. */
export function toGoal(value: unknown): SessionGoal | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = text(record['id'])
  const objective = text(record['objective'])
  if (id.length === 0 && objective.length === 0) return null
  const blocked = record['blockedReason']
  const activation = record['activation']
  return {
    id,
    revision: number(record['revision'], 0),
    objective,
    phase: goalPhase(record['phase']),
    maxGoalRounds: number(record['maxGoalRounds'], 0),
    roundsStarted: number(record['roundsStarted'], 0),
    ...(blocked !== null && typeof blocked === 'object'
      ? {
          blockedReason: {
            code: text((blocked as Record<string, unknown>)['code']),
            message: text((blocked as Record<string, unknown>)['message']),
          },
        }
      : {}),
    ...(activation === 'armed' || activation === 'disarmed' ? { activation } : {}),
  }
}

/** Map an unknown todo list onto {@link SessionTodo} items. */
export function toTodos(value: unknown): SessionTodo[] {
  if (!Array.isArray(value)) return []
  const out: SessionTodo[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const content = text(record['content']).trim()
    if (content.length === 0) continue
    const status = record['status']
    out.push({
      content,
      status: status === 'completed' || status === 'in_progress' ? status : 'pending',
    })
  }
  return out
}

/** Resolve the session store. */
function sessionStore(ctx: Context): SessionStoreLike | undefined {
  return readService<SessionStoreLike>(ctx, 'sessions')
}

/** Resolve the agent registry. */
function agentRegistry(ctx: Context): AgentRegistryLike | undefined {
  return readService<AgentRegistryLike>(ctx, 'agents')
}

/** Resolve the projection registry. */
function projections(ctx: Context): ProjectionsLike | undefined {
  return readService<ProjectionsLike>(ctx, 'sessionProjections')
}

/** Resolve the goal service. */
function goalService(ctx: Context): GoalServiceLike | undefined {
  return readService<GoalServiceLike>(ctx, 'goals')
}

/** Ids of the sessions that are live in this process, newest last. */
export function liveSessionIds(ctx: Context): string[] {
  const store = sessionStore(ctx)
  if (store === undefined || typeof store.list !== 'function') return []
  try {
    return store
      .list()
      .map((session) => text((session as Record<string, unknown>)['id']))
      .filter((id) => id.length > 0)
  } catch {
    return []
  }
}

/** Read the live session or throw. */
function requireSession(ctx: Context, sessionId: string): unknown {
  const id = sessionId.trim()
  if (id.length === 0) throw new SessionStateError('invalid', 'A sessionId is required.')
  const store = sessionStore(ctx)
  const session = store?.get(id)
  if (session === undefined || session === null) {
    throw new SessionStateError('not_live', `Session ${id} is not live in this dsh process.`)
  }
  return session
}

/** Read the live agent of a session, when the registry has it. */
function liveAgent(ctx: Context, sessionId: string): unknown {
  const registry = agentRegistry(ctx)
  return registry?.get(sessionId) ?? undefined
}

/** Raw event list of a session, when the session exposes its log. */
function sessionEvents(session: unknown): Array<Record<string, unknown>> | null {
  const read = (session as { snapshotEvents?: () => unknown }).snapshotEvents
  if (typeof read !== 'function') return null
  try {
    const events = read.call(session)
    return Array.isArray(events) ? (events as Array<Record<string, unknown>>) : null
  } catch {
    return null
  }
}

/**
 * Last whole-list todo snapshot of the session log.
 *
 * `todo/write` is last-write-wins, so the newest event is the current list. The
 * log is append-only and therefore authoritative: it is the fallback whenever
 * the `todos` projection is missing or stale (observed: the persisted
 * projection cache can hold `null` while the log still has the snapshot).
 *
 * @returns the list, or `null` when the session does not expose its log.
 */
export function todosFromLog(session: unknown): SessionTodo[] | null {
  const events = sessionEvents(session)
  if (events === null) return null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.['type'] !== 'todo/write') continue
    const data = event['data'] as { todos?: unknown } | undefined
    return toTodos(data?.todos)
  }
  return []
}

/**
 * Goal derived from the session log, used when both the live view and the
 * projection are unavailable. `clear` is a tombstone, so it ends the search.
 */
export function goalFromLog(session: unknown): SessionGoal | null {
  const events = sessionEvents(session)
  if (events === null) return null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.['type'] !== 'goal/change') continue
    const data = event['data'] as { operation?: unknown; goal?: unknown } | undefined
    if (data?.operation === 'clear') return null
    const goal = toGoal(data?.goal)
    if (goal !== null) return goal
  }
  return null
}

/** Read the goal of a live session: live view, projection, then the log. */
function readGoal(
  ctx: Context,
  sessionId: string,
  session: unknown,
): { goal: SessionGoal | null; source: SessionStateSource } {
  const goals = goalService(ctx)
  const agent = liveAgent(ctx, sessionId)
  if (goals !== undefined && agent !== undefined) {
    try {
      const view = toGoal(goals.get(agent))
      if (view !== null) return { goal: view, source: 'live' }
    } catch {
      /* fall through to the projection */
    }
  }
  const registry = projections(ctx)
  if (registry !== undefined) {
    try {
      const state = registry.stateOf(session, 'goal') as { current?: { goal?: unknown } } | undefined
      const goal = toGoal(state?.current?.goal)
      if (goal !== null) return { goal, source: 'projection' }
    } catch {
      /* fall through to the log */
    }
  }
  const logged = goalFromLog(session)
  if (logged !== null) return { goal: logged, source: 'log' }
  return { goal: null, source: sessionEvents(session) === null ? 'none' : 'projection' }
}

/** Read the todo list of a live session: projection first, then the log. */
function readTodos(ctx: Context, session: unknown): { todos: SessionTodo[]; source: SessionStateSource } {
  const registry = projections(ctx)
  if (registry !== undefined) {
    try {
      const value = registry.stateOf(session, 'todos')
      if (Array.isArray(value)) return { todos: toTodos(value), source: 'projection' }
    } catch {
      /* fall through to the log */
    }
  }
  const logged = todosFromLog(session)
  if (logged !== null) return { todos: logged, source: 'log' }
  return { todos: [], source: 'none' }
}

/**
 * Read the goal and todo state of one live session.
 *
 * @param ctx - host context.
 * @param sessionId - session to read.
 * @returns the snapshot consumed by the import mapping and the board tab.
 * @throws {@link SessionStateError} when the session is not live here.
 */
export function readSessionState(ctx: Context, sessionId: string): SessionSnapshot {
  const session = requireSession(ctx, sessionId)
  const goal = readGoal(ctx, sessionId, session)
  const todos = readTodos(ctx, session)
  const workspace = resolveWorkspace(ctx, { agent: { id: sessionId } })
  return {
    sessionId: sessionId.trim(),
    goal: goal.goal,
    todos: todos.todos,
    goalSource: goal.source,
    todosSource: todos.source,
    ...(workspace.root.length > 0 ? { workspace } : {}),
  }
}

/**
 * Perform a goal lifecycle action on a live session.
 *
 * The revision read together with the goal is sent back as the compare-and-set
 * reference, so a stale board cannot overwrite a newer goal state.
 */
export function applyGoalAction(
  ctx: Context,
  sessionId: string,
  action: GoalAction,
  payload: GoalActionPayload = {},
): SessionSnapshot {
  const session = requireSession(ctx, sessionId)
  const goals = goalService(ctx)
  const agent = liveAgent(ctx, sessionId)
  if (goals === undefined || agent === undefined) {
    throw new SessionStateError('not_live', 'Goal actions require a live agent in this dsh process.')
  }
  const current = readGoal(ctx, sessionId, session).goal
  if (current === null) throw new SessionStateError('no_goal', 'This session has no goal to change.')
  const ref = { id: current.id, revision: current.revision }
  try {
    if (action === 'pause') goals.pause(agent, ref)
    else if (action === 'resume') goals.resume(agent, ref)
    else if (action === 'complete') goals.complete(agent, ref)
    else if (action === 'clear') goals.clear(agent, ref)
    else if (action === 'block') {
      goals.block(agent, ref, {
        code: (payload.code ?? 'blocked-from-board').trim() || 'blocked-from-board',
        message: (payload.reason ?? 'Blocked from the plan board.').trim() || 'Blocked from the plan board.',
      })
    } else {
      const request: Record<string, unknown> = {}
      if (payload.objective !== undefined && payload.objective.trim().length > 0) {
        request['objective'] = payload.objective.trim()
      }
      if (payload.maxGoalRounds !== undefined) request['maxGoalRounds'] = payload.maxGoalRounds
      if (Object.keys(request).length === 0) {
        throw new SessionStateError('invalid', 'Editing a goal needs objective or maxGoalRounds.')
      }
      goals.edit(agent, ref, request)
    }
  } catch (error) {
    if (error instanceof SessionStateError) throw error
    throw new SessionStateError('invalid', error instanceof Error ? error.message : String(error))
  }
  return readSessionState(ctx, sessionId)
}

/**
 * Replace the todo list of a live session.
 *
 * `todo_write` semantics: the whole list is written at once, so the board sends
 * the complete replacement rather than a delta.
 */
export function writeTodos(ctx: Context, sessionId: string, todos: readonly SessionTodo[]): SessionSnapshot {
  const session = requireSession(ctx, sessionId)
  const append = (session as { append?: (type: string, data: unknown) => unknown }).append
  if (typeof append !== 'function') {
    throw new SessionStateError('not_live', 'This session cannot record a todo list in this process.')
  }
  const normalized = toTodos(todos)
  try {
    append.call(session, 'todo/write', { todos: normalized })
  } catch (error) {
    throw new SessionStateError('invalid', error instanceof Error ? error.message : String(error))
  }
  const state = readSessionState(ctx, sessionId)
  return { ...state, todos: normalized }
}
