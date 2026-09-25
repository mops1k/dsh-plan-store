import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { PLAN_TOOL_NAMES, registerPlanTools } from '../src/dsh/tools'
import { makeHarness, type TestHarness } from './helpers'

interface ToolHarness {
  ctx: Context
  tools: Map<string, ToolDefinition>
  warnings: string[]
}

/** Build a host context whose tool registry records definitions. */
function makeToolHarness(sessionCwd: string | null, failOn: readonly string[] = []): ToolHarness {
  const tools = new Map<string, ToolDefinition>()
  const warnings: string[] = []
  const ctx = {
    logger: { warn: (message: string) => warnings.push(message) },
    tools: {
      register(definition: ToolDefinition): void {
        if (failOn.includes(definition.name)) throw new Error('already owned')
        tools.set(definition.name, definition)
      },
    },
    sessions: {
      get: () => (sessionCwd === null ? undefined : { header: { cwd: sessionCwd } }),
    },
  } as unknown as Context
  return { ctx, tools, warnings }
}

const EXEC = { agent: { id: 'agent-1' } } as never

/** Run one registered tool and return its canonical value. */
async function call(tools: Map<string, ToolDefinition>, name: string, args: unknown): Promise<Record<string, unknown>> {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  return (await definition.execute(args, EXEC)) as Record<string, unknown>
}

let harness: TestHarness

beforeEach(() => {
  harness = makeHarness()
})

afterEach(() => {
  harness.cleanup()
})

describe('registration', () => {
  it('registers the exact full tool set by default', () => {
    const { ctx, tools } = makeToolHarness(harness.workspace)
    const registered = registerPlanTools(ctx, harness.engine, harness.config)
    expect([...registered].sort()).toEqual([...PLAN_TOOL_NAMES].sort())
    expect([...tools.keys()].sort()).toEqual([...PLAN_TOOL_NAMES].sort())
  })

  it('skips a tool whose name is already owned and warns', () => {
    const { ctx, tools, warnings } = makeToolHarness(harness.workspace, ['plan_create', 'plan_purge'])
    const registered = registerPlanTools(ctx, harness.engine, harness.config)
    expect(registered).not.toContain('plan_create')
    expect(registered).not.toContain('plan_purge')
    expect(registered).toHaveLength(14)
    expect(warnings).toHaveLength(2)
    expect(tools.has('plan_list')).toBe(true)
  })
})

describe('plan_create', () => {
  it('binds the plan to the session workspace and renders the tree', async () => {
    const { ctx, tools } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    const value = await call(tools, 'plan_create', {
      title: 'Kanban board',
      description: 'Plans in the database',
      tags: ['ui'],
      phases: [{ title: 'Core', tasks: ['schema', 'engine'] }],
    })

    expect(String(value['text'])).toContain('Kanban board')
    expect(String(value['text'])).toContain('## Phase 1: Core')
    const plan = value['plan'] as Record<string, unknown>
    expect(plan['workspace']).toBe(join(harness.workspace).split('/').pop())
    expect(plan['workspaceRoot']).toBe(harness.workspace)
    expect(plan['tags']).toEqual(['ui'])
    expect(value['progress']).toMatchObject({ total: 2, todo: 2, percent: 0 })
  })

  it('accepts rich task objects with notes, status and links', async () => {
    const { ctx, tools } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    const value = await call(tools, 'plan_create', {
      title: 'Rich plan',
      phases: [
        {
          title: 'Core',
          notes: 'phase notes',
          tasks: [
            'plain title',
            { title: 'rich task', notes: 'why it matters', status: 'doing', links: ['README.md'] },
          ],
        },
      ],
    })
    const plan = value['plan'] as { phases: Array<{ notes: string; tasks: Array<Record<string, unknown>> }> }
    expect(plan.phases[0]?.notes).toBe('phase notes')
    const rich = plan.phases[0]?.tasks[1]
    expect(rich?.['notes']).toBe('why it matters')
    expect(rich?.['status']).toBe('doing')
    expect(rich?.['links']).toEqual(['README.md'])
    expect(plan.phases[0]?.tasks[0]?.['title']).toBe('plain title')
  })

  it('falls back to the no-workspace key without a session store', async () => {
    const { ctx, tools } = makeToolHarness(null)
    registerPlanTools(ctx, harness.engine, harness.config)
    const value = await call(tools, 'plan_create', { title: 'Loose plan' })
    const plan = value['plan'] as Record<string, unknown>
    expect(plan['workspace']).toBe('_no-workspace')
    expect(plan['workspaceRoot']).toBe('')
  })

  it('rejects a blank title', async () => {
    const { ctx, tools } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    await expect(call(tools, 'plan_create', { title: '   ' })).rejects.toThrow(/title is required/u)
  })
})

describe('task and phase mutations', () => {
  it('marks a task done and completes the plan automatically', async () => {
    const { ctx, tools } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    const created = await call(tools, 'plan_create', { title: 'Ship', phases: [{ title: 'Work', tasks: ['a'] }] })
    const plan = created['plan'] as { id: string; phases: Array<{ id: string; tasks: Array<{ id: string }> }> }
    const taskId = plan.phases[0]!.tasks[0]!.id

    const updated = await call(tools, 'plan_task_update', { id: taskId, status: 'done' })
    const tree = updated['plan'] as { status: string; progress: { percent: number } }
    expect(tree.status).toBe('done')
    expect(tree.progress.percent).toBe(100)
    expect(String(updated['text'])).toContain('- [x] a')
  })

  it('adds phases and tasks and moves a task between them', async () => {
    const { ctx, tools } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    const created = await call(tools, 'plan_create', { title: 'Board' })
    const planId = (created['plan'] as { id: string }).id

    const withPhase = await call(tools, 'plan_phase_add', { planId, title: 'Core', tasks: ['schema'] })
    const phase = (withPhase['plan'] as { phases: Array<{ id: string; tasks: Array<{ id: string }> }> }).phases[0]!
    expect(phase.tasks).toHaveLength(1)

    const withTask = await call(tools, 'plan_task_add', { planId, title: 'docs', phaseId: phase.id, links: ['README.md'] })
    const tasks = (withTask['plan'] as { phases: Array<{ tasks: Array<{ id: string; links: string[] }> }> }).phases[0]!.tasks
    expect(tasks).toHaveLength(2)
    expect(tasks[1]?.links).toEqual(['README.md'])

    const renamed = await call(tools, 'plan_phase_update', { id: phase.id, title: 'Core work', status: 'doing' })
    const updatedPhase = (renamed['plan'] as { phases: Array<{ title: string; status: string }> }).phases[0]!
    expect(updatedPhase.title).toBe('Core work')
    expect(updatedPhase.status).toBe('doing')

    const afterDelete = await call(tools, 'plan_task_delete', { id: tasks[1]!.id })
    expect((afterDelete['plan'] as { phases: Array<{ tasks: unknown[] }> }).phases[0]!.tasks).toHaveLength(1)

    const afterPhaseDelete = await call(tools, 'plan_phase_delete', { id: phase.id })
    expect((afterPhaseDelete['plan'] as { phases: unknown[] }).phases).toHaveLength(0)
  })
})

describe('listing, search and status', () => {
  it('renders list rows and search hits', async () => {
    const { ctx, tools } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    await call(tools, 'plan_create', { title: 'Kanban board', phases: [{ title: 'Core', tasks: ['drag cards'] }] })

    const list = await call(tools, 'plan_list', {})
    expect(String(list['text'])).toContain('Kanban board')
    expect(list['count']).toBe(1)

    const search = await call(tools, 'plan_search', { query: 'drag' })
    expect(search['count']).toBe(1)
    const hits = search['hits'] as Array<Record<string, unknown>>
    expect(hits[0]?.['kind']).toBe('task')

    const status = await call(tools, 'plan_status', {})
    expect(String(status['text'])).toContain('Plan store: 1 plan(s)')
    expect(String((status['report'] as Record<string, unknown>)['dbPath'])).toContain('plans.db')
  })
})

describe('archive, purge and export', () => {
  it('archives, restores and purges with an explicit confirmation', async () => {
    const { ctx, tools } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    const created = await call(tools, 'plan_create', { title: 'Lifecycle' })
    const planId = (created['plan'] as { id: string }).id

    const archived = await call(tools, 'plan_delete', { id: planId })
    expect((archived['plan'] as { status: string }).status).toBe('archived')
    expect((await call(tools, 'plan_list', {})).count).toBe(0)
    expect((await call(tools, 'plan_list', { includeArchived: true })).count).toBe(1)

    const restored = await call(tools, 'plan_update', { id: planId, status: 'backlog' })
    expect((restored['plan'] as { status: string }).status).toBe('backlog')

    await expect(call(tools, 'plan_purge', { id: planId, confirm: false })).rejects.toThrow(/confirm/u)
    const purged = await call(tools, 'plan_purge', { id: planId, confirm: true })
    expect(purged['purged']).toBe(true)
  })

  it('exports the plan into the session workspace', async () => {
    const { ctx, tools } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    const created = await call(tools, 'plan_create', { title: 'Export me', phases: [{ title: 'Work', tasks: ['a'] }] })
    const planId = (created['plan'] as { id: string }).id

    const exported = await call(tools, 'plan_export', { id: planId })
    const path = String(exported['path'])
    expect(path).toBe(join(harness.workspace, '.dsh/plans/export-me.md'))
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('- [ ] a')

    const custom = await call(tools, 'plan_export', { id: planId, exportDir: 'plans/custom' })
    expect(String(custom['path'])).toBe(join(harness.workspace, 'plans/custom/export-me.md'))
  })

  it('reports a missing plan as an error', async () => {
    const { ctx, tools } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    await expect(call(tools, 'plan_get', { id: 'p_missing' })).rejects.toThrow(/not found/u)
    await expect(call(tools, 'plan_task_update', { id: 't_missing', status: 'done' })).rejects.toThrow(/not found/u)
  })
})
