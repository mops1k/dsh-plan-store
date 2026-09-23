/**
 * Business operations over {@link PlanStore}: validation, ordering, cascades,
 * the journal and the plan-status automation.
 *
 * Everything the tools, the HTTP API and the human command need goes through
 * this class, so the invariants live in one place:
 * - a plan title must not be blank, statuses and priorities must be known values;
 * - tasks always belong to a phase of their own plan;
 * - `done` stamps `completed_at`, leaving `done` clears it;
 * - the plan status follows the tasks (first `doing` → `active`, all `done` →
 *   `done`, leaving `done` → `active`) unless it was set to `blocked` or
 *   `archived` by hand;
 * - every change appends a `plan_events` entry.
 *
 * @module dsh-plan-store/core/engine
 */
import { DEFAULT_EXPORT_DIR, genId } from './paths.js'
import type { PlanStoreConfig } from './config.js'
import { PlanStore, type SqlValue } from './store.js'
import { exportPlanToWorkspace } from './export.js'
import {
  importedPhase,
  mapSessionToPlan,
  planSyncActions,
  sessionDescription,
  sessionPlanTitle,
  todoStatusToTask,
  type PlanSyncActions,
  type SessionSnapshot,
} from './import-session.js'
import type {
  CreatePhaseInput,
  CreatePlanInput,
  CreateTaskInput,
  Phase,
  PhaseStatus,
  PhaseTree,
  Plan,
  PlanEvent,
  PlanEventData,
  PlanEventKind,
  PlanFilter,
  PlanPriority,
  PlanStatus,
  PlanStatusReport,
  PlanSummary,
  PlanTree,
  SearchHit,
  Task,
  TaskMove,
  TaskStatus,
  UpdatePhasePatch,
  UpdatePlanPatch,
  UpdateTaskPatch,
} from './types.js'
import { clampPosition, isPlanPriority, isPlanStatus, progressOf } from './types.js'

/** Error codes surfaced to the tools and the HTTP API. */
export type PlanErrorCode = 'not_found' | 'invalid' | 'conflict'

/** Error thrown by the engine for expected failures. */
export class PlanError extends Error {
  constructor(
    readonly code: PlanErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PlanError'
  }
}

/** Per-operation context (session attribution for the journal). */
export interface OperationOptions {
  sessionId?: string | null
}

/** Options accepted by {@link PlanEngine}. */
export interface PlanEngineOptions {
  store: PlanStore
  config: PlanStoreConfig
  log?: (message: string) => void
  /** Injectable clock, used by tests. */
  now?: () => Date
}

/** Result of exporting a plan to the workspace. */
export interface ExportResult {
  path: string
  tree: PlanTree
}

/** Normalize a list of tags: trimmed, non-empty, unique. */
function normalizeTags(values: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const value of values ?? []) {
    const trimmed = value.trim()
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/** Normalize a list of links: trimmed, non-empty, unique. */
function normalizeLinks(values: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const value of values ?? []) {
    const trimmed = value.trim()
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/** Trim and validate a required title. */
function requireTitle(value: unknown, what: string): string {
  const title = typeof value === 'string' ? value.trim() : ''
  if (title.length === 0) throw new PlanError('invalid', `A ${what} title is required and must not be empty.`)
  return title
}

/** Coerce an optional string field into trimmed text. */
function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim()
}

/** Coerce an unknown value into a known status or throw. */
function asStatus<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  throw new PlanError('invalid', `Unknown ${what} "${String(value)}"; expected one of: ${allowed.join(', ')}.`)
}

/**
 * Plan operations.
 *
 * The class is stateless apart from the store and the shared (mutable) config,
 * so a settings change is picked up without recreating the engine.
 */
export class PlanEngine {
  /** Row-level store. */
  readonly store: PlanStore
  /** Live configuration shared with the settings namespace. */
  readonly config: PlanStoreConfig
  private readonly log: (message: string) => void
  private readonly clock: () => Date

  constructor(options: PlanEngineOptions) {
    this.store = options.store
    this.config = options.config
    this.log = options.log ?? ((): void => {})
    this.clock = options.now ?? ((): Date => new Date())
  }

  /** Storage root of the database. */
  get root(): string {
    return this.store.root
  }

  /** Absolute path of the database file. */
  get dbPath(): string {
    return this.store.dbPath
  }

  /** True when FTS5 search is active. */
  get ftsEnabled(): boolean {
    return this.store.ftsEnabled
  }

  /** Close the underlying database. */
  close(): void {
    this.store.close()
  }

  /** Current timestamp in ISO-8601. */
  private nowIso(): string {
    return this.clock().toISOString()
  }

  /** Run a function inside a transaction. */
  private transaction<T>(fn: () => T): T {
    const db = this.store.open()
    db.exec('BEGIN')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch (rollbackError) {
        this.log(`rollback failed: ${String(rollbackError)}`)
      }
      throw error
    }
  }

  /* ------------------------------------------------------------------ *
   * plans
   * ------------------------------------------------------------------ */

  /** Create a plan with optional nested phases and tasks. */
  createPlan(input: CreatePlanInput, options: OperationOptions = {}): PlanTree {
    const title = requireTitle(input.title, 'plan')
    const status = input.status === undefined ? 'backlog' : asStatus(input.status, ['backlog', 'active', 'blocked', 'done', 'archived'] as const, 'plan status')
    if (input.priority !== undefined && !isPlanPriority(input.priority)) {
      throw new PlanError('invalid', `Unknown plan priority "${String(input.priority)}".`)
    }
    const priority: PlanPriority = input.priority ?? 'normal'
    const now = this.nowIso()
    const id = genId('p')
    const plan: Plan = {
      id,
      title,
      description: optionalText(input.description) ?? '',
      status,
      priority,
      workspace: optionalText(input.workspace) ?? '',
      workspaceRoot: optionalText(input.workspaceRoot) ?? '',
      tags: normalizeTags(input.tags),
      exportPath: null,
      sessionId: optionalText(options.sessionId) ?? optionalText(input.sessionId) ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: status === 'archived' ? now : null,
    }
    const phases = input.phases ?? []
    const createdPhaseIds: string[] = []
    this.transaction(() => {
      this.store.insertPlan(plan)
      let position = 0
      for (const phaseInput of phases) {
        createdPhaseIds.push(this.insertPhaseInternal(plan.id, phaseInput, position, now))
        position += 1
      }
      this.recordEvent(plan.id, 'created', `Plan created with ${phases.length} phase(s).`, { status }, plan.sessionId, now)
    })
    this.applyPhaseAutoStatusFor(createdPhaseIds, plan.sessionId)
    this.applyAutoStatus(plan.id, plan.sessionId)
    return this.requireTree(plan.id)
  }

  /** Read the full tree of a plan. */
  getPlan(id: string, eventLimit = 20): PlanTree | null {
    const plan = this.store.getPlan(id)
    if (plan === null) return null
    return this.buildTree(plan, eventLimit)
  }

  /** Read the full tree of a plan or throw `not_found`. */
  requireTree(id: string, eventLimit = 20): PlanTree {
    const tree = this.getPlan(id, eventLimit)
    if (tree === null) throw new PlanError('not_found', `Plan not found: ${id}`)
    return tree
  }

  /** List plans with derived progress, newest first. */
  listPlans(filter: PlanFilter = {}): { plans: PlanSummary[]; total: number } {
    const { items, total } = this.store.listPlans(filter)
    const tasksByPlan = this.store.listTasksForPlans(items.map((plan) => plan.id))
    const phaseCounts = this.store.countPhasesForPlans(items.map((plan) => plan.id))
    const plans = items.map((plan) => this.toSummary(plan, tasksByPlan.get(plan.id) ?? [], phaseCounts.get(plan.id) ?? 0))
    return { plans, total }
  }

  /**
   * Board payload: the filtered plans with their full trees, newest first.
   *
   * `eventLimit` defaults to 0 — the board does not need the journal, the plan
   * detail panel asks for it through `getPlan`.
   */
  board(filter: PlanFilter = {}, eventLimit = 0): { plans: PlanTree[]; total: number } {
    const { items, total } = this.store.listPlans(filter)
    const plans: PlanTree[] = []
    for (const plan of items) {
      const tree = this.getPlan(plan.id, eventLimit)
      if (tree !== null) plans.push(tree)
    }
    return { plans, total }
  }

  /**
   * Archive every non-archived plan created in one session.
   *
   * Used when a session is retired: its plans belong to that session, so they
   * leave the active board with it. Plans without a session id are untouched,
   * and the operation stays reversible (`plan_update` with any other status
   * restores a plan).
   *
   * @returns the ids of the plans that were archived by this call.
   */
  archiveSessionPlans(sessionId: string, options: OperationOptions = {}): string[] {
    const id = sessionId.trim()
    if (id.length === 0) return []
    const archived: string[] = []
    for (const planId of this.store.listPlanIdsBySession(id)) {
      const plan = this.store.getPlan(planId)
      if (plan === null || plan.status === 'archived') continue
      this.archivePlan(planId, { sessionId: id, ...options })
      archived.push(planId)
    }
    return archived
  }

  /**
   * Archive the plans of every session the host has archived.
   *
   * Cheap by construction: one query lists the sessions that still own active
   * plans, and only those that appear in the archive set are touched. Called
   * whenever the board or the session state is read, so archiving a session in
   * the sidebar moves its plans out of the board without any timer.
   *
   * @param archivedSessionIds - the host's archive set.
   * @returns the ids of the plans archived by this call.
   */
  syncArchivedSessions(archivedSessionIds: readonly string[]): string[] {
    if (archivedSessionIds.length === 0) return []
    const archived = new Set(archivedSessionIds)
    const affected: string[] = []
    for (const sessionId of this.store.listActivePlanSessionIds()) {
      if (!archived.has(sessionId)) continue
      affected.push(...this.archiveSessionPlans(sessionId))
    }
    return affected
  }

  /** Newest plan imported from a session, if any. */
  findImportedPlan(sessionId: string): Plan | null {
    return this.store.findPlanBySession(sessionId)
  }

  /**
   * Create or refresh the plan imported from a session snapshot.
   *
   * The goal becomes the plan title and description; the todo list becomes the
   * tasks of one `Todos` phase. Re-running with `refresh` reconciles the plan
   * with the current list instead of creating a duplicate, so the plan stays a
   * mirror of the session without ever forking it.
   */
  importSession(
    snapshot: SessionSnapshot,
    workspace: { key: string; root: string },
    refresh = true,
  ): { tree: PlanTree; created: boolean; actions: PlanSyncActions | null } {
    const existing = this.findImportedPlan(snapshot.sessionId)
    if (existing === null) {
      const tree = this.createPlan(mapSessionToPlan(snapshot, workspace), { sessionId: snapshot.sessionId })
      return { tree, created: true, actions: null }
    }
    if (!refresh) return { tree: this.requireTree(existing.id), created: false, actions: null }

    const sessionId = snapshot.sessionId
    let tree = this.updatePlan(
      existing.id,
      { title: sessionPlanTitle(snapshot), description: sessionDescription(snapshot) },
      { sessionId },
    )
    const phase = importedPhase(tree)
    const actions = planSyncActions(tree, snapshot.todos)
    for (const change of actions.update) {
      tree = this.updateTask(change.taskId, { status: change.status }, { sessionId })
    }
    for (const todo of actions.add) {
      tree = this.addTask(
        existing.id,
        {
          title: todo.content,
          status: todoStatusToTask(todo.status),
          ...(phase !== null ? { phaseId: phase.id } : {}),
        },
        { sessionId },
      )
    }
    for (const taskId of actions.remove) {
      tree = this.deleteTask(taskId, { sessionId })
    }
    return { tree, created: false, actions }
  }

  /** Distinct workspace keys known to the store. */
  workspaces(): string[] {
    return this.store.listWorkspaces()
  }

  /** Full-text search over plans and tasks. */
  searchPlans(query: string, workspace?: string, limit = 20): SearchHit[] {
    return this.store.search(query, workspace, limit)
  }

  /** Update plan metadata; a status change is journaled separately. */
  updatePlan(id: string, patch: UpdatePlanPatch, options: OperationOptions = {}): PlanTree {
    const plan = this.requirePlan(id)
    const values: Record<string, SqlValue> = { updated_at: this.nowIso() }
    let statusChanged: PlanStatus | null = null
    if (patch.title !== undefined) values['title'] = requireTitle(patch.title, 'plan')
    if (patch.description !== undefined) values['description'] = optionalText(patch.description) ?? ''
    if (patch.priority !== undefined) {
      if (!isPlanPriority(patch.priority)) throw new PlanError('invalid', `Unknown plan priority "${String(patch.priority)}".`)
      values['priority'] = patch.priority
    }
    if (patch.tags !== undefined) values['tags'] = JSON.stringify(normalizeTags(patch.tags))
    if (patch.workspace !== undefined) values['workspace'] = optionalText(patch.workspace) ?? ''
    if (patch.workspaceRoot !== undefined) values['workspace_root'] = optionalText(patch.workspaceRoot) ?? ''
    if (patch.status !== undefined) {
      if (!isPlanStatus(patch.status)) throw new PlanError('invalid', `Unknown plan status "${String(patch.status)}".`)
      values['status'] = patch.status
      values['archived_at'] = patch.status === 'archived' ? (plan.archivedAt ?? this.nowIso()) : null
      if (patch.status !== plan.status) statusChanged = patch.status
    }
    const sessionId = options.sessionId ?? plan.sessionId
    this.transaction(() => {
      this.store.updatePlanRow(id, values)
      if (statusChanged !== null) {
        this.recordEvent(
          id,
          statusChanged === 'archived' ? 'archived' : 'status',
          `Status changed from ${plan.status} to ${statusChanged}.`,
          { from: plan.status, to: statusChanged },
          sessionId,
        )
      } else {
        this.recordEvent(id, 'updated', 'Plan details updated.', {}, sessionId)
      }
    })
    return this.requireTree(id)
  }

  /** Archive a plan (soft delete). */
  archivePlan(id: string, options: OperationOptions = {}): PlanTree {
    const plan = this.requirePlan(id)
    if (plan.status === 'archived') return this.requireTree(id)
    return this.updatePlan(id, { status: 'archived' }, options)
  }

  /** Restore an archived plan into the backlog. */
  restorePlan(id: string, options: OperationOptions = {}): PlanTree {
    const plan = this.requirePlan(id)
    if (plan.status !== 'archived') return this.requireTree(id)
    return this.updatePlan(id, { status: 'backlog' }, options)
  }

  /**
   * Permanently delete a plan and everything under it.
   *
   * The journal of a purged plan is removed with it (the rows cascade), so no
   * `purged` entry can survive; the reserved event kind exists for symmetry.
   */
  purgePlan(id: string, confirm: boolean): boolean {
    this.requirePlan(id)
    if (confirm !== true) {
      throw new PlanError('invalid', 'Purging a plan is irreversible; pass confirm=true to proceed.')
    }
    return this.store.deletePlanRow(id)
  }

  /* ------------------------------------------------------------------ *
   * phases
   * ------------------------------------------------------------------ */

  /** Add a phase (and optional tasks) to a plan. */
  addPhase(planId: string, input: CreatePhaseInput, options: OperationOptions = {}): PlanTree {
    const plan = this.requirePlan(planId)
    const now = this.nowIso()
    const position = input.position === undefined ? this.store.nextPhasePosition(planId) : clampPosition(input.position)
    let createdPhaseId = ''
    this.transaction(() => {
      if (input.position !== undefined) this.store.shiftPhases(planId, position)
      createdPhaseId = this.insertPhaseInternal(planId, input, position, now)
      this.recordEvent(planId, 'phase', `Phase added: ${this.store.getPhase(createdPhaseId)?.title ?? ''}`.trim(), {}, options.sessionId ?? plan.sessionId, now)
    })
    this.applyPhaseAutoStatusFor([createdPhaseId], options.sessionId ?? plan.sessionId)
    return this.requireTree(planId)
  }

  /** Update a phase; a position change opens a slot for it. */
  updatePhase(phaseId: string, patch: UpdatePhasePatch, options: OperationOptions = {}): PlanTree {
    const phase = this.requirePhase(phaseId)
    const plan = this.requirePlan(phase.planId)
    const values: Record<string, SqlValue> = { updated_at: this.nowIso() }
    if (patch.title !== undefined) values['title'] = requireTitle(patch.title, 'phase')
    if (patch.status !== undefined) values['status'] = asStatus<PhaseStatus>(patch.status, ['todo', 'doing', 'blocked', 'done'] as const, 'phase status')
    if (patch.notes !== undefined) values['notes'] = optionalText(patch.notes) ?? ''
    let shifted = false
    if (patch.position !== undefined) {
      const position = clampPosition(patch.position)
      if (position !== phase.position) {
        values['position'] = position
        shifted = true
      }
    }
    this.transaction(() => {
      if (shifted && patch.position !== undefined) this.store.shiftPhases(phase.planId, clampPosition(patch.position))
      this.store.updatePhaseRow(phaseId, values)
      this.recordEvent(phase.planId, 'phase', `Phase updated: ${String(values['title'] ?? phase.title)}`, {}, options.sessionId ?? plan.sessionId)
    })
    return this.requireTree(phase.planId)
  }

  /** Delete a phase together with its tasks. */
  deletePhase(phaseId: string, options: OperationOptions = {}): PlanTree {
    const phase = this.requirePhase(phaseId)
    const plan = this.requirePlan(phase.planId)
    this.transaction(() => {
      this.recordEvent(phase.planId, 'phase', `Phase deleted: ${phase.title}`, {}, options.sessionId ?? plan.sessionId)
      this.store.deletePhaseRow(phaseId)
    })
    this.applyAutoStatus(phase.planId, options.sessionId ?? plan.sessionId)
    return this.requireTree(phase.planId)
  }

  /* ------------------------------------------------------------------ *
   * tasks
   * ------------------------------------------------------------------ */

  /** Add a task; without a phase it lands in the plan's default phase. */
  addTask(planId: string, input: CreateTaskInput & { phaseId?: string }, options: OperationOptions = {}): PlanTree {
    const plan = this.requirePlan(planId)
    const now = this.nowIso()
    let usedPhaseId = ''
    this.transaction(() => {
      const phaseId = input.phaseId ?? this.ensureDefaultPhase(planId, now)
      usedPhaseId = phaseId
      const phase = this.store.getPhase(phaseId)
      if (phase === null || phase.planId !== planId) {
        throw new PlanError('invalid', `Phase ${phaseId} does not belong to plan ${planId}.`)
      }
      const status: TaskStatus = input.status === undefined ? 'todo' : asStatus<TaskStatus>(input.status, ['todo', 'doing', 'blocked', 'done'] as const, 'task status')
      this.insertTaskInternal(planId, phaseId, input, status, input.position, now)
      this.recordEvent(planId, 'task', `Task added: ${input.title.trim()}`, { phaseId }, options.sessionId ?? plan.sessionId, now)
    })
    this.applyPhaseAutoStatusFor([usedPhaseId], options.sessionId ?? plan.sessionId)
    this.applyAutoStatus(planId, options.sessionId ?? plan.sessionId)
    return this.requireTree(planId)
  }

  /** Update a task; `done` stamps `completed_at`, leaving `done` clears it. */
  updateTask(taskId: string, patch: UpdateTaskPatch, options: OperationOptions = {}): PlanTree {
    const task = this.requireTask(taskId)
    const plan = this.requirePlan(task.planId)
    const now = this.nowIso()
    const values: Record<string, SqlValue> = { updated_at: now }
    if (patch.title !== undefined) values['title'] = requireTitle(patch.title, 'task')
    if (patch.notes !== undefined) values['notes'] = optionalText(patch.notes) ?? ''
    if (patch.links !== undefined) values['links'] = JSON.stringify(normalizeLinks(patch.links))
    if (patch.phaseId !== undefined) {
      const phase = this.requirePhase(patch.phaseId)
      if (phase.planId !== task.planId) throw new PlanError('invalid', `Phase ${phase.id} does not belong to plan ${task.planId}.`)
      values['phase_id'] = phase.id
    }
    let nextStatus: TaskStatus | null = null
    if (patch.status !== undefined) {
      nextStatus = asStatus<TaskStatus>(patch.status, ['todo', 'doing', 'blocked', 'done'] as const, 'task status')
      values['status'] = nextStatus
      values['completed_at'] = nextStatus === 'done' ? (task.completedAt ?? now) : null
    }
    if (patch.position !== undefined) values['position'] = clampPosition(patch.position)
    this.transaction(() => {
      this.store.updateTaskRow(taskId, values)
      this.recordEvent(
        task.planId,
        'task',
        nextStatus !== null
          ? `Task ${nextStatus}: ${String(values['title'] ?? task.title)}`
          : `Task updated: ${String(values['title'] ?? task.title)}`,
        nextStatus !== null ? { from: task.status, to: nextStatus } : {},
        options.sessionId ?? plan.sessionId,
        now,
      )
    })
    this.applyPhaseAutoStatusFor([task.phaseId, patch.phaseId], options.sessionId ?? plan.sessionId)
    this.applyAutoStatus(task.planId, options.sessionId ?? plan.sessionId)
    return this.requireTree(task.planId)
  }

  /** Delete a task. */
  deleteTask(taskId: string, options: OperationOptions = {}): PlanTree {
    const task = this.requireTask(taskId)
    const plan = this.requirePlan(task.planId)
    this.transaction(() => {
      this.recordEvent(task.planId, 'task', `Task deleted: ${task.title}`, {}, options.sessionId ?? plan.sessionId)
      this.store.deleteTaskRow(taskId)
    })
    this.applyPhaseAutoStatusFor([task.phaseId], options.sessionId ?? plan.sessionId)
    this.applyAutoStatus(task.planId, options.sessionId ?? plan.sessionId)
    return this.requireTree(task.planId)
  }

  /** Move a task between cells of the board (status, phase and order). */
  moveTask(taskId: string, move: TaskMove, options: OperationOptions = {}): PlanTree {
    const task = this.requireTask(taskId)
    const plan = this.requirePlan(task.planId)
    const phaseId = move.phaseId ?? task.phaseId
    const phase = this.requirePhase(phaseId)
    if (phase.planId !== task.planId) throw new PlanError('invalid', `Phase ${phase.id} does not belong to plan ${task.planId}.`)
    const status = move.status === undefined ? task.status : asStatus<TaskStatus>(move.status, ['todo', 'doing', 'blocked', 'done'] as const, 'task status')
    const now = this.nowIso()
    this.transaction(() => {
      let position: number
      if (move.position === undefined) {
        position = this.store.nextTaskPosition(phaseId, status)
      } else {
        position = clampPosition(move.position)
        this.store.shiftTasks(phaseId, status, position)
      }
      this.store.updateTaskRow(taskId, {
        phase_id: phaseId,
        status,
        position,
        completed_at: status === 'done' ? (task.completedAt ?? now) : null,
        updated_at: now,
      })
      this.recordEvent(
        task.planId,
        'task',
        `Task moved to ${status}: ${task.title}`,
        { from: task.status, to: status, phaseId },
        options.sessionId ?? plan.sessionId,
        now,
      )
    })
    this.applyPhaseAutoStatusFor([task.phaseId, phaseId], options.sessionId ?? plan.sessionId)
    this.applyAutoStatus(task.planId, options.sessionId ?? plan.sessionId)
    return this.requireTree(task.planId)
  }

  /* ------------------------------------------------------------------ *
   * journal, export, reporting
   * ------------------------------------------------------------------ */

  /** Journal tail of a plan. */
  events(planId: string, limit = 20): PlanEvent[] {
    return this.store.listEvents(planId, limit)
  }

  /** Export one plan as markdown into the workspace. */
  exportPlan(id: string, options: OperationOptions & { workspaceRoot?: string; exportDir?: string } = {}): ExportResult {
    const tree = this.requireTree(id)
    const workspaceRoot = (options.workspaceRoot ?? tree.workspaceRoot).trim()
    if (workspaceRoot.length === 0) {
      throw new PlanError('invalid', 'The plan has no workspace root; pass workspaceRoot to export it.')
    }
    const exportDir = (options.exportDir ?? this.config.exportDir ?? DEFAULT_EXPORT_DIR).trim()
    const exportedAt = this.nowIso()
    const result = exportPlanToWorkspace(tree, { workspaceRoot, exportDir, exportedAt })
    this.transaction(() => {
      this.store.updatePlanRow(id, { export_path: result.path, updated_at: exportedAt })
      this.recordEvent(id, 'export', `Exported to ${result.path}`, { path: result.path }, options.sessionId ?? tree.sessionId, exportedAt)
    })
    return { path: result.path, tree: this.requireTree(id) }
  }

  /** Store-wide counters plus the stale plans of a workspace. */
  statusReport(workspace?: string): PlanStatusReport {
    const byStatus = this.store.countPlansByStatus(workspace)
    const byTaskStatus = this.store.countTasksByStatus()
    const rows = this.store.countRows()
    const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0)
    const cutoff = this.clock().getTime() - this.config.stalePlanDays * 24 * 60 * 60 * 1000
    const { plans } = this.listPlans({ status: 'all', includeArchived: false, limit: 500, ...(workspace !== undefined ? { workspace } : {}) })
    const stale = plans.filter((plan) => new Date(plan.updatedAt).getTime() < cutoff)
    return {
      root: this.root,
      dbPath: this.dbPath,
      exportDir: this.config.exportDir,
      total,
      archived: byStatus.archived,
      byStatus,
      byTaskStatus,
      phaseCount: rows.phases,
      taskCount: rows.tasks,
      stale,
      fts: this.store.ftsEnabled,
    }
  }

  /** Compact one-line summaries of the plans worth putting into the prompt. */
  promptSummary(workspace: string | undefined, limit: number): string[] {
    if (limit <= 0) return []
    const { plans } = this.listPlans({ status: 'all', includeArchived: false, limit: 100, ...(workspace !== undefined && workspace.length > 0 ? { workspace } : {}) })
    return plans
      .filter((plan) => plan.status === 'active' || plan.status === 'blocked')
      .slice(0, limit)
      .map((plan) => {
        const next = plan.nextTask === null ? 'no open task' : `next: ${plan.nextTask.title}`
        const scope = plan.workspace.length > 0 ? ` (${plan.workspace})` : ''
        return `${plan.id} · [${plan.status}] ${plan.title}${scope} — ${plan.progress.done}/${plan.progress.total} tasks, ${next}`
      })
  }

  /* ------------------------------------------------------------------ *
   * internals
   * ------------------------------------------------------------------ */

  /** Read a plan or throw `not_found`. */
  private requirePlan(id: string): Plan {
    const plan = this.store.getPlan(id)
    if (plan === null) throw new PlanError('not_found', `Plan not found: ${id}`)
    return plan
  }

  /** Read a phase or throw `not_found`. */
  private requirePhase(id: string): Phase {
    const phase = this.store.getPhase(id)
    if (phase === null) throw new PlanError('not_found', `Phase not found: ${id}`)
    return phase
  }

  /** Read a task or throw `not_found`. */
  private requireTask(id: string): Task {
    const task = this.store.getTask(id)
    if (task === null) throw new PlanError('not_found', `Task not found: ${id}`)
    return task
  }

  /** Build the full tree of a known plan. */
  private buildTree(plan: Plan, eventLimit: number): PlanTree {
    const phases = this.store.listPhases(plan.id)
    const tasks = this.store.listTasks(plan.id)
    const byPhase = new Map<string, Task[]>()
    for (const task of tasks) {
      const bucket = byPhase.get(task.phaseId)
      if (bucket === undefined) byPhase.set(task.phaseId, [task])
      else bucket.push(task)
    }
    const phaseTrees: PhaseTree[] = phases.map((phase) => {
      const phaseTasks = byPhase.get(phase.id) ?? []
      return { ...phase, tasks: phaseTasks, progress: progressOf(phaseTasks) }
    })
    return { ...plan, phases: phaseTrees, progress: progressOf(tasks), events: this.store.listEvents(plan.id, eventLimit) }
  }

  /** Project a plan row plus its tasks onto a list row. */
  private toSummary(plan: Plan, tasks: Task[], phaseCount: number): PlanSummary {
    const nextTask = tasks.find((task) => task.status === 'doing') ?? tasks.find((task) => task.status === 'todo') ?? null
    return {
      ...plan,
      phaseCount,
      taskCount: tasks.length,
      progress: progressOf(tasks),
      nextTask,
    }
  }

  /** Insert a phase and its nested tasks; returns the phase id. */
  private insertPhaseInternal(planId: string, input: CreatePhaseInput, position: number, now: string): string {
    const id = genId('ph')
    const status: PhaseStatus = input.status === undefined ? 'todo' : asStatus<PhaseStatus>(input.status, ['todo', 'doing', 'blocked', 'done'] as const, 'phase status')
    this.store.insertPhase({
      id,
      planId,
      title: requireTitle(input.title, 'phase'),
      status,
      notes: optionalText(input.notes) ?? '',
      position: input.position === undefined ? position : clampPosition(input.position),
      createdAt: now,
      updatedAt: now,
    })
    let taskPosition = 0
    for (const taskInput of input.tasks ?? []) {
      const normalized: CreateTaskInput = typeof taskInput === 'string' ? { title: taskInput } : taskInput
      const taskStatus: TaskStatus = normalized.status === undefined ? 'todo' : asStatus<TaskStatus>(normalized.status, ['todo', 'doing', 'blocked', 'done'] as const, 'task status')
      this.insertTaskInternal(planId, id, normalized, taskStatus, normalized.position ?? taskPosition, now)
      taskPosition += 1
    }
    return id
  }

  /** Insert one task row. */
  private insertTaskInternal(
    planId: string,
    phaseId: string,
    input: CreateTaskInput,
    status: TaskStatus,
    position: number | undefined,
    now: string,
  ): string {
    const id = genId('t')
    this.store.insertTask({
      id,
      planId,
      phaseId,
      title: requireTitle(input.title, 'task'),
      status,
      notes: optionalText(input.notes) ?? '',
      links: normalizeLinks(input.links),
      position: position === undefined ? this.store.nextTaskPosition(phaseId, status) : clampPosition(position),
      createdAt: now,
      updatedAt: now,
      completedAt: status === 'done' ? now : null,
    })
    return id
  }

  /** Find or create the plan's default phase used by tasks without a phase. */
  private ensureDefaultPhase(planId: string, now: string): string {
    const phases = this.store.listPhases(planId)
    const existing = phases[0]
    if (existing !== undefined) return existing.id
    return this.insertPhaseInternal(planId, { title: 'Tasks' }, 0, now)
  }

  /** Append a journal entry. */
  private recordEvent(
    planId: string,
    kind: PlanEventKind,
    message: string,
    data: PlanEventData,
    sessionId: string | null,
    createdAt?: string,
  ): void {
    this.store.insertEvent({
      id: genId('e'),
      planId,
      kind,
      message,
      data,
      sessionId,
      createdAt: createdAt ?? this.nowIso(),
    })
  }

  /**
   * Follow the tasks with the phase status.
   *
   * Symmetric to {@link applyAutoStatus}: any task in `doing` moves a `todo`
   * phase to `doing`, all tasks `done` finishes the phase, and a finished phase
   * is reopened when a task comes back. A phase set to `blocked` by hand is
   * never overwritten.
   */
  private applyPhaseAutoStatus(phaseId: string, sessionId: string | null): void {
    const phase = this.store.getPhase(phaseId)
    if (phase === null || phase.status === 'blocked') return
    const tasks = this.store.listTasks(phase.planId).filter((task) => task.phaseId === phaseId)
    if (tasks.length === 0) return
    const done = tasks.filter((task) => task.status === 'done').length
    const doing = tasks.some((task) => task.status === 'doing')
    let next: PhaseStatus | null = null
    if (done === tasks.length) next = 'done'
    else if (phase.status === 'done') next = doing ? 'doing' : 'todo'
    else if (doing && phase.status === 'todo') next = 'doing'
    if (next === null || next === phase.status) return
    const now = this.nowIso()
    this.transaction(() => {
      this.store.updatePhaseRow(phaseId, { status: next, updated_at: now })
      this.recordEvent(
        phase.planId,
        'phase',
        `Phase status changed from ${phase.status} to ${next} (automatic).`,
        { from: phase.status, to: next, automatic: true },
        sessionId,
        now,
      )
    })
  }

  /** Recompute the status of several phases, skipping blanks and duplicates. */
  private applyPhaseAutoStatusFor(phaseIds: readonly (string | undefined)[], sessionId: string | null): void {
    const seen = new Set<string>()
    for (const phaseId of phaseIds) {
      if (phaseId === undefined || phaseId.length === 0 || seen.has(phaseId)) continue
      seen.add(phaseId)
      this.applyPhaseAutoStatus(phaseId, sessionId)
    }
  }

  /**
   * Follow the tasks with the plan status.
   *
   * Manual `blocked` and `archived` states are never overwritten; `done` is
   * entered only when every task is finished and left again as soon as one is
   * reopened.
   */
  private applyAutoStatus(planId: string, sessionId: string | null): void {
    const plan = this.store.getPlan(planId)
    if (plan === null || plan.status === 'archived' || plan.status === 'blocked') return
    const tasks = this.store.listTasks(planId)
    if (tasks.length === 0) return
    const done = tasks.filter((task) => task.status === 'done').length
    const doing = tasks.some((task) => task.status === 'doing')
    let next: PlanStatus | null = null
    if (done === tasks.length) next = 'done'
    else if (plan.status === 'done') next = 'active'
    else if (doing && plan.status === 'backlog') next = 'active'
    if (next === null || next === plan.status) return
    const now = this.nowIso()
    this.transaction(() => {
      this.store.updatePlanRow(planId, { status: next, updated_at: now })
      this.recordEvent(
        planId,
        'status',
        `Status changed from ${plan.status} to ${next} (automatic).`,
        { from: plan.status, to: next, automatic: true },
        sessionId,
        now,
      )
    })
  }
}
