import { existsSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PlanStore, toFtsQuery } from '../src/core/store'
import { cleanupRoot, makeTempRoot, phaseRow, planRow, taskRow } from './helpers'

let root: string
let store: PlanStore

beforeEach(() => {
  root = makeTempRoot()
  store = new PlanStore({ root })
})

afterEach(() => {
  store.close()
  cleanupRoot(root)
})

describe('schema', () => {
  it('opens lazily, creates the file and reopens the same data', () => {
    expect(existsSync(store.dbPath)).toBe(false)
    store.open()
    expect(existsSync(store.dbPath)).toBe(true)
    expect(store.ftsEnabled).toBe(true)
    store.insertPlan(planRow({ id: 'p_a' }))
    store.close()

    const reopened = new PlanStore({ root })
    expect(reopened.getPlan('p_a')?.title).toBe('Alpha plan')
    expect(reopened.ftsEnabled).toBe(true)
    reopened.close()
  })

  it('cascades plan deletion to phases, tasks and events', () => {
    store.insertPlan(planRow({ id: 'p_a' }))
    store.insertPhase(phaseRow('p_a', { id: 'ph_a' }))
    store.insertTask(taskRow('p_a', 'ph_a', { id: 't_a' }))
    store.insertEvent({
      id: 'e_a',
      planId: 'p_a',
      kind: 'created',
      message: 'created',
      data: {},
      sessionId: null,
      createdAt: '2026-09-23T10:00:00.000Z',
    })

    expect(store.deletePlanRow('p_a')).toBe(true)
    expect(store.getPlan('p_a')).toBeNull()
    expect(store.getPhase('ph_a')).toBeNull()
    expect(store.getTask('t_a')).toBeNull()
    expect(store.listEvents('p_a')).toHaveLength(0)
  })

  it('round-trips tags, links and event payloads', () => {
    store.insertPlan(planRow({ id: 'p_a', tags: ['ui', 'db'], exportPath: '/tmp/x.md' }))
    store.insertPhase(phaseRow('p_a', { id: 'ph_a' }))
    store.insertTask(taskRow('p_a', 'ph_a', { id: 't_a', links: ['src/index.ts', 'https://example.com'] }))

    const plan = store.getPlan('p_a')
    expect(plan?.tags).toEqual(['ui', 'db'])
    expect(plan?.exportPath).toBe('/tmp/x.md')
    expect(store.getTask('t_a')?.links).toEqual(['src/index.ts', 'https://example.com'])
  })
})

describe('plans', () => {
  beforeEach(() => {
    store.insertPlan(planRow({ id: 'p_a', title: 'Alpha plan', workspace: 'demo', status: 'backlog', updatedAt: '2026-09-23T10:00:00.000Z' }))
    store.insertPlan(planRow({ id: 'p_b', title: 'Beta plan', workspace: 'other', status: 'active', updatedAt: '2026-09-23T11:00:00.000Z' }))
    store.insertPlan(planRow({ id: 'p_c', title: 'Gamma plan', workspace: 'demo', status: 'archived', updatedAt: '2026-09-23T12:00:00.000Z' }))
  })

  it('applies partial updates', () => {
    expect(store.updatePlanRow('p_a', { status: 'active', updated_at: '2026-09-24T00:00:00.000Z' })).toBe(true)
    const plan = store.getPlan('p_a')
    expect(plan?.status).toBe('active')
    expect(plan?.title).toBe('Alpha plan')
    expect(plan?.updatedAt).toBe('2026-09-24T00:00:00.000Z')
  })

  it('ignores unknown columns in an update', () => {
    expect(store.updatePlanRow('p_a', { nope: 'x' })).toBe(false)
  })

  it('hides archived plans unless they are requested', () => {
    expect(store.listPlans({}).items.map((plan) => plan.id)).toEqual(['p_b', 'p_a'])
    expect(store.listPlans({ includeArchived: true }).total).toBe(3)
    expect(store.listPlans({ status: 'archived' }).items.map((plan) => plan.id)).toEqual(['p_c'])
  })

  it('filters by workspace and substring query', () => {
    expect(store.listPlans({ workspace: 'demo' }).items.map((plan) => plan.id)).toEqual(['p_a'])
    expect(store.listPlans({ query: 'beta' }).items.map((plan) => plan.id)).toEqual(['p_b'])
  })

  it('counts plans by status, optionally scoped to a workspace', () => {
    expect(store.countPlansByStatus()).toMatchObject({ backlog: 1, active: 1, archived: 1 })
    expect(store.countPlansByStatus('demo')).toMatchObject({ backlog: 1, archived: 1, active: 0 })
  })
})

describe('phases and tasks', () => {
  beforeEach(() => {
    store.insertPlan(planRow({ id: 'p_a' }))
  })

  it('assigns sequential positions', () => {
    store.insertPhase(phaseRow('p_a', { id: 'ph_1' }))
    store.insertPhase(phaseRow('p_a', { id: 'ph_2', position: store.nextPhasePosition('p_a') }))
    expect(store.nextPhasePosition('p_a')).toBe(2)
    expect(store.listPhases('p_a').map((phase) => phase.id)).toEqual(['ph_1', 'ph_2'])

    store.insertTask(taskRow('p_a', 'ph_1', { id: 't_1' }))
    store.insertTask(taskRow('p_a', 'ph_1', { id: 't_2', position: store.nextTaskPosition('ph_1', 'todo') }))
    expect(store.nextTaskPosition('ph_1', 'todo')).toBe(2)
    expect(store.listTasks('p_a').map((task) => task.id)).toEqual(['t_1', 't_2'])
  })

  it('opens a slot by shifting rows', () => {
    store.insertPhase(phaseRow('p_a', { id: 'ph_1', position: 0 }))
    store.insertPhase(phaseRow('p_a', { id: 'ph_2', position: 1 }))
    store.shiftPhases('p_a', 0)
    expect(store.listPhases('p_a').map((phase) => phase.position)).toEqual([1, 2])

    store.insertTask(taskRow('p_a', 'ph_1', { id: 't_1', position: 0 }))
    store.shiftTasks('ph_1', 'todo', 0)
    expect(store.getTask('t_1')?.position).toBe(1)
  })

  it('counts tasks by status and lists tasks for many plans', () => {
    store.insertPhase(phaseRow('p_a', { id: 'ph_1' }))
    store.insertTask(taskRow('p_a', 'ph_1', { id: 't_1', status: 'done', position: 0 }))
    store.insertTask(taskRow('p_a', 'ph_1', { id: 't_2', status: 'doing', position: 1 }))
    expect(store.countTasksByStatus()).toEqual({ todo: 0, doing: 1, blocked: 0, done: 1 })

    const grouped = store.listTasksForPlans(['p_a', 'p_missing'])
    expect(grouped.get('p_a')?.map((task) => task.id)).toEqual(['t_1', 't_2'])
    expect(store.countPhasesForPlans(['p_a']).get('p_a')).toBe(1)
  })
})

describe('search', () => {
  beforeEach(() => {
    store.insertPlan(planRow({ id: 'p_a', title: 'Kanban board', description: 'swimlanes for plans' }))
    store.insertPhase(phaseRow('p_a', { id: 'ph_1' }))
    store.insertTask(taskRow('p_a', 'ph_1', { id: 't_1', title: 'Drag and drop cards', notes: 'html5 dnd' }))
  })

  it('sanitizes a match expression', () => {
    expect(toFtsQuery('plan-store: fix!')).toBe('"plan" "store" "fix"')
    expect(toFtsQuery('!!!')).toBe('')
  })

  it('finds plans and tasks with highlighting', () => {
    const hits = store.search('kanban')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('plan')
    expect(hits[0]?.snippet.toLowerCase()).toContain('[kanban]')

    const taskHits = store.search('dnd')
    expect(taskHits).toHaveLength(1)
    expect(taskHits[0]?.kind).toBe('task')
    expect(taskHits[0]?.planId).toBe('p_a')
  })

  it('keeps the index in sync through triggers', () => {
    store.updatePlanRow('p_a', { title: 'Renamed board' })
    expect(store.search('kanban')).toHaveLength(0)
    expect(store.search('renamed')).toHaveLength(1)

    store.deleteTaskRow('t_1')
    expect(store.search('dnd')).toHaveLength(0)
  })

  it('scopes results to a workspace', () => {
    store.insertPlan(planRow({ id: 'p_b', title: 'Kanban elsewhere', workspace: 'other' }))
    expect(store.search('kanban', 'demo')).toHaveLength(1)
    expect(store.search('kanban', 'other')).toHaveLength(1)
  })

  it('falls back to LIKE search when FTS5 is unavailable', () => {
    ;(store as unknown as { fts: boolean }).fts = false
    const hits = store.search('kanban')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.id).toBe('p_a')
  })
})
