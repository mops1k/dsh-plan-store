/**
 * Scoped tool restriction for the lite agent preset.
 *
 * This module is mounted from an agent preset, never from the host profile:
 * `ctx.tools.restrict()` masks inherited global tools for that preset while
 * leaving the full plugin registration and HTTP/UI surfaces untouched.
 *
 * @module dsh-plan-store/tool-restrict
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { PLAN_FULL_ONLY_TOOL_NAMES } from './dsh/tools.js'

/** Stable plugin name used in diagnostics and preset inventory. */
export const name = 'dsh-plan-store-tool-restrict'

/** Required host service. */
export const inject = ['tools']

const FULL_ONLY_TOOL_SCHEMA = z.union([
  z.const('plan_delete'),
  z.const('plan_purge'),
  z.const('plan_phase_delete'),
  z.const('plan_task_delete'),
  z.const('plan_status'),
  z.const('plan_import_session'),
])

/** Scoped restriction configuration. */
export const Config = z.object({
  deny: z.array(FULL_ONLY_TOOL_SCHEMA).default([...PLAN_FULL_ONLY_TOOL_NAMES]),
})

/** Resolved restriction configuration. */
export type Config = ReturnType<typeof Config>

/** Apply the restriction to the calling scoped agent/preset context. */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.restrict({ deny: [...config.deny] })
}
