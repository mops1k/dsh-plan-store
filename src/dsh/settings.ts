/**
 * dsh settings integration: host half of the plugin configuration.
 *
 * Since dsh 0.2.0 a plugin's settings *are* its Loader config:
 * {@link PlanStorePluginConfigSchema} is exported as the plugin `Config`, the
 * values live in the profile patch, and cordis applies an edit by re-activating
 * the fiber with the new config — so there is no namespace to register and no
 * scope to watch here. What this function still owns is the page policy:
 * whether the editor may autogenerate a settings page for this instance.
 * Startup-only profile fields stay in the composition config.
 *
 * @module dsh-plan-store/dsh/settings
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

import { DEFAULT_CONFIG, DEFAULT_SYSTEM_PROMPT } from '../core/config.js'

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

/** Log a warning through the Cordis logger, falling back to the console. */
function warnSettings(ctx: Context, message: string): void {
  try {
    ctx.logger.warn(message)
  } catch {
    console.warn(`[dsh-plan-store] ${message}`)
  }
}

/**
 * Register this plugin instance's settings page policy.
 *
 * The values themselves come from the Loader config and are applied by cordis
 * re-activating the plugin fiber, so nothing is watched here; the call only
 * tells the native configuration editor that it may autogenerate the page for
 * this instance. The owning fiber is passed explicitly because the service
 * would otherwise attribute the policy to its own fiber, which collides with
 * every other plugin that calls `configure` without an owner.
 *
 * @param ctx - context carrying the `settings` service.
 */
export function registerPlanSettings(ctx: Context): void {
  const forms: SettingsForms = ctx.settings
  try {
    const dispose = forms.configure({ auto: true }, ctx.fiber)
    ctx.effect(() => dispose)
  } catch (error) {
    warnSettings(ctx, `Settings page for "${SETTINGS_NAMESPACE}" was not registered: ${String(error)}`)
  }
}
