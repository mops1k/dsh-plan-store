/**
 * SQLite persistence for the plan store.
 *
 * The database is the single source of truth for plans, phases, tasks and the
 * append-only `plan_events` journal. It is built on `node:sqlite`
 * (`DatabaseSync`), so no native dependency is required, and it uses WAL with a
 * busy timeout. Full-text search uses FTS5 with external-content tables kept in
 * sync by triggers; when the Node build lacks FTS5 the store degrades to `LIKE`
 * and reports `ftsEnabled === false`.
 *
 * This module only moves rows: validation, invariants and status automation
 * live in `engine.ts`.
 *
 * @module dsh-plan-store/core/store
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { plansDbPath, resolveStorageRoot } from './paths.js'
import type {
  Phase,
  Plan,
  PlanEvent,
  PlanEventData,
  PlanFilter,
  PlanStatus,
  SearchHit,
  Task,
  TaskStatus,
} from './types.js'
import { PLAN_STATUSES } from './types.js'

/** Values accepted by prepared statement parameters in this module. */
export type SqlValue = string | number | null

/** Column whitelists per table, used to build safe partial updates. */
const PLAN_COLUMNS = new Set([
  'title',
  'description',
  'status',
  'priority',
  'workspace',
  'workspace_root',
  'tags',
  'export_path',
  'session_id',
  'created_at',
  'updated_at',
  'archived_at',
])

const PHASE_COLUMNS = new Set([
  'title',
  'status',
  'notes',
  'position',
  'updated_at',
])

const TASK_COLUMNS = new Set([
  'title',
  'status',
  'notes',
  'links',
  'phase_id',
  'position',
  'updated_at',
  'completed_at',
])

/** Schema of version 1 (tables and indexes; FTS objects are created separately). */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'normal',
  workspace TEXT NOT NULL DEFAULT '',
  workspace_root TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  export_path TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS phases (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  notes TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  notes TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS plan_events (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phases_plan ON phases(plan_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id, phase_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_events_plan ON plan_events(plan_id, created_at);
`

/** FTS5 objects of version 1, created inside a try/catch for portability. */
const FTS_V1 = `
CREATE VIRTUAL TABLE IF NOT EXISTS plans_fts USING fts5(
  title,
  description,
  content='plans',
  content_rowid='rowid'
);
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  title,
  notes,
  content='tasks',
  content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS plans_fts_ai AFTER INSERT ON plans BEGIN
  INSERT INTO plans_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
END;
CREATE TRIGGER IF NOT EXISTS plans_fts_ad AFTER DELETE ON plans BEGIN
  INSERT INTO plans_fts(plans_fts, rowid, title, description) VALUES ('delete', old.rowid, old.title, old.description);
END;
CREATE TRIGGER IF NOT EXISTS plans_fts_au AFTER UPDATE ON plans BEGIN
  INSERT INTO plans_fts(plans_fts, rowid, title, description) VALUES ('delete', old.rowid, old.title, old.description);
  INSERT INTO plans_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
END;
CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, notes) VALUES (new.rowid, new.title, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, notes) VALUES ('delete', old.rowid, old.title, old.notes);
END;
CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, notes) VALUES ('delete', old.rowid, old.title, old.notes);
  INSERT INTO tasks_fts(rowid, title, notes) VALUES (new.rowid, new.title, new.notes);
END;
`

/** Options accepted by {@link PlanStore}. */
export interface PlanStoreOptions {
  /** Storage root override; empty means `$DSH_HOME/plan-store`. */
  root?: string | null
  /** Explicit database path (tests use it for isolated files). */
  dbPath?: string
  /** Sink for non-fatal diagnostics. */
  log?: (message: string) => void
}

/** Coerce a database value into a string. */
function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return fallback
  return String(value)
}

/** Coerce a database value into a nullable string. */
function nullableText(value: unknown): string | null {
  const value2 = text(value, '')
  return value2.length > 0 ? value2 : null
}

/** Coerce a database value into a finite number. */
function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Parse a JSON string array, tolerating corrupt values. */
export function parseStringArray(value: unknown): string[] {
  const raw = text(value, '')
  if (raw.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/** Parse a JSON object, tolerating corrupt values. */
export function parseJsonObject(value: unknown): Record<string, unknown> {
  const raw = text(value, '')
  if (raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Map a `plans` row onto a {@link Plan}. */
function toPlan(row: Record<string, unknown>): Plan {
  return {
    id: text(row['id']),
    title: text(row['title']),
    description: text(row['description']),
    status: text(row['status'], 'backlog') as PlanStatus,
    priority: text(row['priority'], 'normal') as Plan['priority'],
    workspace: text(row['workspace']),
    workspaceRoot: text(row['workspace_root']),
    tags: parseStringArray(row['tags']),
    exportPath: nullableText(row['export_path']),
    sessionId: nullableText(row['session_id']),
    createdAt: text(row['created_at']),
    updatedAt: text(row['updated_at']),
    archivedAt: nullableText(row['archived_at']),
  }
}

/** Map a `phases` row onto a {@link Phase}. */
function toPhase(row: Record<string, unknown>): Phase {
  return {
    id: text(row['id']),
    planId: text(row['plan_id']),
    title: text(row['title']),
    status: text(row['status'], 'todo') as Phase['status'],
    notes: text(row['notes']),
    position: num(row['position']),
    createdAt: text(row['created_at']),
    updatedAt: text(row['updated_at']),
  }
}

/** Map a `tasks` row onto a {@link Task}. */
function toTask(row: Record<string, unknown>): Task {
  return {
    id: text(row['id']),
    planId: text(row['plan_id']),
    phaseId: text(row['phase_id']),
    title: text(row['title']),
    status: text(row['status'], 'todo') as TaskStatus,
    notes: text(row['notes']),
    links: parseStringArray(row['links']),
    position: num(row['position']),
    createdAt: text(row['created_at']),
    updatedAt: text(row['updated_at']),
    completedAt: nullableText(row['completed_at']),
  }
}

/** Map a `plan_events` row onto a {@link PlanEvent}. */
function toEvent(row: Record<string, unknown>): PlanEvent {
  return {
    id: text(row['id']),
    planId: text(row['plan_id']),
    kind: text(row['kind'], 'status') as PlanEvent['kind'],
    message: text(row['message']),
    data: parseJsonObject(row['data']) as PlanEventData,
    sessionId: nullableText(row['session_id']),
    createdAt: text(row['created_at']),
  }
}

/** Build a `?,?,?` placeholder list for an IN clause. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

/** Turn free text into a safe FTS5 MATCH expression (all terms are required). */
export function toFtsQuery(raw: string): string {
  const terms = raw
    .split(/[^\p{L}\p{N}_]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
  if (terms.length === 0) return ''
  return terms.map((term) => `"${term.replace(/"/gu, '""')}"`).join(' ')
}

/** Shorten text for a fallback snippet. */
function excerpt(value: string, limit = 160): string {
  const single = value.replace(/\s+/gu, ' ').trim()
  return single.length <= limit ? single : `${single.slice(0, limit)}…`
}

/**
 * Row-level access to the plans database.
 *
 * The connection opens lazily on first use so constructing the store never
 * touches the filesystem; `close()` releases it (the plugin registers it as a
 * Cordis effect).
 */
export class PlanStore {
  /** Resolved storage root. */
  readonly root: string
  /** Absolute path of the SQLite file. */
  readonly dbPath: string
  private readonly log: (message: string) => void
  private db: DatabaseSync | null = null
  private fts = false

  constructor(options: PlanStoreOptions = {}) {
    this.root = resolveStorageRoot(options.root ?? null)
    this.dbPath = options.dbPath ?? plansDbPath(options.root ?? null)
    this.log = options.log ?? ((): void => {})
  }

  /** True when the FTS5 index is available and in use. */
  get ftsEnabled(): boolean {
    return this.fts
  }

  /** Open the connection, creating the schema on first use. */
  open(): DatabaseSync {
    if (this.db !== null) return this.db
    mkdirSync(dirname(this.dbPath), { recursive: true })
    const db = new DatabaseSync(this.dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    this.migrate(db)
    this.db = db
    return db
  }

  /** Close the connection; safe to call repeatedly. */
  close(): void {
    if (this.db === null) return
    try {
      this.db.close()
    } catch (error) {
      this.log(`closing the plans database failed: ${String(error)}`)
    }
    this.db = null
  }

  /** Run schema migrations up to the current version. */
  private migrate(db: DatabaseSync): void {
    const current = num(db.prepare('PRAGMA user_version').get()?.['user_version'], 0)
    if (current < 1) {
      db.exec(SCHEMA_V1)
      db.exec('PRAGMA user_version = 1')
    }
    this.fts = this.ensureFts(db)
  }

  /** Create the FTS5 index and keep it in sync; false when FTS5 is unavailable. */
  private ensureFts(db: DatabaseSync): boolean {
    try {
      db.exec(FTS_V1)
    } catch (error) {
      this.log(`FTS5 is unavailable, falling back to LIKE search: ${String(error)}`)
      return false
    }
    try {
      const plans = num(db.prepare('SELECT COUNT(*) AS n FROM plans').get()?.['n'], 0)
      const indexed = num(db.prepare('SELECT COUNT(*) AS n FROM plans_fts').get()?.['n'], 0)
      const tasks = num(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.['n'], 0)
      const indexedTasks = num(db.prepare('SELECT COUNT(*) AS n FROM tasks_fts').get()?.['n'], 0)
      if (plans !== indexed) db.exec("INSERT INTO plans_fts(plans_fts) VALUES ('rebuild')")
      if (tasks !== indexedTasks) db.exec("INSERT INTO tasks_fts(tasks_fts) VALUES ('rebuild')")
    } catch (error) {
      this.log(`the FTS5 index could not be verified: ${String(error)}`)
    }
    return true
  }

  /** Open the database on demand. */
  private requireDb(): DatabaseSync {
    return this.open()
  }

  /* ------------------------------------------------------------------ *
   * plans
   * ------------------------------------------------------------------ */

  /** Insert a plan row. */
  insertPlan(plan: Plan): void {
    const db = this.requireDb()
    db.prepare(
      `INSERT INTO plans (id, title, description, status, priority, workspace, workspace_root, tags, export_path, session_id, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      plan.id,
      plan.title,
      plan.description,
      plan.status,
      plan.priority,
      plan.workspace,
      plan.workspaceRoot,
      JSON.stringify(plan.tags),
      plan.exportPath,
      plan.sessionId,
      plan.createdAt,
      plan.updatedAt,
      plan.archivedAt,
    )
  }

  /** Apply a partial update to a plan; returns false when the row is gone. */
  updatePlanRow(id: string, values: Record<string, SqlValue>): boolean {
    return this.updateRow('plans', PLAN_COLUMNS, id, values)
  }

  /** Read one plan. */
  getPlan(id: string): Plan | null {
    const row = this.requireDb().prepare('SELECT * FROM plans WHERE id = ?').get(id)
    return row === undefined ? null : toPlan(row as Record<string, unknown>)
  }

  /** List plans matching a filter, newest first. */
  listPlans(filter: PlanFilter = {}): { items: Plan[]; total: number } {
    const db = this.requireDb()
    const clauses: string[] = []
    const params: SqlValue[] = []
    const status = filter.status ?? 'all'
    if (status !== 'all') {
      clauses.push('status = ?')
      params.push(status)
    } else if (filter.includeArchived !== true) {
      clauses.push("status <> 'archived'")
    }
    if (typeof filter.workspace === 'string' && filter.workspace.length > 0) {
      clauses.push('workspace = ?')
      params.push(filter.workspace)
    }
    const query = (filter.query ?? '').trim()
    if (query.length > 0) {
      clauses.push('(title LIKE ? OR description LIKE ?)')
      params.push(`%${query}%`, `%${query}%`)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const total = num(db.prepare(`SELECT COUNT(*) AS n FROM plans ${where}`).get(...params)?.['n'], 0)
    const limit = Math.max(0, Math.trunc(filter.limit ?? 100))
    const offset = Math.max(0, Math.trunc(filter.offset ?? 0))
    const rows = db
      .prepare(`SELECT * FROM plans ${where} ORDER BY updated_at DESC, created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
    return { items: rows.map((row) => toPlan(row as Record<string, unknown>)), total }
  }

  /** Count non-archived and archived plans per status. */
  countPlansByStatus(workspace?: string): Record<PlanStatus, number> {
    const db = this.requireDb()
    const scoped = typeof workspace === 'string' && workspace.length > 0
    const rows = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM plans ${scoped ? 'WHERE workspace = ?' : ''} GROUP BY status`,
      )
      .all(...(scoped ? [workspace as SqlValue] : []))
    const counts = Object.fromEntries(PLAN_STATUSES.map((status) => [status, 0])) as Record<PlanStatus, number>
    for (const row of rows) {
      const record = row as Record<string, unknown>
      const status = text(record['status']) as PlanStatus
      if (status in counts) counts[status] = num(record['n'])
    }
    return counts
  }

  /** Session ids that still own at least one non-archived plan. */
  listActivePlanSessionIds(): string[] {
    const rows = this.requireDb()
      .prepare("SELECT DISTINCT session_id FROM plans WHERE status <> 'archived' AND session_id IS NOT NULL")
      .all()
    return rows
      .map((row) => text((row as Record<string, unknown>)['session_id']))
      .filter((id) => id.length > 0)
  }

  /** Ids of the plans created in one session, newest first. */
  listPlanIdsBySession(sessionId: string): string[] {
    const rows = this.requireDb()
      .prepare('SELECT id FROM plans WHERE session_id = ? ORDER BY updated_at DESC')
      .all(sessionId)
    return rows
      .map((row) => text((row as Record<string, unknown>)['id']))
      .filter((id) => id.length > 0)
  }

  /** Newest plan imported from a session, matched by session id and tag. */
  findPlanBySession(sessionId: string, tag = 'imported'): Plan | null {
    const row = this.requireDb()
      .prepare("SELECT * FROM plans WHERE session_id = ? AND tags LIKE ? ORDER BY updated_at DESC LIMIT 1")
      .get(sessionId, `%"${tag}"%`)
    return row === undefined ? null : toPlan(row as Record<string, unknown>)
  }

  /** Distinct non-empty workspace keys present in the store. */
  listWorkspaces(): string[] {
    const rows = this.requireDb()
      .prepare("SELECT DISTINCT workspace FROM plans WHERE workspace <> '' ORDER BY workspace ASC")
      .all()
    return rows.map((row) => text((row as Record<string, unknown>)['workspace'])).filter((key) => key.length > 0)
  }

  /** Delete a plan row (cascades to phases, tasks and events). */
  deletePlanRow(id: string): boolean {
    const result = this.requireDb().prepare('DELETE FROM plans WHERE id = ?').run(id)
    return num(result.changes) > 0
  }

  /* ------------------------------------------------------------------ *
   * phases
   * ------------------------------------------------------------------ */

  /** Insert a phase row. */
  insertPhase(phase: Phase): void {
    this.requireDb()
      .prepare(
        `INSERT INTO phases (id, plan_id, title, status, notes, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        phase.id,
        phase.planId,
        phase.title,
        phase.status,
        phase.notes,
        phase.position,
        phase.createdAt,
        phase.updatedAt,
      )
  }

  /** Apply a partial update to a phase. */
  updatePhaseRow(id: string, values: Record<string, SqlValue>): boolean {
    return this.updateRow('phases', PHASE_COLUMNS, id, values)
  }

  /** Read one phase. */
  getPhase(id: string): Phase | null {
    const row = this.requireDb().prepare('SELECT * FROM phases WHERE id = ?').get(id)
    return row === undefined ? null : toPhase(row as Record<string, unknown>)
  }

  /** List the phases of a plan in display order. */
  listPhases(planId: string): Phase[] {
    const rows = this.requireDb()
      .prepare('SELECT * FROM phases WHERE plan_id = ? ORDER BY position ASC, created_at ASC')
      .all(planId)
    return rows.map((row) => toPhase(row as Record<string, unknown>))
  }

  /** Delete a phase row (cascades to its tasks). */
  deletePhaseRow(id: string): boolean {
    const result = this.requireDb().prepare('DELETE FROM phases WHERE id = ?').run(id)
    return num(result.changes) > 0
  }

  /** Next free position among the phases of a plan. */
  nextPhasePosition(planId: string): number {
    const row = this.requireDb()
      .prepare('SELECT COALESCE(MAX(position), -1) AS p FROM phases WHERE plan_id = ?')
      .get(planId)
    return num(row?.['p'], -1) + 1
  }

  /** Shift phases down to open a slot at `position`. */
  shiftPhases(planId: string, position: number): void {
    this.requireDb()
      .prepare('UPDATE phases SET position = position + 1 WHERE plan_id = ? AND position >= ?')
      .run(planId, position)
  }

  /* ------------------------------------------------------------------ *
   * tasks
   * ------------------------------------------------------------------ */

  /** Insert a task row. */
  insertTask(task: Task): void {
    this.requireDb()
      .prepare(
        `INSERT INTO tasks (id, plan_id, phase_id, title, status, notes, links, position, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.planId,
        task.phaseId,
        task.title,
        task.status,
        task.notes,
        JSON.stringify(task.links),
        task.position,
        task.createdAt,
        task.updatedAt,
        task.completedAt,
      )
  }

  /** Apply a partial update to a task. */
  updateTaskRow(id: string, values: Record<string, SqlValue>): boolean {
    return this.updateRow('tasks', TASK_COLUMNS, id, values)
  }

  /** Read one task. */
  getTask(id: string): Task | null {
    const row = this.requireDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    return row === undefined ? null : toTask(row as Record<string, unknown>)
  }

  /** List the tasks of a plan in display order. */
  listTasks(planId: string): Task[] {
    const rows = this.requireDb()
      .prepare('SELECT * FROM tasks WHERE plan_id = ? ORDER BY position ASC, created_at ASC')
      .all(planId)
    return rows.map((row) => toTask(row as Record<string, unknown>))
  }

  /** List the tasks of several plans, grouped by plan id. */
  listTasksForPlans(planIds: readonly string[]): Map<string, Task[]> {
    const grouped = new Map<string, Task[]>()
    if (planIds.length === 0) return grouped
    const rows = this.requireDb()
      .prepare(
        `SELECT * FROM tasks WHERE plan_id IN (${placeholders(planIds.length)}) ORDER BY position ASC, created_at ASC`,
      )
      .all(...planIds)
    for (const row of rows) {
      const task = toTask(row as Record<string, unknown>)
      const bucket = grouped.get(task.planId)
      if (bucket === undefined) grouped.set(task.planId, [task])
      else bucket.push(task)
    }
    return grouped
  }

  /** Count the phases of several plans, grouped by plan id. */
  countPhasesForPlans(planIds: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>()
    if (planIds.length === 0) return counts
    const rows = this.requireDb()
      .prepare(
        `SELECT plan_id, COUNT(*) AS n FROM phases WHERE plan_id IN (${placeholders(planIds.length)}) GROUP BY plan_id`,
      )
      .all(...planIds)
    for (const row of rows) {
      const record = row as Record<string, unknown>
      counts.set(text(record['plan_id']), num(record['n']))
    }
    return counts
  }

  /** Delete a task row. */
  deleteTaskRow(id: string): boolean {
    const result = this.requireDb().prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return num(result.changes) > 0
  }

  /** Next free position inside one phase/status cell. */
  nextTaskPosition(phaseId: string, status: TaskStatus): number {
    const row = this.requireDb()
      .prepare('SELECT COALESCE(MAX(position), -1) AS p FROM tasks WHERE phase_id = ? AND status = ?')
      .get(phaseId, status)
    return num(row?.['p'], -1) + 1
  }

  /** Shift tasks down inside one phase/status cell to open a slot. */
  shiftTasks(phaseId: string, status: TaskStatus, position: number): void {
    this.requireDb()
      .prepare(
        'UPDATE tasks SET position = position + 1 WHERE phase_id = ? AND status = ? AND position >= ?',
      )
      .run(phaseId, status, position)
  }

  /** Count the tasks of one plan grouped by status. */
  countTasksByStatus(planId?: string): Record<TaskStatus, number> {
    const db = this.requireDb()
    const scoped = typeof planId === 'string' && planId.length > 0
    const rows = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM tasks ${scoped ? 'WHERE plan_id = ?' : ''} GROUP BY status`,
      )
      .all(...(scoped ? [planId as SqlValue] : []))
    const counts: Record<TaskStatus, number> = { todo: 0, doing: 0, blocked: 0, done: 0 }
    for (const row of rows) {
      const record = row as Record<string, unknown>
      const status = text(record['status']) as TaskStatus
      if (status in counts) counts[status] = num(record['n'])
    }
    return counts
  }

  /** Total number of phase and task rows (reporting helper). */
  countRows(): { phases: number; tasks: number } {
    const db = this.requireDb()
    return {
      phases: num(db.prepare('SELECT COUNT(*) AS n FROM phases').get()?.['n'], 0),
      tasks: num(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.['n'], 0),
    }
  }

  /* ------------------------------------------------------------------ *
   * events
   * ------------------------------------------------------------------ */

  /** Append a journal entry. */
  insertEvent(event: PlanEvent): void {
    this.requireDb()
      .prepare(
        `INSERT INTO plan_events (id, plan_id, kind, message, data, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.planId,
        event.kind,
        event.message,
        JSON.stringify(event.data),
        event.sessionId,
        event.createdAt,
      )
  }

  /** Read the newest journal entries of a plan; a limit of 0 returns none. */
  listEvents(planId: string, limit = 20): PlanEvent[] {
    const count = Math.max(0, Math.trunc(limit))
    if (count === 0) return []
    const rows = this.requireDb()
      .prepare('SELECT * FROM plan_events WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(planId, count)
    return rows.map((row) => toEvent(row as Record<string, unknown>))
  }

  /* ------------------------------------------------------------------ *
   * search
   * ------------------------------------------------------------------ */

  /** Full-text search over plans and tasks; falls back to LIKE without FTS5. */
  search(query: string, workspace?: string, limit = 20): SearchHit[] {
    const raw = query.trim()
    if (raw.length === 0) return []
    const db = this.requireDb()
    const scoped = typeof workspace === 'string' && workspace.length > 0
    if (this.fts) {
      const match = toFtsQuery(raw)
      if (match.length > 0) {
        try {
          return this.searchFts(db, match, scoped ? workspace : '', limit)
        } catch (error) {
          this.log(`FTS5 search failed, falling back to LIKE: ${String(error)}`)
        }
      }
    }
    return this.searchLike(db, raw, scoped ? workspace : '', limit)
  }

  /** FTS5 search with bm25 ranking. */
  private searchFts(db: DatabaseSync, match: string, workspace: string, limit: number): SearchHit[] {
    const scope = workspace.length > 0 ? 'AND p.workspace = ?' : ''
    const scopeParams: SqlValue[] = workspace.length > 0 ? [workspace] : []
    const planRows = db
      .prepare(
        `SELECT p.id AS id, p.id AS plan_id, p.title AS title,
                snippet(plans_fts, -1, '[', ']', '…', 12) AS snippet,
                bm25(plans_fts) AS score
         FROM plans_fts JOIN plans p ON p.rowid = plans_fts.rowid
         WHERE plans_fts MATCH ? ${scope}
         ORDER BY score ASC LIMIT ?`,
      )
      .all(match, ...scopeParams, limit)
    const taskRows = db
      .prepare(
        `SELECT t.id AS id, t.plan_id AS plan_id, t.title AS title,
                snippet(tasks_fts, -1, '[', ']', '…', 12) AS snippet,
                bm25(tasks_fts) AS score
         FROM tasks_fts JOIN tasks t ON t.rowid = tasks_fts.rowid
         JOIN plans p ON p.id = t.plan_id
         WHERE tasks_fts MATCH ? ${scope}
         ORDER BY score ASC LIMIT ?`,
      )
      .all(match, ...scopeParams, limit)
    return [
      ...planRows.map((row) => this.toHit('plan', row as Record<string, unknown>)),
      ...taskRows.map((row) => this.toHit('task', row as Record<string, unknown>)),
    ]
      .sort((a, b) => a.score - b.score)
      .slice(0, limit)
  }

  /** Substring search used when FTS5 is unavailable. */
  private searchLike(db: DatabaseSync, query: string, workspace: string, limit: number): SearchHit[] {
    const like = `%${query}%`
    const scope = workspace.length > 0 ? 'AND workspace = ?' : ''
    const scopeParams: SqlValue[] = workspace.length > 0 ? [workspace] : []
    const planRows = db
      .prepare(
        `SELECT id, id AS plan_id, title, description AS snippet FROM plans
         WHERE (title LIKE ? OR description LIKE ?) ${scope} LIMIT ?`,
      )
      .all(like, like, ...scopeParams, limit)
    const taskScope = workspace.length > 0 ? 'AND p.workspace = ?' : ''
    const taskRows = db
      .prepare(
        `SELECT t.id AS id, t.plan_id AS plan_id, t.title AS title, t.notes AS snippet
         FROM tasks t JOIN plans p ON p.id = t.plan_id
         WHERE (t.title LIKE ? OR t.notes LIKE ?) ${taskScope} LIMIT ?`,
      )
      .all(like, like, ...scopeParams, limit)
    return [
      ...planRows.map((row, index) => this.toHit('plan', row as Record<string, unknown>, index)),
      ...taskRows.map((row, index) => this.toHit('task', row as Record<string, unknown>, index + planRows.length)),
    ].slice(0, limit)
  }

  /** Map a search row onto a hit. */
  private toHit(kind: 'plan' | 'task', row: Record<string, unknown>, score = num(row['score'], 0)): SearchHit {
    const snippet = text(row['snippet'])
    return {
      kind,
      id: text(row['id']),
      planId: text(row['plan_id']),
      title: text(row['title']),
      snippet: snippet.includes('[') ? snippet : excerpt(snippet),
      score,
    }
  }

  /* ------------------------------------------------------------------ *
   * helpers
   * ------------------------------------------------------------------ */

  /** Build and run a whitelisted partial update. */
  private updateRow(
    table: 'plans' | 'phases' | 'tasks',
    columns: ReadonlySet<string>,
    id: string,
    values: Record<string, SqlValue>,
  ): boolean {
    const entries = Object.entries(values).filter(([column]) => columns.has(column))
    if (entries.length === 0) return false
    const assignments = entries.map(([column]) => `${column} = ?`).join(', ')
    const params = entries.map(([, value]) => value)
    const result = this.requireDb()
      .prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`)
      .run(...params, id)
    return num(result.changes) > 0
  }
}
