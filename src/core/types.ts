/**
 * Domain types of the plan store.
 *
 * The model is three levels deep — plan → phase → task — plus an append-only
 * `plan_events` journal. Statuses are plain string unions so the values are
 * shared verbatim with the tool schemas, the HTTP API and the browser client.
 *
 * @module dsh-plan-store/core/types
 */

/** Lifecycle states of a plan. */
export const PLAN_STATUSES = ['backlog', 'active', 'blocked', 'done', 'archived'] as const

/** Lifecycle state of a plan. */
export type PlanStatus = (typeof PLAN_STATUSES)[number]

/** Lifecycle states shared by phases and tasks. */
export const WORK_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const

/** Lifecycle state of a phase. */
export type PhaseStatus = (typeof WORK_STATUSES)[number]

/** Lifecycle state of a task. */
export type TaskStatus = (typeof WORK_STATUSES)[number]

/** Priorities a plan can carry. */
export const PLAN_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

/** Priority of a plan. */
export type PlanPriority = (typeof PLAN_PRIORITIES)[number]

/** Kinds of entries recorded in the plan journal. */
export const PLAN_EVENT_KINDS = [
  'created',
  'updated',
  'status',
  'phase',
  'task',
  'export',
  'archived',
  'purged',
] as const

/** Kind of a plan journal entry. */
export type PlanEventKind = (typeof PLAN_EVENT_KINDS)[number]

/** A plan: the top level of the store. */
export interface Plan {
  id: string
  title: string
  description: string
  status: PlanStatus
  priority: PlanPriority
  /** Workspace key the plan belongs to (empty for an unbound plan). */
  workspace: string
  /** Absolute workspace root captured when the plan was created, when known. */
  workspaceRoot: string
  tags: string[]
  /** Last file the plan was exported to, when it was exported at least once. */
  exportPath: string | null
  /** Session that created the plan, when the host provided one. */
  sessionId: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

/** A phase groups tasks inside a plan. */
export interface Phase {
  id: string
  planId: string
  title: string
  status: PhaseStatus
  notes: string
  position: number
  createdAt: string
  updatedAt: string
}

/** A task is the smallest unit of work. */
export interface Task {
  id: string
  planId: string
  phaseId: string
  title: string
  status: TaskStatus
  notes: string
  /** File paths and URLs the task refers to. */
  links: string[]
  position: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

/** One append-only journal entry of a plan. */
/** Lossless-JSON payload of a journal entry (what the engine actually records). */
export type PlanEventData = Record<string, string | number | boolean | null>

/** One append-only journal entry of a plan. */
export interface PlanEvent {
  id: string
  planId: string
  kind: PlanEventKind
  message: string
  data: PlanEventData
  sessionId: string | null
  createdAt: string
}

/** Aggregated task counters of a plan or a phase. */
export interface PlanProgress {
  total: number
  todo: number
  doing: number
  blocked: number
  done: number
  /** Share of finished tasks in percent (0–100, rounded). */
  percent: number
}

/** A phase together with its tasks and its own progress. */
export interface PhaseTree extends Phase {
  tasks: Task[]
  progress: PlanProgress
}

/** A full plan: the tree plus the tail of its journal. */
export interface PlanTree extends Plan {
  phases: PhaseTree[]
  progress: PlanProgress
  events: PlanEvent[]
}

/** A list row: the plan plus derived counters and the next open task. */
export interface PlanSummary extends Plan {
  phaseCount: number
  taskCount: number
  progress: PlanProgress
  /** First task that is `doing`, else the first `todo`, else null. */
  nextTask: Task | null
}

/** One full-text search hit. */
export interface SearchHit {
  kind: 'plan' | 'task'
  id: string
  planId: string
  title: string
  /** Highlighted excerpt produced by FTS5 (or a plain excerpt in the fallback). */
  snippet: string
  /** Relevance score; lower is better (bm25). */
  score: number
}

/** Filter accepted by the list query. */
export interface PlanFilter {
  status?: PlanStatus | 'all'
  workspace?: string
  query?: string
  includeArchived?: boolean
  limit?: number
  offset?: number
}

/** Counters of the whole store (optionally scoped to one workspace). */
export interface PlanStatusReport {
  root: string
  dbPath: string
  exportDir: string
  total: number
  archived: number
  byStatus: Record<PlanStatus, number>
  byTaskStatus: Record<TaskStatus, number>
  phaseCount: number
  taskCount: number
  /** Non-archived plans untouched for longer than `stalePlanDays`. */
  stale: PlanSummary[]
  fts: boolean
}

/** Input accepted by `createPlan`. */
export interface CreatePlanInput {
  title: string
  description?: string
  workspace?: string
  workspaceRoot?: string
  priority?: PlanPriority
  status?: PlanStatus
  tags?: string[]
  sessionId?: string
  phases?: CreatePhaseInput[]
}

/** Input accepted for a nested phase of `createPlan` or `addPhase`. */
export interface CreatePhaseInput {
  title: string
  notes?: string
  status?: PhaseStatus
  position?: number
  tasks?: Array<string | CreateTaskInput>
}

/** Input accepted for a nested task of a phase or for `addTask`. */
export interface CreateTaskInput {
  title: string
  notes?: string
  status?: TaskStatus
  links?: string[]
  position?: number
}

/** Fields `updatePlan` may change. */
export interface UpdatePlanPatch {
  title?: string
  description?: string
  status?: PlanStatus
  priority?: PlanPriority
  tags?: string[]
  workspace?: string
  workspaceRoot?: string
}

/** Fields `updatePhase` may change. */
export interface UpdatePhasePatch {
  title?: string
  status?: PhaseStatus
  notes?: string
  position?: number
}

/** Fields `updateTask` may change. */
export interface UpdateTaskPatch {
  title?: string
  status?: TaskStatus
  notes?: string
  links?: string[]
  phaseId?: string
  position?: number
}

/** Destination of a drag&drop move. */
export interface TaskMove {
  status?: TaskStatus
  phaseId?: string
  position?: number
}

/** Narrow an unknown value to a plan status. */
export function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === 'string' && (PLAN_STATUSES as readonly string[]).includes(value)
}

/** Narrow an unknown value to a work status (phase or task). */
export function isWorkStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (WORK_STATUSES as readonly string[]).includes(value)
}

/** Narrow an unknown value to a task status. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return isWorkStatus(value)
}

/** Narrow an unknown value to a phase status. */
export function isPhaseStatus(value: unknown): value is PhaseStatus {
  return isWorkStatus(value)
}

/** Narrow an unknown value to a plan priority. */
export function isPlanPriority(value: unknown): value is PlanPriority {
  return typeof value === 'string' && (PLAN_PRIORITIES as readonly string[]).includes(value)
}

/** Narrow an unknown value to a journal entry kind. */
export function isPlanEventKind(value: unknown): value is PlanEventKind {
  return typeof value === 'string' && (PLAN_EVENT_KINDS as readonly string[]).includes(value)
}

/** Normalize a stored `position` into a non-negative integer. */
export function clampPosition(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.trunc(parsed)
  return rounded < 0 ? 0 : rounded
}

/** Compute progress counters from a list of tasks. */
export function progressOf(tasks: readonly Pick<Task, 'status'>[]): PlanProgress {
  const progress: PlanProgress = { total: tasks.length, todo: 0, doing: 0, blocked: 0, done: 0, percent: 0 }
  for (const task of tasks) {
    if (task.status === 'todo') progress.todo += 1
    else if (task.status === 'doing') progress.doing += 1
    else if (task.status === 'blocked') progress.blocked += 1
    else progress.done += 1
  }
  progress.percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)
  return progress
}
