/**
 * dsh settings integration: host half of the plugin configuration.
 *
 * The namespace is registered with the native settings provider so every
 * user-editable field is persisted and hot-reloaded into the running plugin.
 * Startup-only profile fields are intentionally absent from this schema and
 * live only in the plugin composition config. The settings card itself is a
 * separate client-side plugin keyed by this namespace; nothing here renders UI.
 *
 * @module dsh-plan-store/dsh/settings
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

import {
  DEFAULT_CONFIG,
  DEFAULT_SYSTEM_PROMPT,
  mergeConfig,
  type PlanStoreConfig,
} from '../core/config.js'
import type { PlanEngine } from '../core/engine.js'

/** Settings namespace owned by this plugin (lowercase, hyphenated). */
export const SETTINGS_NAMESPACE = 'dsh-plan-store'

/** Native Settings schema, containing only user-editable fields. */
export const PlanStoreSettingsSchema = z.object({
  storageRoot: z
    .string()
    .default(DEFAULT_CONFIG.storageRoot)
    .description('Plan store directory. Empty uses $DSH_HOME/plan-store (default ~/.dsh/plan-store).'),
  webPath: z
    .string()
    .default(DEFAULT_CONFIG.webPath)
    .description('Base HTTP path of the plugin API and the kanban board.'),
  exportDir: z
    .string()
    .default(DEFAULT_CONFIG.exportDir)
    .description('Export directory relative to the workspace root (default .dsh/plans).'),
  autoExport: z
    .boolean()
    .default(DEFAULT_CONFIG.autoExport)
    .description('Remind the agent to export a plan after it changes.'),
  promptActivePlans: z
    .boolean()
    .default(DEFAULT_CONFIG.promptActivePlans)
    .description('Include a compact summary of the active plans in the system prompt.'),
  promptActiveLimit: z
    .number()
    .min(0)
    .step(1)
    .default(DEFAULT_CONFIG.promptActiveLimit)
    .description('Maximum number of plans listed in that summary (0 disables it).'),
  stalePlanDays: z
    .number()
    .min(1)
    .step(1)
    .default(DEFAULT_CONFIG.stalePlanDays)
    .description('Age in days after which an untouched plan is reported as stale.'),
  syncTodos: z
    .boolean()
    .default(DEFAULT_CONFIG.syncTodos)
    .description('Mirror the touched plan into the session todo panel after every plan change.'),
  syncGoal: z
    .boolean()
    .default(DEFAULT_CONFIG.syncGoal)
    .description('Mirror the touched plan into the session goal (created disarmed) after every plan change.'),
  todoParallelInProgress: z
    .boolean()
    .default(DEFAULT_CONFIG.todoParallelInProgress)
    .description('Allow several in-progress items in the mirrored todo list (one at a time when off).'),
  todoMaxItems: z
    .number()
    .min(1)
    .step(1)
    .default(DEFAULT_CONFIG.todoMaxItems)
    .description('Maximum number of todo items mirrored from one plan.'),
  systemPrompt: z
    .string()
    .default(DEFAULT_SYSTEM_PROMPT)
    .description('System-prompt guidance injected for the agent. Editable in settings.'),
})

/** Full plugin schema: native Settings fields plus startup-only profile fields. */
export const PlanStorePluginConfigSchema = z.object({
  ...PlanStoreSettingsSchema.dict,
  sessionStartGuide: z
    .boolean()
    .default(DEFAULT_CONFIG.sessionStartGuide)
    .description('Inject the short session-start guide; disable when a richer system prompt is always available.'),
})

/** Resolved value of the plugin settings namespace. */
export type PlanStoreSettings = ReturnType<typeof PlanStoreSettingsSchema>

/** Project the resolved engine config onto the settings shape. */
function toSettings(config: PlanStoreConfig): PlanStoreSettings {
  return {
    storageRoot: config.storageRoot,
    webPath: config.webPath,
    exportDir: config.exportDir,
    autoExport: config.autoExport,
    promptActivePlans: config.promptActivePlans,
    promptActiveLimit: config.promptActiveLimit,
    stalePlanDays: config.stalePlanDays,
    syncTodos: config.syncTodos,
    syncGoal: config.syncGoal,
    todoParallelInProgress: config.todoParallelInProgress,
    todoMaxItems: config.todoMaxItems,
    systemPrompt: config.systemPrompt,
  }
}

/** Merge a settings value over the defaults. */
function fromSettings(next: PlanStoreSettings, current: PlanStoreConfig): PlanStoreConfig {
  return mergeConfig({
    storageRoot: next.storageRoot,
    webPath: next.webPath,
    exportDir: next.exportDir,
    autoExport: next.autoExport,
    promptActivePlans: next.promptActivePlans,
    promptActiveLimit: next.promptActiveLimit,
    stalePlanDays: next.stalePlanDays,
    syncTodos: next.syncTodos,
    syncGoal: next.syncGoal,
    todoParallelInProgress: next.todoParallelInProgress,
    todoMaxItems: next.todoMaxItems,
    systemPrompt: next.systemPrompt,
    sessionStartGuide: current.sessionStartGuide,
  })
}

/**
 * Copy resolved values into a live config object that the tools, the prompt
 * provider and the engine read on every call, so a settings change takes effect
 * without a restart. `storageRoot` is applied for reporting only: the SQLite
 * store already owns its directory, so a root change needs a plugin restart.
 */
function applyConfig(target: PlanStoreConfig, next: PlanStoreConfig): void {
  target.webPath = next.webPath
  target.exportDir = next.exportDir
  target.autoExport = next.autoExport
  target.promptActivePlans = next.promptActivePlans
  target.promptActiveLimit = next.promptActiveLimit
  target.stalePlanDays = next.stalePlanDays
  target.syncTodos = next.syncTodos
  target.syncGoal = next.syncGoal
  target.todoParallelInProgress = next.todoParallelInProgress
  target.todoMaxItems = next.todoMaxItems
  target.systemPrompt = next.systemPrompt
  // `sessionStartGuide` is startup-only; changing it requires a plugin reload.
}

/** Log a warning through the Cordis logger, falling back to the console. */
function warnSettings(ctx: Context, message: string): void {
  try {
    ctx.logger.warn(message)
  } catch {
    console.warn(`[dsh-plan-store] ${message}`)
  }
}

/**
 * Register the plugin settings namespace (host half) and hot-reload changes
 * into the live configuration object.
 *
 * @param ctx - context carrying the `settings` service.
 * @param engine - live engine whose own config backs the prompt and the reports.
 * @param config - shared resolved config read by the tools and the prompt section.
 */
export function registerPlanSettings(ctx: Context, engine: PlanEngine, config: PlanStoreConfig): void {
  let scope: SettingsScope<PlanStoreSettings>
  try {
    scope = ctx.settings.register(SETTINGS_NAMESPACE, PlanStoreSettingsSchema, {
      base: toSettings(config),
      applies: 'live',
    })
  } catch (error) {
    warnSettings(ctx, `Settings namespace "${SETTINGS_NAMESPACE}" was not registered: ${String(error)}`)
    return
  }

  const apply = (next: PlanStoreSettings): void => {
    const merged = fromSettings(next, config)
    if (merged.storageRoot !== config.storageRoot) {
      warnSettings(
        ctx,
        'storageRoot changed: the plan store keeps its current database until the plugin restarts.',
      )
    }
    applyConfig(config, merged)
    applyConfig(engine.config, merged)
  }

  try {
    scope.watch((next) => apply(next))
  } catch (error) {
    warnSettings(ctx, `Settings watcher for "${SETTINGS_NAMESPACE}" was not installed: ${String(error)}`)
  }

  apply(scope.get())
}
