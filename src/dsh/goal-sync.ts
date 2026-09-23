/**
 * Automatic session-goal sync for plans.
 *
 * A plan is the durable "what to do"; the session goal (`ctx.goals`) is the
 * model-facing "objective of this session" rendered in the chat. This module
 * keeps them aligned: a live plan becomes the session objective
 * (`Complete the plan: <title>`), and a plan that is finished or archived
 * removes it again.
 *
 * Two deliberate properties:
 *
 * - **Disarmed by default.** `ctx.goals.create` produces an armed goal, and the
 *   goal-round driver then keeps re-prompting the agent ("Continue working
 *   toward the objective") until the round cap (256 by default) is reached. The
 *   mirror only exists to make the objective visible, so it disarms the goal
 *   right after creating it; `update_goal action=resume` arms it on purpose.
 * - **Foreign goals are untouched.** A goal whose objective does not carry this
 *   plugin's prefix belongs to the user or to another plugin and is left alone.
 *
 * Every operation is best-effort: a host without `ctx.goals`, a session without
 * a live agent and a rejected mutation all degrade to `false` instead of failing
 * the plan tool.
 *
 * @module dsh-plan-store/dsh/goal-sync
 */
import type { Context } from '@deepseek-ai/cordis'

import type { PlanStoreConfig } from '../core/config.js'
import type { PlanTree } from '../core/types.js'
import { readService, sessionAgentId } from './session.js'

/** Prefix of the objectives owned by this plugin. */
export const GOAL_PREFIX = 'Complete the plan: '

/** Structural view of one goal as returned by `ctx.goals`. */
export interface GoalViewLike {
  id: string
  revision: number
  objective: string
  phase: string
}

/** Compare-and-set reference of one goal. */
export interface GoalRefLike {
  id: string
  revision: number
}

/** Structural view of `ctx.goals` limited to what this module needs. */
export interface GoalServiceLike {
  get(agent: unknown): GoalViewLike | undefined | null
  create(agent: unknown, request: { objective: string; maxGoalRounds?: number }): GoalViewLike
  edit(agent: unknown, ref: GoalRefLike, request: { objective?: string; maxGoalRounds?: number }): GoalViewLike
  clear(agent: unknown, ref: GoalRefLike): unknown
  disarm(agent: unknown): unknown
}

/** Structural view of `ctx.agents`. */
export interface AgentRegistryLike {
  get(id: string): unknown
}

/** Objective this plugin writes for one plan. */
export function goalObjective(tree: PlanTree): string {
  return `${GOAL_PREFIX}${tree.title}`
}

/** Whether a goal belongs to this plugin. */
export function isOwnGoal(view: GoalViewLike | undefined | null): view is GoalViewLike {
  return (
    view !== undefined &&
    view !== null &&
    typeof view.objective === 'string' &&
    view.objective.startsWith(GOAL_PREFIX)
  )
}

/** Log a warning through the Cordis logger, falling back to the console. */
function warn(ctx: Context, message: string): void {
  try {
    ctx.logger.warn(message)
  } catch {
    console.warn(`[dsh-plan-store] ${message}`)
  }
}

/**
 * Align the session goal of the calling agent with one plan.
 *
 * @param ctx - host context carrying the `goals` and `agents` services.
 * @param exec - tool execution carrying the owning agent.
 * @param tree - live plan to mirror, or `null` to only drop this plugin's goal.
 * @param config - shared configuration (toggle).
 * @returns `true` when the goal state was read and left aligned.
 */
export function syncPlanGoal(
  ctx: Context,
  exec: unknown,
  tree: PlanTree | null,
  config: PlanStoreConfig,
): boolean {
  if (!config.syncGoal) return false
  const agentId = sessionAgentId(exec)
  if (agentId === null) return false
  const registry = readService<AgentRegistryLike>(ctx, 'agents')
  const goals = readService<GoalServiceLike>(ctx, 'goals')
  if (registry === undefined || goals === undefined) return false
  let agent: unknown
  try {
    agent = registry.get(agentId)
  } catch {
    return false
  }
  if (agent === undefined || agent === null) return false

  try {
    const current = goals.get(agent) ?? null
    const finished = tree === null || tree.status === 'done' || tree.status === 'archived'
    if (finished) {
      if (isOwnGoal(current)) goals.clear(agent, { id: current.id, revision: current.revision })
      return true
    }
    const objective = goalObjective(tree)
    if (current === null || current.phase === 'complete') {
      goals.create(agent, { objective })
      // Visible, but not armed: no automatic continuation rounds.
      goals.disarm(agent)
      return true
    }
    if (isOwnGoal(current)) {
      if (current.objective !== objective) {
        goals.edit(agent, { id: current.id, revision: current.revision }, { objective })
      }
      return true
    }
    // A goal owned by the user or another plugin: leave it alone.
    return false
  } catch (error) {
    warn(ctx, `Goal sync failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
