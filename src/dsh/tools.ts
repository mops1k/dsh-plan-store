/**
 * Model-facing `plan_*` tools registered on `ctx.tools`.
 *
 * Fourteen tools map onto {@link PlanEngine} operations: create/list/get/search,
 * update, soft delete, phase and task mutations, export and status. Every tool
 * is autonomous — it performs the requested operation without asking the user
 * for confirmation. `plan_purge` and `plan_import_session` keep their engine and
 * HTTP/UI surfaces but are no longer model-facing (see {@link PLAN_TOOL_NAMES}).
 *
 * The workspace of a call is derived from the calling session's working
 * directory (see `./session.ts`), so `plan_create` binds a plan to its project
 * and `plan_export` can write `.dsh/plans/<slug>.md` without extra arguments.
 *
 * @module dsh-plan-store/dsh/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { PlanStoreConfig } from '../core/config.js'
import { PlanError, type PlanEngine } from '../core/engine.js'
import type {
  PhaseTree,
  Plan,
  PlanProgress,
  PlanSummary,
  PlanTree,
  SearchHit,
  Task,
} from '../core/types.js'
import { syncPlanGoal } from './goal-sync.js'
import { resolveWorkspace } from './session.js'
import { readSessionState } from './session-state.js'
import { syncPlanTodos } from './todo-sync.js'

/**
 * Every tool name this plugin owns.
 *
 * `plan_purge` and `plan_import_session` are deliberately NOT model-facing:
 * their schemas cost tokens on every request and they were never called
 * (0 of 19 706 recorded tool calls, 2026-10-12). The engine methods and the
 * HTTP/UI surfaces that drive them stay available.
 */
export const PLAN_TOOL_NAMES = [
  'plan_create',
  'plan_list',
  'plan_get',
  'plan_search',
  'plan_update',
  'plan_delete',
  'plan_phase_add',
  'plan_phase_update',
  'plan_phase_delete',
  'plan_task_add',
  'plan_task_update',
  'plan_task_delete',
  'plan_export',
  'plan_status',
] as const

/** Tools kept available only to the full agent preset. */
export const PLAN_FULL_ONLY_TOOL_NAMES = [
  'plan_delete',
  'plan_phase_delete',
  'plan_task_delete',
  'plan_status',
] as const

/** Sink for non-fatal registration problems. */
export interface PlanToolLogger {
  warn(message: string): void
}

/** Describe an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Log a warning through the Cordis logger, falling back to the console. */
function warnTool(ctx: Context, message: string): void {
  try {
    ctx.logger.warn(message)
  } catch {
    console.warn(`[dsh-plan-store] ${message}`)
  }
}

/* ------------------------------------------------------------------ *
 * schemas
 * ------------------------------------------------------------------ */

/** Progress counters shared by the outputs. */
const PROGRESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer', required: true, description: 'Total number of tasks.' },
    todo: { type: 'integer', required: true, description: 'Tasks not started yet.' },
    doing: { type: 'integer', required: true, description: 'Tasks in progress.' },
    blocked: { type: 'integer', required: true, description: 'Blocked tasks.' },
    done: { type: 'integer', required: true, description: 'Finished tasks.' },
    percent: { type: 'integer', required: true, description: 'Share of finished tasks, 0-100.' },
  },
} as const

/** Human-readable rendering field. */
const TEXT_FIELD = {
  type: 'string',
  required: true,
  description: 'Human-readable rendering of the result.',
} as const

/** Structured plan payload field. */
const PLAN_FIELD = {
  type: 'json',
  required: true,
  description:
    'Structured payload: plan fields, phases with their tasks, progress counters and recent events.',
} as const

/** Structured list payload field. */
const PLANS_FIELD = {
  type: 'array',
  required: true,
  items: { type: 'json' },
  description: 'Structured plan rows with progress and the next open task.',
} as const

/** Structured search payload field. */
const HITS_FIELD = {
  type: 'array',
  required: true,
  items: { type: 'json' },
  description: 'Search hits with kind, ids, title, highlighted snippet and bm25 score.',
} as const

/** Plan status values shared by the parameters. */
const PLAN_STATUS_VALUES = ['backlog', 'active', 'blocked', 'done', 'archived'] as const

/** Work status values shared by the parameters. */
const WORK_STATUS_VALUES = ['todo', 'doing', 'blocked', 'done'] as const

/** Plan priority values. */
const PRIORITY_VALUES = ['low', 'normal', 'high', 'urgent'] as const

/* ------------------------------------------------------------------ *
 * views
 * ------------------------------------------------------------------ */

/** Structured view of progress counters. */
function progressJson(progress: PlanProgress): {
  total: number
  todo: number
  doing: number
  blocked: number
  done: number
  percent: number
} {
  return {
    total: progress.total,
    todo: progress.todo,
    doing: progress.doing,
    blocked: progress.blocked,
    done: progress.done,
    percent: progress.percent,
  }
}

/** Structured view of a plan row. */
function planJson(plan: Plan): {
  id: string
  title: string
  description: string
  status: string
  priority: string
  workspace: string
  workspaceRoot: string
  tags: string[]
  exportPath: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
} {
  return {
    id: plan.id,
    title: plan.title,
    description: plan.description,
    status: plan.status,
    priority: plan.priority,
    workspace: plan.workspace,
    workspaceRoot: plan.workspaceRoot,
    tags: [...plan.tags],
    exportPath: plan.exportPath,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    archivedAt: plan.archivedAt,
  }
}

/** Structured view of a task row. */
function taskJson(task: Task): {
  id: string
  phaseId: string
  title: string
  status: string
  notes: string
  links: string[]
  position: number
  completedAt: string | null
} {
  return {
    id: task.id,
    phaseId: task.phaseId,
    title: task.title,
    status: task.status,
    notes: task.notes,
    links: [...task.links],
    position: task.position,
    completedAt: task.completedAt,
  }
}

/** Structured view of a phase with its tasks. */
function phaseJson(phase: PhaseTree) {
  return {
    id: phase.id,
    title: phase.title,
    status: phase.status,
    notes: phase.notes,
    position: phase.position,
    progress: progressJson(phase.progress),
    tasks: phase.tasks.map((task) => taskJson(task)),
  }
}

/** Structured view of a full plan tree. */
function treeJson(tree: PlanTree) {
  return {
    ...planJson(tree),
    progress: progressJson(tree.progress),
    phases: tree.phases.map((phase) => phaseJson(phase)),
    events: tree.events.map((event) => ({
      id: event.id,
      kind: event.kind,
      message: event.message,
      data: event.data,
      createdAt: event.createdAt,
    })),
  }
}

/** Structured view of a list row. */
function summaryJson(plan: PlanSummary) {
  return {
    ...planJson(plan),
    phaseCount: plan.phaseCount,
    taskCount: plan.taskCount,
    progress: progressJson(plan.progress),
    nextTask: plan.nextTask === null ? null : taskJson(plan.nextTask),
    notesChars: plan.notesChars,
    chars: plan.chars,
  }
}

/** Structured view of one search hit. */
function hitJson(hit: SearchHit) {
  return {
    kind: hit.kind,
    id: hit.id,
    planId: hit.planId,
    title: hit.title,
    snippet: hit.snippet,
    score: hit.score,
  }
}

/** Compact `3/7 done (43%)` label. */
function progressLabel(progress: PlanProgress): string {
  return `${progress.done}/${progress.total} done (${progress.percent}%)`
}

/** Compact character count: `940`, `12.3k` or `162k`. */
function charsLabel(value: number): string {
  if (value >= 10000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/** One-line plan header used by the markdown renderings. */
function planLine(plan: Plan | PlanSummary): string {
  const parts = [`${plan.id} · ${plan.title}`, `[${plan.status}]`]
  if (plan.priority !== 'normal') parts.push(plan.priority)
  if (plan.workspace.length > 0) parts.push(`workspace: ${plan.workspace}`)
  if (plan.tags.length > 0) parts.push(`tags: ${plan.tags.join(', ')}`)
  return parts.join(' · ')
}

/** Default character budget of a rendered plan tree (≈1.7k tokens). */
const TREE_MAX_CHARS = 6000

/** Characters kept from one note inside a budgeted tree. */
const TREE_NOTE_CHARS = 200

/** Shortest clipped note that is still worth printing. */
const TREE_MIN_NOTE_CHARS = 40

/** How much room the clipping marker may take inside the budget. */
const TREE_MARKER_CHARS = 160

/** How a tree render spends its character budget. */
interface TreeTextOptions {
  /** Budget of the whole rendering; `0` means unbounded. */
  maxChars?: number
  /** Per-note clip limit; `0` keeps the default (unbounded without a budget). */
  noteChars?: number
}

/** Mandatory lines of one phase or task plus its optional free text. */
interface TreeBlock {
  core: string[]
  notes: string[]
}

/** Clip free text to `limit` characters, reporting whether anything was lost. */
function clipNote(text: string, limit: number): { text: string; clipped: boolean } {
  if (text.length <= limit) return { text, clipped: false }
  return { text: `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`, clipped: true }
}

/** Split a plan tree into mandatory blocks and optional free-text lines. */
function treeBlocks(tree: PlanTree): TreeBlock[] {
  const blocks: TreeBlock[] = []
  for (const [index, phase] of tree.phases.entries()) {
    const core = [`## Phase ${index + 1}: ${phase.title} (${phase.id}) [${phase.status}] — ${progressLabel(phase.progress)}`]
    if (phase.tasks.length === 0) core.push('_No tasks._')
    blocks.push({ core: ['', ...core], notes: phase.notes.trim().length > 0 ? [phase.notes.trim()] : [] })
    for (const task of phase.tasks) {
      const notes: string[] = []
      if (task.notes.trim().length > 0) notes.push(`  ${task.notes.trim()}`)
      if (task.links.length > 0) notes.push(`  links: ${task.links.join(', ')}`)
      blocks.push({ core: [taskLine(task)], notes })
    }
  }
  if (tree.phases.length === 0) blocks.push({ core: ['', '_No phases._'], notes: [] })
  return blocks
}

/** Journal tail lines of a plan tree. */
function eventLines(tree: PlanTree): string[] {
  if (tree.events.length === 0) return []
  const lines = ['', 'Recent events:']
  for (const event of tree.events.slice(0, 5)) lines.push(`- ${event.createdAt} ${event.kind}: ${event.message}`)
  return lines
}

/**
 * Render a plan tree as markdown within a character budget.
 *
 * The lines that carry identity — the plan header, every phase line and every
 * task line with its id — are never dropped: without an id the agent cannot ask
 * for the details. Only the free text (description, notes, links) is clipped,
 * and a final marker names how much was left out and how to read one node in
 * full. A tree whose identity lines alone exceed the budget still renders
 * complete — the budget is a target, not a promise — and `0` disables it.
 */
function treeText(tree: PlanTree, options: TreeTextOptions = {}): string {
  const budget = Math.trunc(options.maxChars ?? TREE_MAX_CHARS)
  const maxChars = budget > 0 ? budget : Number.POSITIVE_INFINITY
  const requestedNote = options.noteChars === undefined ? 0 : Math.trunc(options.noteChars)
  const noteChars =
    requestedNote > 0
      ? Math.max(TREE_MIN_NOTE_CHARS, requestedNote)
      : Number.isFinite(maxChars)
        ? TREE_NOTE_CHARS
        : Number.POSITIVE_INFINITY
  const head = [planLine(tree), `Progress: ${progressLabel(tree.progress)}`]
  const description = tree.description.trim()
  if (description.length > 0) head.push('', description)
  if (tree.exportPath !== null) head.push('', `Exported: ${tree.exportPath}`)
  const blocks = treeBlocks(tree)
  const cost = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + line.length + 1, 0)

  const coreCost = cost(head) + blocks.reduce((sum, block) => sum + cost(block.core), 0)
  const events = coreCost + cost(eventLines(tree)) <= maxChars ? eventLines(tree) : []
  const hasNotes = blocks.some((block) => block.notes.length > 0)
  let remaining = Math.max(0, maxChars - coreCost - cost(events) - (hasNotes ? TREE_MARKER_CHARS : 0))

  const out = [...head]
  let clipped = 0
  for (const block of blocks) {
    out.push(...block.core)
    for (const line of block.notes) {
      const room = Math.min(noteChars, remaining)
      if (room < TREE_MIN_NOTE_CHARS) {
        clipped += 1
        continue
      }
      const short = clipNote(line, room)
      out.push(short.text)
      remaining -= short.text.length + 1
      if (short.clipped) clipped += 1
    }
  }
  out.push(...events)
  if (clipped > 0) {
    out.push(
      '',
      `[${clipped} note/link line(s) clipped to keep this rendering small — read one task in full with plan_get { id, taskId }, or the exported markdown file]`,
    )
  }
  return out.join('\n')
}

/** Compact headline of a plan: identity, status and progress. */
function headline(tree: PlanTree): string {
  return `${planLine(tree)} · ${progressLabel(tree.progress)}`
}

/** One-line rendering of a task. */
function taskLine(task: Task): string {
  const mark = task.status === 'done' ? 'x' : ' '
  const suffix = task.status === 'doing' || task.status === 'blocked' ? ` _(${task.status})_` : ''
  return `- [${mark}] ${task.title} (${task.id})${suffix}`
}

/** One-line rendering of a phase. */
function phaseLine(phase: PhaseTree): string {
  return `## ${phase.title} (${phase.id}) [${phase.status}] — ${progressLabel(phase.progress)}`
}

/** Find a phase inside a tree. */
function findPhase(tree: PlanTree, phaseId: string): PhaseTree | null {
  return tree.phases.find((phase) => phase.id === phaseId) ?? null
}

/** Find a task inside a tree together with its phase. */
function findTask(tree: PlanTree, taskId: string): { phase: PhaseTree; task: Task } | null {
  for (const phase of tree.phases) {
    const task = phase.tasks.find((item) => item.id === taskId)
    if (task !== undefined) return { phase, task }
  }
  return null
}

/** Render plan list rows as markdown. */
function listText(plans: PlanSummary[], total: number): string {
  if (plans.length === 0) return 'No plans match the filter.'
  const lines = plans.map((plan) => {
    const next = plan.nextTask === null ? 'no open task' : `next: ${plan.nextTask.title}`
    // A row stays short unless reading the plan is actually expensive.
    const size = plan.chars >= 4000 ? ` — tree: ~${charsLabel(plan.chars)} chars (${charsLabel(plan.notesChars)} notes)` : ''
    return `- ${planLine(plan)} — ${progressLabel(plan.progress)} — ${next}${size}`
  })
  lines.push('', `${plans.length} of ${total} plan(s) shown.`)
  return lines.join('\n')
}

/** Render search hits as markdown. */
function hitsText(hits: SearchHit[]): string {
  if (hits.length === 0) return 'No matching plans or tasks.'
  return hits
    .map((hit) => `- [${hit.kind}] ${hit.title} (${hit.id}) — ${hit.snippet}`)
    .join('\n')
}

/** Result of the automatic export that follows a mutation. */
interface AutoExport {
  path: string
  tree: PlanTree
}

/**
 * Export the plan after a mutation when `autoExport` is on.
 *
 * The markdown copy has to exist either way — the global rules require
 * `.dsh/plans/<slug>.md` — but asking the model for a `plan_export` call after
 * every change costs a whole extra model step, and a step re-sends the entire
 * conversation. Writing the file here removes that step: the mutation's own
 * result carries the path. Failures are logged and never fail the mutation, and
 * the automatic path records no journal event (a status flip must not add a
 * row and shift the plan's journal tail). The plan's own workspace root wins so
 * a call from another project cannot move the file.
 */
function autoExportPlan(
  ctx: Context,
  engine: PlanEngine,
  config: PlanStoreConfig,
  tree: PlanTree,
  exec: unknown,
): AutoExport | null {
  if (!config.autoExport) return null
  const own = tree.workspaceRoot.trim()
  const root = own.length > 0 ? own : resolveWorkspace(ctx, exec).root.trim()
  if (root.length === 0) return null
  try {
    return engine.exportPlan(tree.id, {
      workspaceRoot: root,
      exportDir: config.exportDir,
      recordEvent: false,
    })
  } catch (error) {
    warnTool(ctx, `Automatic export of ${tree.id} into ${root} failed: ${errorMessage(error)}`)
    return null
  }
}

/**
 * Finish a mutating tool call: export the plan, mirror it into the session todo
 * and goal panels, and build the result payload.
 *
 * @param text - the mutation's own rendering, without the export line.
 * @returns the tool result, with `Exported: <path>` appended when the file was
 *   written.
 */
function mutationResult(
  ctx: Context,
  exec: unknown,
  engine: PlanEngine,
  config: PlanStoreConfig,
  tree: PlanTree,
  text: string,
): { text: string; plan: ReturnType<typeof treeJson>; progress: ReturnType<typeof progressJson> } {
  const exported = autoExportPlan(ctx, engine, config, tree, exec)
  const shown = exported?.tree ?? tree
  syncPlanTodos(ctx, exec, shown, shown.id, config)
  syncPlanGoal(ctx, exec, shown, config)
  return {
    text: exported === null ? text : `${text}\nExported: ${exported.path}`,
    plan: treeJson(shown),
    progress: progressJson(shown.progress),
  }
}

/* ------------------------------------------------------------------ *
 * registration
 * ------------------------------------------------------------------ */

/**
 * Register the fifteen plan tools.
 *
 * A tool whose name is already owned by another plugin is skipped with a
 * warning instead of failing activation.
 *
 * @param ctx - host context carrying the tool registry.
 * @param engine - live plan engine.
 * @param config - shared configuration (export directory, defaults).
 * @returns the names that were actually registered.
 */
export function registerPlanTools(ctx: Context, engine: PlanEngine, config: PlanStoreConfig): string[] {
  const registered: string[] = []
  const register = (definition: ToolDefinition): void => {
    try {
      ctx.tools.register(definition)
      registered.push(definition.name)
    } catch (error) {
      warnTool(ctx, `Tool "${definition.name}" could not be registered: ${errorMessage(error)}; skipping.`)
    }
  }

  register(
    defineTool({
      name: 'plan_create',
      description: 'Create a plan in the plan store with phases and tasks. Returns the full tree.',
      parameters: {
        title: { type: 'string', required: true, description: 'Short plan title.' },
        description: { type: 'string', description: 'What the plan is about.' },
        workspace: { type: 'string', description: 'Workspace key; defaults to the session project.' },
        status: { type: 'string', enum: PLAN_STATUS_VALUES, description: 'Initial status (default backlog).' },
        priority: { type: 'string', enum: PRIORITY_VALUES, description: 'Priority (default normal).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags.' },
        phases: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', required: true, description: 'Phase title.' },
              notes: { type: 'string', description: 'Phase notes.' },
              status: { type: 'string', enum: WORK_STATUS_VALUES, description: 'Phase status (default todo).' },
              tasks: {
                type: 'array',
                items: {
                  oneOf: [
                    { type: 'string', description: 'Task title (notes and links can be added later).' },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        title: { type: 'string', required: true, description: 'Task title.' },
                        notes: { type: 'string', description: 'Task notes.' },
                        status: { type: 'string', enum: WORK_STATUS_VALUES, description: 'Task status (default todo).' },
                        links: { type: 'array', items: { type: 'string' }, description: 'Related paths or URLs.' },
                      },
                    },
                  ],
                },
                description: 'Tasks of this phase: a title string or an object with title, notes, status and links.',
              },
            },
          },
          description: 'Phases to create, each with its tasks.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: TEXT_FIELD, plan: PLAN_FIELD, progress: PROGRESS_SCHEMA },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        const workspace = resolveWorkspace(ctx, exec, args.workspace)
        const tree = engine.createPlan(
          {
            title: args.title,
            ...(args.description !== undefined ? { description: args.description } : {}),
            workspace: workspace.key,
            workspaceRoot: workspace.root,
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.priority !== undefined ? { priority: args.priority } : {}),
            ...(args.tags !== undefined ? { tags: args.tags } : {}),
            ...(args.phases !== undefined
              ? { phases: args.phases.map((phase) => ({ ...phase })) }
              : {}),
          },
          { sessionId: exec.agent?.id === undefined ? null : String(exec.agent.id) },
        )
        return mutationResult(ctx, exec, engine, config, tree, `Created plan.\n\n${treeText(tree)}`)
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_list',
      description: 'List plans with progress and the next open task (default 20).',
      parameters: {
        status: {
          type: 'string',
          enum: [...PLAN_STATUS_VALUES, 'all'],
          description: 'Restrict to one status; all shows every status (default all).',
        },
        workspace: { type: 'string', description: 'Restrict to one workspace key.' },
        query: { type: 'string', description: 'Substring filter over title and description.' },
        includeArchived: { type: 'boolean', description: 'Include archived plans (default false).' },
        limit: { type: 'integer', description: 'Maximum number of rows (default 20).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: TEXT_FIELD,
            plans: PLANS_FIELD,
            count: { type: 'integer', required: true, description: 'Rows returned.' },
            total: { type: 'integer', required: true, description: 'Rows matching the filter.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args) => {
        const result = engine.listPlans({
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.includeArchived !== undefined ? { includeArchived: args.includeArchived } : {}),
          limit: args.limit ?? 20,
        })
        return {
          text: listText(result.plans, result.total),
          plans: result.plans.map(summaryJson),
          count: result.plans.length,
          total: result.total,
        }
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_get',
      description: 'Read a plan tree (id lines always, notes clipped) or one task/phase in full.',
      parameters: {
        id: { type: 'string', required: true, description: 'Plan id (p_…).' },
        eventLimit: { type: 'integer', description: 'How many journal entries to include (default 20).' },
        maxChars: { type: 'integer', description: `Character budget; 0 disables it (default ${TREE_MAX_CHARS}).` },
        taskId: { type: 'string', description: 'Read only this task (t_…) in full.' },
        phaseId: { type: 'string', description: 'Read only this phase (ph_…) in full.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: TEXT_FIELD, plan: PLAN_FIELD, progress: PROGRESS_SCHEMA },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args) => {
        const tree = engine.requireTree(args.id, args.eventLimit ?? 20)
        const maxChars = args.maxChars ?? TREE_MAX_CHARS
        if (args.taskId !== undefined) {
          const found = findTask(tree, args.taskId)
          if (found === null) throw new PlanError('not_found', `Task not found in plan ${tree.id}: ${args.taskId}`)
          const focused: PlanTree = { ...tree, phases: [{ ...found.phase, tasks: [found.task] }], events: [] }
          return { text: treeText(focused, { maxChars, noteChars: maxChars }), plan: treeJson(tree), progress: progressJson(tree.progress) }
        }
        if (args.phaseId !== undefined) {
          const phase = findPhase(tree, args.phaseId)
          if (phase === null) throw new PlanError('not_found', `Phase not found in plan ${tree.id}: ${args.phaseId}`)
          const focused: PlanTree = { ...tree, phases: [phase], events: [] }
          return { text: treeText(focused, { maxChars, noteChars: maxChars }), plan: treeJson(tree), progress: progressJson(tree.progress) }
        }
        return { text: treeText(tree, { maxChars }), plan: treeJson(tree), progress: progressJson(tree.progress) }
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_search',
      description: 'Full-text search (FTS5) over plan and task titles and notes (default 10 hits).',
      parameters: {
        query: { type: 'string', required: true, description: 'Search terms; all terms must match.' },
        workspace: { type: 'string', description: 'Restrict to one workspace key.' },
        limit: { type: 'integer', description: 'Maximum number of hits (default 10).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: TEXT_FIELD,
            hits: HITS_FIELD,
            count: { type: 'integer', required: true, description: 'Hits returned.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args) => {
        const hits = engine.searchPlans(args.query, args.workspace, args.limit ?? 10)
        return { text: hitsText(hits), hits: hits.map((hit) => hitJson(hit)), count: hits.length }
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_update',
      description: 'Update plan metadata: title, description, status, priority, tags or workspace.',
      parameters: {
        id: { type: 'string', required: true, description: 'Plan id (p_…).' },
        title: { type: 'string', description: 'New title.' },
        description: { type: 'string', description: 'New description.' },
        status: { type: 'string', enum: PLAN_STATUS_VALUES, description: 'New status.' },
        priority: { type: 'string', enum: PRIORITY_VALUES, description: 'New priority.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tag list.' },
        workspace: { type: 'string', description: 'Replacement workspace key.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: TEXT_FIELD, plan: PLAN_FIELD, progress: PROGRESS_SCHEMA },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        const patch = {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
        }
        const tree = engine.updatePlan(args.id, patch, { sessionId: sessionIdOf(exec) })
        return mutationResult(ctx, exec, engine, config, tree, `Updated plan.\n${headline(tree)}`)
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_delete',
      description: 'Archive a plan (soft delete); restore it later with plan_update status=backlog.',
      parameters: {
        id: { type: 'string', required: true, description: 'Plan id (p_…).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: TEXT_FIELD, plan: PLAN_FIELD, progress: PROGRESS_SCHEMA },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        const tree = engine.archivePlan(args.id, { sessionId: sessionIdOf(exec) })
        return mutationResult(ctx, exec, engine, config, tree, `Archived plan ${tree.id}.`)
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_phase_add',
      description: 'Add a phase to a plan, optionally with task titles. Returns the new phase id.',
      parameters: {
        planId: { type: 'string', required: true, description: 'Plan id (p_…).' },
        title: { type: 'string', required: true, description: 'Phase title.' },
        notes: { type: 'string', description: 'Phase notes.' },
        status: { type: 'string', enum: WORK_STATUS_VALUES, description: 'Phase status (default todo).' },
        position: { type: 'integer', description: 'Zero-based position; omitted appends to the end.' },
        tasks: { type: 'array', items: { type: 'string' }, description: 'Task titles of the new phase.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: TEXT_FIELD, plan: PLAN_FIELD, progress: PROGRESS_SCHEMA },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        const before = new Set(engine.requireTree(args.planId, 0).phases.map((phase) => phase.id))
        const tree = engine.addPhase(
          args.planId,
          {
            title: args.title,
            ...(args.notes !== undefined ? { notes: args.notes } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.position !== undefined ? { position: args.position } : {}),
            ...(args.tasks !== undefined ? { tasks: args.tasks } : {}),
          },
          { sessionId: sessionIdOf(exec) },
        )
        const addedPhase = tree.phases.find((phase) => !before.has(phase.id)) ?? null
        return mutationResult(
          ctx,
          exec,
          engine,
          config,
          tree,
          `Added phase.\n${headline(tree)}\n${addedPhase === null ? '' : phaseLine(addedPhase)}`.trimEnd(),
        )
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_phase_update',
      description: 'Update a phase: title, status, notes or position.',
      parameters: {
        id: { type: 'string', required: true, description: 'Phase id (ph_…).' },
        title: { type: 'string', description: 'New phase title.' },
        status: { type: 'string', enum: WORK_STATUS_VALUES, description: 'New phase status.' },
        notes: { type: 'string', description: 'New phase notes.' },
        position: { type: 'integer', description: 'New zero-based position.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: TEXT_FIELD, plan: PLAN_FIELD, progress: PROGRESS_SCHEMA },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        const patch = {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
          ...(args.position !== undefined ? { position: args.position } : {}),
        }
        const tree = engine.updatePhase(args.id, patch, { sessionId: sessionIdOf(exec) })
        const changedPhase = findPhase(tree, args.id)
        return mutationResult(
          ctx,
          exec,
          engine,
          config,
          tree,
          `Updated phase.\n${headline(tree)}\n${changedPhase === null ? '' : phaseLine(changedPhase)}`.trimEnd(),
        )
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_phase_delete',
      description: 'Delete a phase together with all of its tasks.',
      parameters: {
        id: { type: 'string', required: true, description: 'Phase id (ph_…).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: TEXT_FIELD, plan: PLAN_FIELD, progress: PROGRESS_SCHEMA },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        const tree = engine.deletePhase(args.id, { sessionId: sessionIdOf(exec) })
        return mutationResult(ctx, exec, engine, config, tree, `Deleted phase.\n${headline(tree)}`)
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_task_add',
      description: 'Add a task to a plan (default phase: the first one). Returns the new task id.',
      parameters: {
        planId: { type: 'string', required: true, description: 'Plan id (p_…).' },
        title: { type: 'string', required: true, description: 'Task title.' },
        phaseId: { type: 'string', description: 'Phase id (ph_…); defaults to the first phase.' },
        status: { type: 'string', enum: WORK_STATUS_VALUES, description: 'Task status (default todo).' },
        notes: { type: 'string', description: 'Task notes.' },
        links: { type: 'array', items: { type: 'string' }, description: 'Related file paths or URLs.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: TEXT_FIELD, plan: PLAN_FIELD, progress: PROGRESS_SCHEMA },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        const before = new Set(
          engine
            .requireTree(args.planId, 0)
            .phases.flatMap((phase) => phase.tasks.map((task) => task.id)),
        )
        const tree = engine.addTask(
          args.planId,
          {
            title: args.title,
            ...(args.phaseId !== undefined ? { phaseId: args.phaseId } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.notes !== undefined ? { notes: args.notes } : {}),
            ...(args.links !== undefined ? { links: args.links } : {}),
          },
          { sessionId: sessionIdOf(exec) },
        )
        const addedTask =
          tree.phases
            .flatMap((phase) => phase.tasks.map((task) => ({ phase, task })))
            .find((entry) => !before.has(entry.task.id)) ?? null
        return mutationResult(
          ctx,
          exec,
          engine,
          config,
          tree,
          `Added task.\n${headline(tree)}\n${addedTask === null ? '' : taskLine(addedTask.task)}`.trimEnd(),
        )
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_task_update',
      description: 'Update a task: status (done or not), title, notes, links, phase or position.',
      parameters: {
        id: { type: 'string', required: true, description: 'Task id (t_…).' },
        title: { type: 'string', description: 'New task title.' },
        status: { type: 'string', enum: WORK_STATUS_VALUES, description: 'New task status.' },
        notes: { type: 'string', description: 'New task notes.' },
        links: { type: 'array', items: { type: 'string' }, description: 'Replacement link list.' },
        phaseId: { type: 'string', description: 'Move the task to another phase of the same plan.' },
        position: { type: 'integer', description: 'New zero-based position inside its phase and status.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: TEXT_FIELD, plan: PLAN_FIELD, progress: PROGRESS_SCHEMA },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        const patch = {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
          ...(args.links !== undefined ? { links: args.links } : {}),
          ...(args.phaseId !== undefined ? { phaseId: args.phaseId } : {}),
          ...(args.position !== undefined ? { position: args.position } : {}),
        }
        const tree = engine.updateTask(args.id, patch, { sessionId: sessionIdOf(exec) })
        const changedTask = findTask(tree, args.id)
        return mutationResult(
          ctx,
          exec,
          engine,
          config,
          tree,
          `Updated task.\n${headline(tree)}\n${changedTask === null ? '' : taskLine(changedTask.task)}`.trimEnd(),
        )
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_task_delete',
      description: 'Delete a task.',
      parameters: {
        id: { type: 'string', required: true, description: 'Task id (t_…).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: TEXT_FIELD, plan: PLAN_FIELD, progress: PROGRESS_SCHEMA },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        const tree = engine.deleteTask(args.id, { sessionId: sessionIdOf(exec) })
        return mutationResult(ctx, exec, engine, config, tree, `Deleted task.\n${headline(tree)}`)
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_export',
      description: 'Export one plan as markdown with checkboxes into .dsh/plans/<slug>.md; mutations already do this.',
      parameters: {
        id: { type: 'string', required: true, description: 'Plan id (p_…).' },
        workspaceRoot: { type: 'string', description: 'Absolute workspace root; defaults to the session cwd.' },
        exportDir: { type: 'string', description: `Directory relative to the root (default ${config.exportDir}).` },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: TEXT_FIELD,
            path: { type: 'string', required: true, description: 'Absolute path of the written file.' },
            plan: PLAN_FIELD,
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        const workspace = resolveWorkspace(ctx, exec, undefined, args.workspaceRoot)
        const root = (args.workspaceRoot ?? '').trim() || workspace.root
        const result = engine.exportPlan(args.id, {
          workspaceRoot: root,
          exportDir: args.exportDir ?? config.exportDir,
          sessionId: sessionIdOf(exec),
        })
        return {
          text: `Exported plan ${result.tree.id} to ${result.path}.`,
          path: result.path,
          plan: treeJson(result.tree),
        }
      },
    }),
  )

  register(
    defineTool({
      name: 'plan_status',
      description: 'Report store counters, stale plans and the database location.',
      parameters: {
        workspace: { type: 'string', description: 'Restrict the counters to one workspace key.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: TEXT_FIELD,
            report: { type: 'json', required: true, description: 'Full status report payload.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args) => {
        const report = engine.statusReport(args.workspace)
        const lines = [
          `Plan store: ${report.total} plan(s), ${report.archived} archived, ${report.phaseCount} phase(s), ${report.taskCount} task(s).`,
          `- by status: ${Object.entries(report.byStatus).map(([key, value]) => `${key}=${value}`).join(', ')}`,
          `- tasks: ${Object.entries(report.byTaskStatus).map(([key, value]) => `${key}=${value}`).join(', ')}`,
          `- database: ${report.dbPath}`,
          `- export dir: ${report.exportDir}`,
          `- full-text search: ${report.fts ? 'FTS5' : 'LIKE fallback'}`,
        ]
        if (report.stale.length > 0) {
          lines.push(`- stale plans: ${report.stale.map((plan) => `${plan.id} (${plan.title})`).join(', ')}`)
        }
        lines.push(
          `- render cost: ${charsLabel(report.notesChars)} characters of task notes in the reported plans`,
        )
        if (report.largest.some((plan) => plan.notesChars > 0)) {
          lines.push(
            `- largest: ${report.largest
              .filter((plan) => plan.notesChars > 0)
              .map((plan) => `${plan.id} (~${charsLabel(plan.chars)} chars, ${charsLabel(plan.notesChars)} of notes)`)
              .join(', ')}`,
          )
        }
        return {
          text: lines.join('\n'),
          report: {
            root: report.root,
            dbPath: report.dbPath,
            exportDir: report.exportDir,
            total: report.total,
            archived: report.archived,
            byStatus: { ...report.byStatus },
            byTaskStatus: { ...report.byTaskStatus },
            phaseCount: report.phaseCount,
            taskCount: report.taskCount,
            notesChars: report.notesChars,
            largest: report.largest.map((plan) => summaryJson(plan)),
            stale: report.stale.map((plan) => summaryJson(plan)),
            fts: report.fts,
          },
        }
      },
    }),
  )
  return registered
}

/** Session id of a tool execution, when the host exposes one. */
function sessionIdOf(exec: { agent?: { id?: unknown } }): string | null {
  const id = exec.agent?.id
  return id === undefined || id === null ? null : String(id)
}
