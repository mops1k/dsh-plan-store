/**
 * Plugin configuration: defaults, the resolved shape shared by the tools, the
 * system-prompt section, the web API and the settings namespace.
 *
 * `PlanStoreConfig` is a mutable object on purpose: the settings namespace
 * copies live values into the same instance so a settings change takes effect
 * without restarting the plugin (the SQLite store keeps its own directory).
 *
 * @module dsh-plan-store/core/config
 */
import { DEFAULT_EXPORT_DIR, resolveStorageRoot } from './paths.js'

/** Default system-prompt guidance injected while the plugin is active. */
export const DEFAULT_SYSTEM_PROMPT = [
  'Plan store: plans live in the plugin database (SQLite), not in hand-written markdown files.',
  '- Before starting a task, create a plan with `plan_create` and split it into phases and tasks.',
  '- Keep progress current: set a task to `doing` when you start it, `done` when it is finished, and `blocked` (with a note) when you cannot continue.',
  '- The plan tools run autonomously: never ask the user to confirm; only `plan_purge` needs `confirm: true`.',
  '- After creating or changing a plan, call `plan_export` so the workspace keeps `.dsh/plans/<slug>.md` with checkboxes — the global rules require that file.',
  '- Never write or edit `.dsh/plans/*.md` by hand: `plan_export` regenerates the file from the database.',
  '- Stay cheap: `plan_get` is the only tool that returns the full tree; `plan_list` and `plan_search` answer lookups, and the database (not the exported file) is the source of truth, so there is no need to read the file back.',
  '- The kanban board (`Plan Board`) in the web GUI shows plans as swimlanes and task statuses as columns.',
].join('\n')

/** Resolved plugin configuration. */
export interface PlanStoreConfig {
  /** Storage root; empty means `$DSH_HOME/plan-store`. */
  storageRoot: string
  /** Base HTTP path of the plugin API. */
  webPath: string
  /** Export directory relative to the workspace root. */
  exportDir: string
  /** Remind the agent to export a plan after it changes. */
  autoExport: boolean
  /** Include a compact summary of active plans in the system prompt. */
  promptActivePlans: boolean
  /** Maximum number of plans listed in that summary. */
  promptActiveLimit: number
  /** Age in days after which an untouched plan counts as stale. */
  stalePlanDays: number
  /** Mirror the touched plan into the calling session's todo panel. */
  syncTodos: boolean
  /** Allow several `in_progress` items in the mirrored todo list. */
  todoParallelInProgress: boolean
  /** Maximum number of todo items mirrored from one plan. */
  todoMaxItems: number
  /** Editable system-prompt guidance. */
  systemPrompt: string
}

/** Built-in defaults. */
export const DEFAULT_CONFIG: PlanStoreConfig = {
  storageRoot: '',
  webPath: '/plan-store',
  exportDir: DEFAULT_EXPORT_DIR,
  autoExport: true,
  promptActivePlans: true,
  promptActiveLimit: 5,
  stalePlanDays: 14,
  syncTodos: true,
  todoParallelInProgress: false,
  todoMaxItems: 25,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

/** Clamp an integer option into its supported range. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.trunc(parsed)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/** Normalize the export directory into a relative, slash-only path. */
function normalizeExportDir(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw.length === 0) return fallback
  const stripped = raw.replace(/^[/\\]+/u, '').replace(/[/\\]+$/u, '')
  return stripped.length === 0 ? fallback : stripped
}

/** Merge partial input over the defaults and validate every field. */
export function mergeConfig(input?: Partial<PlanStoreConfig> | null): PlanStoreConfig {
  const source = input ?? {}
  const storageRoot = typeof source.storageRoot === 'string' ? source.storageRoot.trim() : ''
  return {
    storageRoot,
    webPath: typeof source.webPath === 'string' && source.webPath.trim().length > 0
      ? source.webPath.trim()
      : DEFAULT_CONFIG.webPath,
    exportDir: normalizeExportDir(source.exportDir, DEFAULT_CONFIG.exportDir),
    autoExport: source.autoExport !== false,
    promptActivePlans: source.promptActivePlans !== false,
    promptActiveLimit: clampInt(source.promptActiveLimit, DEFAULT_CONFIG.promptActiveLimit, 0, 20),
    stalePlanDays: clampInt(source.stalePlanDays, DEFAULT_CONFIG.stalePlanDays, 1, 3650),
    syncTodos: source.syncTodos !== false,
    todoParallelInProgress: source.todoParallelInProgress === true,
    todoMaxItems: clampInt(source.todoMaxItems, DEFAULT_CONFIG.todoMaxItems, 1, 200),
    systemPrompt:
      typeof source.systemPrompt === 'string' && source.systemPrompt.trim().length > 0
        ? source.systemPrompt
        : DEFAULT_CONFIG.systemPrompt,
  }
}

/** Resolve the storage root of a config (reporting helper). */
export function configStorageRoot(config: PlanStoreConfig): string {
  return resolveStorageRoot(config.storageRoot)
}
