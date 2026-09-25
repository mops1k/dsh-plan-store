/**
 * System-prompt guidance, the session-start guide and the `/plans` human command.
 *
 * The prompt section carries the editable guidance plus a compact summary of the
 * active plans (bounded by `promptActiveLimit`), so the agent keeps the plan in
 * view even after a compaction. The section text is a provider, so it is
 * re-evaluated on every assembly and always reflects the current database.
 *
 * @module dsh-plan-store/dsh/context
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

import type { PlanStoreConfig } from '../core/config.js'
import type { PlanEngine } from '../core/engine.js'
import { archiveWorkspaceSession, sessionCwd } from './session.js'

/** Plugin name used as the injected-context source. */
const PLUGIN_NAME = 'dsh-plan-store'

/** Unique name of the system-prompt section contributed by this plugin. */
const PROMPT_SECTION_NAME = 'plan-store'

/** Sort order of the section (after the llm-memory section at 150). */
const PROMPT_SECTION_ORDER = 160

/** Short guide injected once when a session starts. */
export const PLAN_STORE_GUIDE = [
  'Plan store is active: plans live in the plugin database (SQLite), not in hand-written markdown.',
  '- Before starting a task, create a plan with plan_create and split it into phases and tasks.',
  '- Keep progress current: doing when you start a task, done when it is finished, blocked (with a note) when you cannot continue.',
  '- After creating or changing a plan, call plan_export so .dsh/plans/<slug>.md stays current.',
  '- The Plan Board tab in the GUI shows the kanban; /plans lists, exports and reports from the chat.',
].join('\n')

/** Describe an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Log a warning through the Cordis logger, falling back to the console. */
function warnContext(ctx: Context, message: string): void {
  try {
    ctx.logger.warn(message)
  } catch {
    console.warn(`[dsh-plan-store] ${message}`)
  }
}

/** Render the prompt section text: guidance plus the active-plan summary. */
export function promptSectionText(
  engine: PlanEngine,
  config: PlanStoreConfig,
  onError?: (message: string) => void,
): string {
  const parts: string[] = []
  const base = (config.systemPrompt ?? '').trim()
  if (base.length > 0) parts.push(base)
  if (config.promptActivePlans && config.promptActiveLimit > 0) {
    try {
      const lines = engine.promptSummary(undefined, config.promptActiveLimit)
      if (lines.length > 0) {
        parts.push(['Plans currently active or blocked in the store:', ...lines.map((line) => `- ${line}`)].join('\n'))
      }
    } catch (error) {
      onError?.(`promptSummary() failed: ${errorMessage(error)}`)
    }
  }
  return parts.join('\n\n')
}

/** Register the system-prompt section. */
function registerSystemPrompt(ctx: Context, engine: PlanEngine, config: PlanStoreConfig): void {
  const section: PromptSection = {
    name: PROMPT_SECTION_NAME,
    order: PROMPT_SECTION_ORDER,
    text: () => promptSectionText(engine, config, (message) => warnContext(ctx, message)),
  }
  try {
    ctx.systemPrompt.section(section)
  } catch (error) {
    warnContext(ctx, `System-prompt section "${PROMPT_SECTION_NAME}" was not registered: ${errorMessage(error)}`)
  }
}

/** Inject the short plan guide when an agent session starts. */
function registerSessionStartGuide(ctx: Context, enabled: boolean): void {
  if (!enabled) return
  ctx.on('agent/session-start', (payload: { agent: Agent }) => {
    try {
      payload.agent.inject(
        createUserMessage({
          content: [{ type: 'text', text: PLAN_STORE_GUIDE }],
          source: { kind: 'plugin', plugin: PLUGIN_NAME },
        }),
      )
    } catch (error) {
      warnContext(ctx, `Failed to inject the plan guide: ${errorMessage(error)}`)
    }
  })
}

/** Render the plan list for the `/plans list` subcommand. */
function listText(engine: PlanEngine): string {
  const { plans, total } = engine.listPlans({ limit: 20 })
  if (plans.length === 0) return 'No plans in the store yet.'
  const lines = plans.map((plan) => {
    const next = plan.nextTask === null ? 'no open task' : `next: ${plan.nextTask.title}`
    return `- ${plan.id} · [${plan.status}] ${plan.title} — ${plan.progress.done}/${plan.progress.total} — ${next}`
  })
  lines.push('', `${plans.length} of ${total} plan(s).`)
  return lines.join('\n')
}

/** Render the status report for the `/plans status` subcommand. */
function statusText(engine: PlanEngine): string {
  const report = engine.statusReport()
  return [
    `Plan store: ${report.total} plan(s), ${report.archived} archived, ${report.phaseCount} phase(s), ${report.taskCount} task(s).`,
    `- by status: ${Object.entries(report.byStatus).map(([key, value]) => `${key}=${value}`).join(', ')}`,
    `- database: ${report.dbPath}`,
    `- full-text search: ${report.fts ? 'FTS5' : 'LIKE fallback'}`,
  ].join('\n')
}

/**
 * Execute the `/plans` command without sending anything to the model.
 *
 * @param invocation - the settled command invocation (raw input).
 * @param ctx - host context, used to resolve the session workspace.
 * @param engine - engine used for listing, exporting and reporting.
 * @returns the command result rendered by the dispatching UI.
 */
export async function runPlanCommand(
  invocation: CommandInvocation,
  ctx: Context,
  engine: PlanEngine,
): Promise<CommandResult> {
  const raw = invocation.rawInput.trim()
  const [sub = 'list', ...rest] = raw.length === 0 ? [] : raw.split(/\s+/u)
  try {
    if (sub === 'list') return { kind: 'success', text: listText(engine) }
    if (sub === 'status') return { kind: 'success', text: statusText(engine) }
    if (sub === 'archive-session') {
      const sessionId = invocation.agent === undefined ? '' : String(invocation.agent.id ?? '')
      if (sessionId.length === 0) {
        return { kind: 'error', text: 'Cannot archive: the invocation carries no session id.' }
      }
      const sessionArchived = await archiveWorkspaceSession(ctx, sessionId)
      const archived = engine.archiveSessionPlans(sessionId)
      const plans =
        archived.length === 0
          ? 'no active plan belonged to it'
          : `archived ${archived.length} plan(s): ${archived.join(', ')}`
      return {
        kind: 'success',
        text: sessionArchived
          ? `Session archived; ${plans}.`
          : `This profile cannot archive the session itself; ${plans}.`,
      }
    }
    if (sub === 'export') {
      const cwd = sessionCwd(ctx, { agent: invocation.agent })
      if (cwd === null) return { kind: 'error', text: 'Cannot export: the session has no working directory.' }
      const id = rest[0]
      if (id !== undefined && id.length > 0) {
        const result = engine.exportPlan(id, { workspaceRoot: cwd })
        return { kind: 'success', text: `Exported ${id} to ${result.path}.` }
      }
      const { plans } = engine.listPlans({ limit: 200 })
      if (plans.length === 0) return { kind: 'success', text: 'No plans to export.' }
      const written: string[] = []
      for (const plan of plans) {
        try {
          written.push(engine.exportPlan(plan.id, { workspaceRoot: cwd }).path)
        } catch (error) {
          written.push(`${plan.id}: ${errorMessage(error)}`)
        }
      }
      return { kind: 'success', text: `Exported ${written.length} plan(s):\n${written.join('\n')}` }
    }
    return {
      kind: 'error',
      text: `Unknown plans subcommand "${sub}". Use list, export [id], archive-session or status.`,
    }
  } catch (error) {
    return { kind: 'error', text: errorMessage(error) }
  }
}

/** Register the `/plans` human command when the commands service is present. */
function registerPlanCommand(ctx: Context, engine: PlanEngine): void {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['commands'], (commandCtx) => {
    try {
      commandCtx.commands.register({
        name: 'plans',
        description: 'List, export, archive or inspect the plans of the plan store.',
        input: { hint: 'list | export [id] | archive-session | status' },
        handler: (invocation) => runPlanCommand(invocation, ctx, engine),
      })
    } catch (error) {
      warnContext(ctx, `Failed to register the "plans" command: ${errorMessage(error)}`)
    }
  })
}

/** Register the system-prompt section (requires the `systemPrompt` service). */
export function registerPlanPrompt(ctx: Context, engine: PlanEngine, config: PlanStoreConfig): void {
  registerSystemPrompt(ctx, engine, config)
}

/** Register the session-start guide and the `/plans` command. */
export function registerPlanContext(
  ctx: Context,
  engine: PlanEngine,
  config: Pick<PlanStoreConfig, 'sessionStartGuide'> = { sessionStartGuide: true },
): void {
  registerSessionStartGuide(ctx, config.sessionStartGuide)
  registerPlanCommand(ctx, engine)
}
