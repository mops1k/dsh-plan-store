/**
 * Pure mapping between a DSH session (its goal and its todo list) and a plan.
 *
 * Goal and todo live in the session log, not in the plan store, so this module
 * contains no host access at all: it turns a snapshot into a plan input and
 * computes the reconciliation actions that keep an imported plan in sync with
 * the todo list. `dsh/session-state.ts` supplies the snapshot.
 *
 * @module dsh-plan-store/core/import-session
 */
import type { CreatePlanInput, PhaseTree, PlanTree, TaskStatus } from './types.js'

/** Tag attached to every plan created by the session import. */
export const IMPORT_TAG = 'imported'

/** Title of the phase that receives the imported todo items. */
export const IMPORT_PHASE_TITLE = 'Todos'

/** Durable phase of a DSH goal. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** The current goal of a session, as read from the session log. */
export interface SessionGoal {
  id: string
  revision: number
  objective: string
  phase: GoalPhase
  maxGoalRounds: number
  roundsStarted: number
  blockedReason?: { code: string; message: string }
  activation?: 'armed' | 'disarmed'
}

/** One todo item of a session. */
export interface SessionTodo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Where a piece of session state was read from. */
export type SessionStateSource = 'live' | 'projection' | 'log' | 'none'

/** Everything the import needs to know about a session. */
export interface SessionSnapshot {
  sessionId: string
  goal: SessionGoal | null
  todos: SessionTodo[]
  /** Source of the goal; `log` means the projection was stale or absent. */
  goalSource?: SessionStateSource
  /** Source of the todo list; `log` means the projection was stale or absent. */
  todosSource?: SessionStateSource
  /** Project of the session (its working directory); absent without a usable cwd. */
  workspace?: { key: string; root: string }
}

/** Map a todo status onto the plan task status. */
export function todoStatusToTask(status: SessionTodo['status']): TaskStatus {
  if (status === 'completed') return 'done'
  if (status === 'in_progress') return 'doing'
  return 'todo'
}

/** Human-readable description of the imported plan. */
export function sessionDescription(snapshot: SessionSnapshot): string {
  const lines = [`Imported from session ${snapshot.sessionId}.`]
  if (snapshot.goal !== null) {
    lines.push(
      '',
      `Goal ${snapshot.goal.id}: ${snapshot.goal.objective}`,
      `- phase: ${snapshot.goal.phase}`,
      `- rounds: ${snapshot.goal.roundsStarted}/${snapshot.goal.maxGoalRounds}`,
    )
    if (snapshot.goal.blockedReason !== undefined) {
      lines.push(`- blocked: ${snapshot.goal.blockedReason.code} — ${snapshot.goal.blockedReason.message}`)
    }
  } else {
    lines.push('', 'The session has no goal.')
  }
  lines.push('', `Todo items: ${snapshot.todos.length}.`)
  return lines.join('\n')
}

/** Title of the imported plan. */
export function sessionPlanTitle(snapshot: SessionSnapshot): string {
  const objective = snapshot.goal?.objective.trim() ?? ''
  if (objective.length > 0) return objective
  if (snapshot.todos.length > 0) return `Session todos (${snapshot.todos.length})`
  return `Session ${snapshot.sessionId}`
}

/** Map a session snapshot onto a new plan input. */
export function mapSessionToPlan(
  snapshot: SessionSnapshot,
  workspace: { key: string; root: string },
): CreatePlanInput {
  return {
    title: sessionPlanTitle(snapshot),
    description: sessionDescription(snapshot),
    workspace: workspace.key,
    workspaceRoot: workspace.root,
    tags: [IMPORT_TAG],
    sessionId: snapshot.sessionId,
    phases: [
      {
        title: IMPORT_PHASE_TITLE,
        tasks: snapshot.todos.map((todo) => ({
          title: todo.content,
          status: todoStatusToTask(todo.status),
        })),
      },
    ],
  }
}

/** One status change computed by {@link planSyncActions}. */
export interface TodoStatusChange {
  taskId: string
  title: string
  status: TaskStatus
}

/** Reconciliation between an imported plan and the current todo list. */
export interface PlanSyncActions {
  /** Todo titles missing from the plan. */
  add: SessionTodo[]
  /** Tasks whose status must follow the todo list. */
  update: TodoStatusChange[]
  /** Task ids that no longer exist in the todo list. */
  remove: string[]
}

/** Find the phase that holds imported todos. */
export function importedPhase(tree: PlanTree): PhaseTree | null {
  return tree.phases.find((phase) => phase.title === IMPORT_PHASE_TITLE) ?? tree.phases[0] ?? null
}

/**
 * Compute how to reconcile an imported plan with a todo list.
 *
 * Todo items have no identity, so tasks are matched by their title; duplicates
 * are matched in order. Tasks that disappeared from the list are reported for
 * removal, which keeps the plan a faithful mirror of the session.
 */
export function planSyncActions(tree: PlanTree, todos: readonly SessionTodo[]): PlanSyncActions {
  const phase = importedPhase(tree)
  const tasks = phase === null ? [] : [...phase.tasks]
  const remaining = [...tasks]
  const add: SessionTodo[] = []
  const update: TodoStatusChange[] = []

  for (const todo of todos) {
    const index = remaining.findIndex((task) => task.title === todo.content)
    if (index < 0) {
      add.push(todo)
      continue
    }
    const task = remaining[index]!
    remaining.splice(index, 1)
    const status = todoStatusToTask(todo.status)
    if (task.status !== status) update.push({ taskId: task.id, title: task.title, status })
  }

  return { add, update, remove: remaining.map((task) => task.id) }
}
