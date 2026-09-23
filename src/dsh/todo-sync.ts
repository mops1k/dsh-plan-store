/**
 * Automatic todo-panel sync for plans.
 *
 * The DSH todo panel is fed by the session event `todo/write`, appended by the
 * host plugin `@deepseek-ai/dsh-tool-todo` (`exec.agent.session.append("todo/write",
 * { todos })`) and folded into the `todos` session projection (last-write-wins,
 * reset on `turn/start`). Nothing about that event is private to the host tool,
 * so this module appends it directly after a plan mutation: the panel then shows
 * the tasks of the plan that was just touched.
 *
 * The write is a merge, never a replacement: items carrying the marker of the
 * synced plan are refreshed, and everything the model wrote by hand (or that
 * belongs to another plan) is kept as it was. Appending is best-effort — a
 * session without an owning agent, a host without the todo tool and a rejected
 * append all degrade to `false` instead of failing the plan tool.
 *
 * @module dsh-plan-store/dsh/todo-sync
 */
import type { Context } from '@deepseek-ai/cordis'

import type { PlanStoreConfig } from '../core/config.js'
import type { SessionTodo } from '../core/import-session.js'
import type { PlanTree, TaskStatus } from '../core/types.js'
import { toTodos } from './session-state.js'

/** Session event type the host todo tool writes and the panel reads. */
const TODO_EVENT = 'todo/write'

/** Session event that resets the host todo projection to an empty list. */
const TURN_START_EVENT = 'turn/start'

/** Marker prefix that identifies the items owned by one plan. */
const MARKER_PREFIX = '[plan:'

/** Structural view of the session behind `exec.agent.session`. */
export interface TodoSessionLike {
  append(type: string, data: unknown): void
  snapshotEvents?(): readonly unknown[]
}

/** Marker prefix of one plan, used to recognize and replace its items. */
export function planMarker(planId: string): string {
  return `${MARKER_PREFIX}${planId}] `
}

/** The owning session of a tool execution, when the host exposes one. */
export function sessionOf(exec: unknown): TodoSessionLike | null {
  const session = (exec as { agent?: { session?: TodoSessionLike } } | undefined)?.agent?.session
  if (session === undefined || session === null) return null
  return typeof session.append === 'function' ? session : null
}

/** Map a plan task status onto a todo status (`blocked` stays visible as pending). */
function todoStatusOf(status: TaskStatus): SessionTodo['status'] {
  if (status === 'doing') return 'in_progress'
  if (status === 'done') return 'completed'
  return 'pending'
}

/**
 * Build the todo list of one plan.
 *
 * Archived plans produce nothing. At most one item is `in_progress` unless the
 * deployment allows parallel work, and the list is capped by `todoMaxItems` so
 * a long plan cannot flood the panel.
 */
export function planTodoItems(tree: PlanTree, config: PlanStoreConfig): SessionTodo[] {
  if (tree.status === 'archived') return []
  const marker = planMarker(tree.id)
  const items: SessionTodo[] = []
  let active = 0
  for (const phase of tree.phases) {
    for (const task of phase.tasks) {
      let status = todoStatusOf(task.status)
      if (status === 'in_progress') {
        if (!config.todoParallelInProgress && active >= 1) status = 'pending'
        else active += 1
      }
      items.push({ content: `${marker}${task.title}`, status })
    }
  }
  return items.slice(0, Math.max(0, config.todoMaxItems))
}

/**
 * Read the current todo list from the session log.
 *
 * The fold is the one the host projection performs: the last `todo/write` wins,
 * and a `turn/start` after it resets the list to empty. A session without
 * `snapshotEvents` is treated as having no list.
 */
export function readSessionTodos(session: TodoSessionLike): SessionTodo[] {
  if (typeof session.snapshotEvents !== 'function') return []
  let events: readonly unknown[]
  try {
    events = session.snapshotEvents()
  } catch {
    return []
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: unknown; data?: { todos?: unknown } } | null
    if (event === null || typeof event !== 'object') continue
    if (event.type === TURN_START_EVENT) return []
    if (event.type === TODO_EVENT) return toTodos(event.data?.todos)
  }
  return []
}

/**
 * Merge the items of one plan into the current list.
 *
 * Items carrying the plan marker are dropped first (they are the stale snapshot
 * of this plan), then the fresh items are appended. Content is unique in the
 * host list, so the merge de-duplicates by content and lets the plan win: a
 * hand-written item that happens to carry the same text is replaced by its
 * plan version instead of being duplicated.
 */
export function mergePlanTodos(
  current: readonly SessionTodo[],
  planId: string,
  items: readonly SessionTodo[],
): SessionTodo[] {
  const marker = planMarker(planId)
  const merged = new Map<string, SessionTodo>()
  for (const item of current) {
    if (item.content.startsWith(marker)) continue
    if (!merged.has(item.content)) merged.set(item.content, item)
  }
  for (const item of items) {
    if (item.content.trim().length === 0) continue
    merged.set(item.content, item)
  }
  return [...merged.values()]
}

/**
 * Push the current state of one plan into the calling session's todo panel.
 *
 * @param ctx - host context, used only for logging.
 * @param exec - tool execution carrying the owning agent session.
 * @param tree - plan to project, or `null` to only drop this plan's items.
 * @param planId - plan whose marker identifies the items to refresh.
 * @param config - shared configuration (toggle, parallel policy, item cap).
 * @returns `true` when a `todo/write` snapshot was appended.
 */
export function syncPlanTodos(
  ctx: Context,
  exec: unknown,
  tree: PlanTree | null,
  planId: string,
  config: PlanStoreConfig,
): boolean {
  if (!config.syncTodos) return false
  const session = sessionOf(exec)
  if (session === null) return false
  try {
    const current = readSessionTodos(session)
    const items = tree === null ? [] : planTodoItems(tree, config)
    const merged = mergePlanTodos(current, planId, items)
    session.append(TODO_EVENT, { todos: merged })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      ctx.logger.warn(`Todo sync for plan ${planId} failed: ${message}`)
    } catch {
      console.warn(`[dsh-plan-store] Todo sync for plan ${planId} failed: ${message}`)
    }
    return false
  }
}
