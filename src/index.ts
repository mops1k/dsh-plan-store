/**
 * dsh-plan-store — database-backed plan store for DeepSeek Harness.
 *
 * The plugin wires host capabilities: the model-facing `plan_*` tools, the
 * system-prompt section with the active-plan summary, the session-start guide,
 * the `/plans` human command and dsh settings. Storage and domain logic live in
 * `src/core`; the kanban board and its HTTP API are added on top of the same
 * engine.
 *
 * @module dsh-plan-store
 */
import type { Context } from '@deepseek-ai/cordis'

import { mergeConfig } from './core/config.js'
import { PlanEngine } from './core/engine.js'
import { PlanStore } from './core/store.js'
import { registerPlanContext, registerPlanPrompt } from './dsh/context.js'
import { PlanStoreSettingsSchema, registerPlanSettings } from './dsh/settings.js'
import { registerPlanTools } from './dsh/tools.js'
import { registerPlanWeb } from './dsh/web.js'

/** Stable plugin name used in logs and as the settings/config namespace. */
export const name = 'dsh-plan-store'

/** Services this plugin requires before `apply` is called. */
export const inject = ['tools']

/**
 * Plugin configuration schema (schemastery). Shared verbatim with the native
 * settings namespace, so the composition config and the user-editable settings
 * stay in sync (see `dsh/settings.ts`).
 */
export const Config = PlanStoreSettingsSchema

/** Resolved plugin configuration. */
export type Config = ReturnType<typeof Config>

/** Log a warning through the Cordis logger, falling back to the console. */
function warn(ctx: Context, message: string): void {
  try {
    ctx.logger.warn(message)
  } catch {
    console.warn(`[dsh-plan-store] ${message}`)
  }
}

/**
 * Activate the plugin: build the plan runtime and register every host
 * capability. Optional services are wired through `ctx.inject` so the plugin
 * also works in headless profiles.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = mergeConfig(config)
  const store = new PlanStore({
    root: resolved.storageRoot,
    log: (message) => warn(ctx, message),
  })
  const engine = new PlanEngine({
    store,
    config: resolved,
    log: (message) => warn(ctx, message),
  })
  ctx.effect(() => () => engine.close())

  registerPlanTools(ctx, engine, resolved)
  registerPlanContext(ctx, engine)

  ctx.inject(['systemPrompt'], (promptCtx) => registerPlanPrompt(promptCtx, engine, resolved))
  ctx.inject(['settings'], (settingsCtx) => registerPlanSettings(settingsCtx, engine, resolved))
  ctx.inject(['webServer'], (webCtx) => registerPlanWeb(webCtx, engine, resolved))
}
