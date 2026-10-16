import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
    const { ctx, tools, warnings } = makeToolHarness(harness.workspace, ['plan_create', 'plan_delete'])
    const registered = registerPlanTools(ctx, harness.engine, harness.config)
    expect(registered).not.toContain('plan_create')
    expect(registered).not.toContain('plan_delete')
    expect(registered).toHaveLength(PLAN_TOOL_NAMES.length - 2)
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

  it('reports the rendering size of an expensive plan', async () => {
    const { ctx, tools } = makeToolHarness(null)
    registerPlanTools(ctx, harness.engine, harness.config)
    const tasks = Array.from({ length: 10 }, (_, index) => ({ title: `task ${index}`, notes: 'n'.repeat(1000) }))
    await call(tools, 'plan_create', { title: 'Heavy plan', phases: [{ title: 'Work', tasks }] })

    const list = await call(tools, 'plan_list', {})
    expect(String(list['text'])).toContain('tree: ~11k chars (10k notes)')
    const rows = list['plans'] as Array<Record<string, unknown>>
    expect(rows[0]?.['notesChars']).toBe(10000)
    expect(Number(rows[0]?.['chars'])).toBeGreaterThan(10000)

    const status = await call(tools, 'plan_status', {})
    expect(String(status['text'])).toContain('render cost: 10k characters of task notes')
    expect(String(status['text'])).toContain('largest: ')
    const report = status['report'] as Record<string, unknown>
    expect(report['notesChars']).toBe(10000)
    expect(report['largest']).toHaveLength(1)
  })

  it('keeps a cheap row free of the size hint', async () => {
    const { ctx, tools } = makeToolHarness(null)
    registerPlanTools(ctx, harness.engine, harness.config)
    await call(tools, 'plan_create', { title: 'Light plan', phases: [{ title: 'Work', tasks: ['a'] }] })
    const list = await call(tools, 'plan_list', {})
    expect(String(list['text'])).not.toContain('tree: ~')
    const status = await call(tools, 'plan_status', {})
    expect(String(status['text'])).not.toContain('largest: ')
  })
})

describe('automatic export', () => {
  it('writes the markdown after a mutation and names the path in the result', async () => {
    const { ctx, tools } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    const created = await call(tools, 'plan_create', { title: 'Auto export', phases: [{ title: 'Work', tasks: ['a'] }] })
    const path = join(harness.workspace, '.dsh/plans/auto-export.md')
    expect(String(created['text'])).toContain(`Exported: ${path}`)
    expect(readFileSync(path, 'utf8')).toContain('- [ ] a')

    const plan = created['plan'] as { phases: Array<{ tasks: Array<{ id: string }> }> }
    const updated = await call(tools, 'plan_task_update', { id: plan.phases[0]!.tasks[0]!.id, status: 'done' })
    expect(String(updated['text'])).toContain(`Exported: ${path}`)
    expect(readFileSync(path, 'utf8')).toContain('- [x] a')
    expect((updated['plan'] as { exportPath: string }).exportPath).toBe(path)
  })

  it('records no export journal event, while the explicit call still does', async () => {
    const { ctx, tools } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    const created = await call(tools, 'plan_create', { title: 'Quiet journal' })
    const planId = (created['plan'] as { id: string }).id
    expect(harness.engine.events(planId, 20).map((event) => event.kind)).not.toContain('export')

    await call(tools, 'plan_export', { id: planId })
    expect(harness.engine.events(planId, 20).map((event) => event.kind)).toContain('export')
  })

  it('stays quiet when autoExport is off', async () => {
    harness.config.autoExport = false
    const { ctx, tools } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    const created = await call(tools, 'plan_create', { title: 'No file' })
    expect(String(created['text'])).not.toContain('Exported:')
    expect(existsSync(join(harness.workspace, '.dsh/plans/no-file.md'))).toBe(false)
  })

  it('skips the export without a workspace root', async () => {
    const { ctx, tools } = makeToolHarness(null)
    registerPlanTools(ctx, harness.engine, harness.config)
    const created = await call(tools, 'plan_create', { title: 'Loose plan' })
    expect(String(created['text'])).not.toContain('Exported:')
  })

  it('keeps the mutation successful and warns when the export fails', async () => {
    // A `.dsh` regular file blocks creating the export directory inside it.
    writeFileSync(join(harness.workspace, '.dsh'), 'not a directory')
    const { ctx, tools, warnings } = makeToolHarness(harness.workspace)
    registerPlanTools(ctx, harness.engine, harness.config)
    const created = await call(tools, 'plan_create', { title: 'Broken export' })
    expect((created['plan'] as { title: string }).title).toBe('Broken export')
    expect(String(created['text'])).not.toContain('Exported:')
    expect(warnings.some((warning) => warning.includes('Automatic export'))).toBe(true)
  })
})

describe('bounded plan_get', () => {
  /** Create a plan with `count` tasks whose notes are `noteChars` long. */
  async function makeBigPlan(tools: Map<string, ToolDefinition>, count: number, noteChars: number) {
    const tasks = Array.from({ length: count }, (_, index) => ({ title: `task ${index}`, notes: 'n'.repeat(noteChars) }))
    const created = await call(tools, 'plan_create', { title: 'Big plan', phases: [{ title: 'Work', tasks }] })
    const plan = created['plan'] as { id: string; phases: Array<{ tasks: Array<{ id: string }> }> }
    return { created, planId: plan.id, taskIds: plan.phases[0]!.tasks.map((task) => task.id) }
  }

  it('keeps every task id while clipping the notes of a large plan', async () => {
    const { ctx, tools } = makeToolHarness(null)
    registerPlanTools(ctx, harness.engine, harness.config)
    const { planId, taskIds } = await makeBigPlan(tools, 60, 400)

    const value = await call(tools, 'plan_get', { id: planId })
    const text = String(value['text'])
    expect(text.length).toBeLessThan(6500)
    for (const id of taskIds) expect(text).toContain(id)
    expect(text).toContain('note/link line(s) clipped')

    const unbounded = await call(tools, 'plan_get', { id: planId, maxChars: 0 })
    expect(String(unbounded['text']).length).toBeGreaterThan(20000)
  })

  it('caps the plan_create echo with the same budget', async () => {
    const { ctx, tools } = makeToolHarness(null)
    registerPlanTools(ctx, harness.engine, harness.config)
    const { created } = await makeBigPlan(tools, 60, 400)
    expect(String(created['text']).length).toBeLessThan(6500)
  })

  it('reads one task in full through taskId', async () => {
    const { ctx, tools } = makeToolHarness(null)
    registerPlanTools(ctx, harness.engine, harness.config)
    const { planId, taskIds } = await makeBigPlan(tools, 3, 3000)

    const value = await call(tools, 'plan_get', { id: planId, taskId: taskIds[1] })
    const text = String(value['text'])
    expect(text).toContain('n'.repeat(3000))
    expect(text).toContain(taskIds[1])
    expect(text).not.toContain(taskIds[0]!)
    expect((value['plan'] as { phases: unknown[] }).phases).toHaveLength(1)
  })

  it('reads one phase through phaseId and reports unknown ids', async () => {
    const { ctx, tools } = makeToolHarness(null)
    registerPlanTools(ctx, harness.engine, harness.config)
    const { planId, taskIds } = await makeBigPlan(tools, 2, 100)
    const plan = (await call(tools, 'plan_get', { id: planId }))['plan'] as { phases: Array<{ id: string }> }

    const value = await call(tools, 'plan_get', { id: planId, phaseId: plan.phases[0]!.id })
    expect(String(value['text'])).toContain(taskIds[0])
    await expect(call(tools, 'plan_get', { id: planId, taskId: 't_missing' })).rejects.toThrow(/Task not found/u)
    await expect(call(tools, 'plan_get', { id: planId, phaseId: 'ph_missing' })).rejects.toThrow(/Phase not found/u)
  })
})

describe('archive, purge and export', () => {
  it('archives and restores a plan', async () => {
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
