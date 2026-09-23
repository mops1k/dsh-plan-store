import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PlanError } from '../src/core/engine'
import { makeHarness, type TestHarness } from './helpers'

let harness: TestHarness

beforeEach(() => {
  harness = makeHarness()
})

afterEach(() => {
  harness.cleanup()
})

describe('createPlan', () => {
  it('creates the tree with phases, tasks and a journal entry', () => {
    const tree = harness.engine.createPlan({
      title: 'Kanban board',
      description: 'Plans in the database',
      workspace: 'demo',
      priority: 'high',
      tags: ['ui', 'ui', ' db '],
      phases: [
        { title: 'Core', tasks: ['schema', { title: 'engine', status: 'doing' }] },
        { title: 'UI', tasks: [{ title: 'board' }] },
      ],
    })

    expect(tree.id).toMatch(/^p_[0-9a-f]{12}$/)
    expect(tree.status).toBe('active')
    expect(tree.priority).toBe('high')
    expect(tree.tags).toEqual(['ui', 'db'])
    expect(tree.phases).toHaveLength(2)
    expect(tree.phases[0]?.tasks).toHaveLength(2)
    expect(tree.phases[0]?.tasks[0]?.title).toBe('schema')
    expect(tree.phases[0]?.progress).toMatchObject({ total: 2, doing: 1, todo: 1, percent: 0 })
    expect(tree.phases[0]?.status).toBe('doing')
    expect(tree.progress.total).toBe(3)
    expect(tree.events.map((event) => event.kind)).toContain('created')
  })

  it('rejects a blank title and unknown values', () => {
    expect(() => harness.engine.createPlan({ title: '   ' })).toThrow(PlanError)
    expect(() => harness.engine.createPlan({ title: 'x', priority: 'someday' as never })).toThrow(/priority/u)
    expect(() => harness.engine.createPlan({ title: 'x', status: 'nope' as never })).toThrow(/status/u)
  })

  it('reports a missing plan as not found', () => {
    expect(() => harness.engine.requireTree('p_missing')).toThrow(PlanError)
    expect(harness.engine.getPlan('p_missing')).toBeNull()
  })
})

describe('task status automation', () => {
  it('activates the plan on the first doing task and finishes it when all tasks are done', () => {
    const created = harness.engine.createPlan({ title: 'Ship it', phases: [{ title: 'Work', tasks: ['a', 'b'] }] })
    const phase = created.phases[0]
    const first = phase?.tasks[0]
    const second = phase?.tasks[1]
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    const started = harness.engine.updateTask(first!.id, { status: 'doing' })
    expect(started.status).toBe('active')
    expect(started.events[0]?.data).toMatchObject({ automatic: true })

    const finished = harness.engine.updateTask(first!.id, { status: 'done' })
    expect(finished.status).toBe('active')
    expect(finished.phases[0]?.tasks[0]?.completedAt).not.toBeNull()

    const allDone = harness.engine.updateTask(second!.id, { status: 'done' })
    expect(allDone.status).toBe('done')
    expect(allDone.progress.percent).toBe(100)
  })

  it('reopens a finished plan and clears completed_at', () => {
    const created = harness.engine.createPlan({ title: 'Reopen', phases: [{ title: 'Work', tasks: ['a'] }] })
    const taskId = created.phases[0]!.tasks[0]!.id
    harness.engine.updateTask(taskId, { status: 'done' })
    expect(harness.engine.requireTree(created.id).status).toBe('done')

    const reopened = harness.engine.updateTask(taskId, { status: 'todo' })
    expect(reopened.status).toBe('active')
    expect(reopened.phases[0]?.tasks[0]?.completedAt).toBeNull()
  })

  it('never overwrites a manual blocked or archived status', () => {
    const created = harness.engine.createPlan({ title: 'Blocked', phases: [{ title: 'Work', tasks: ['a'] }] })
    const taskId = created.phases[0]!.tasks[0]!.id
    harness.engine.updatePlan(created.id, { status: 'blocked' })
    expect(harness.engine.updateTask(taskId, { status: 'done' }).status).toBe('blocked')

    const archived = harness.engine.archivePlan(created.id)
    expect(archived.status).toBe('archived')
    expect(archived.archivedAt).not.toBeNull()
    harness.engine.updateTask(taskId, { status: 'todo' })
    expect(harness.engine.requireTree(created.id).status).toBe('archived')
  })
})

describe('phase status automation', () => {
  it('follows the tasks of its phase', () => {
    const created = harness.engine.createPlan({ title: 'Phases', phases: [{ title: 'Work', tasks: ['a', 'b'] }] })
    const first = created.phases[0]!.tasks[0]!
    const second = created.phases[0]!.tasks[1]!

    const started = harness.engine.updateTask(first.id, { status: 'doing' })
    expect(started.phases[0]?.status).toBe('doing')

    const halfway = harness.engine.updateTask(first.id, { status: 'done' })
    expect(halfway.phases[0]?.status).toBe('doing')

    const allDone = harness.engine.updateTask(second.id, { status: 'done' })
    expect(allDone.phases[0]?.status).toBe('done')
    expect(allDone.phases[0]?.progress.percent).toBe(100)

    const reopened = harness.engine.updateTask(second.id, { status: 'todo' })
    expect(reopened.phases[0]?.status).toBe('todo')
  })

  it('keeps a manually blocked phase and tracks tasks moving between phases', () => {
    const created = harness.engine.createPlan({
      title: 'Phases two',
      phases: [{ title: 'One', tasks: ['a'] }, { title: 'Two', tasks: ['b'] }],
    })
    const one = created.phases[0]!
    const two = created.phases[1]!
    harness.engine.updatePhase(one.id, { status: 'blocked' })

    const afterBlocked = harness.engine.updateTask(one.tasks[0]!.id, { status: 'done' })
    expect(afterBlocked.phases.find((phase) => phase.id === one.id)?.status).toBe('blocked')

    const moved = harness.engine.moveTask(two.tasks[0]!.id, { phaseId: one.id, status: 'doing' })
    expect(moved.phases.find((phase) => phase.id === one.id)?.status).toBe('blocked')
    expect(moved.phases.find((phase) => phase.id === two.id)?.status).toBe('todo')
  })
})

describe('phases and tasks', () => {
  it('adds, reorders and deletes phases and tasks', () => {
    const created = harness.engine.createPlan({ title: 'Structure', phases: [{ title: 'First' }] })
    const firstPhase = created.phases[0]!.id

    const withSecond = harness.engine.addPhase(created.id, { title: 'Second', tasks: ['task'] })
    expect(withSecond.phases.map((phase) => phase.title)).toEqual(['First', 'Second'])

    const moved = harness.engine.updatePhase(withSecond.phases[1]!.id, { position: 0 })
    expect(moved.phases.map((phase) => phase.title)).toEqual(['Second', 'First'])

    const withTask = harness.engine.addTask(created.id, { title: 'loose task', phaseId: firstPhase })
    const firstPhaseTree = withTask.phases.find((phase) => phase.id === firstPhase)
    expect(firstPhaseTree?.tasks.map((task) => task.title)).toEqual(['loose task'])

    const updated = harness.engine.updateTask(firstPhaseTree!.tasks[0]!.id, {
      title: 'renamed',
      notes: 'note',
      links: ['src/index.ts'],
    })
    const task = updated.phases.find((phase) => phase.id === firstPhase)?.tasks[0]
    expect(task?.title).toBe('renamed')
    expect(task?.links).toEqual(['src/index.ts'])

    const afterPhaseDelete = harness.engine.deletePhase(firstPhase)
    expect(afterPhaseDelete.phases.map((phase) => phase.title)).toEqual(['Second'])
    expect(afterPhaseDelete.phases[0]?.tasks.map((item) => item.title)).toEqual(['task'])

    const afterTaskDelete = harness.engine.deleteTask(afterPhaseDelete.phases[0]!.tasks[0]!.id)
    expect(afterTaskDelete.phases[0]?.tasks).toHaveLength(0)
  })

  it('creates a default phase for tasks without one', () => {
    const created = harness.engine.createPlan({ title: 'Loose' })
    const withTask = harness.engine.addTask(created.id, { title: 'first' })
    expect(withTask.phases).toHaveLength(1)
    expect(withTask.phases[0]?.title).toBe('Tasks')
  })

  it('rejects a phase that belongs to another plan', () => {
    const a = harness.engine.createPlan({ title: 'A', phases: [{ title: 'PA', tasks: ['a'] }] })
    const b = harness.engine.createPlan({ title: 'B', phases: [{ title: 'PB', tasks: ['b'] }] })
    const taskOfA = a.phases[0]!.tasks[0]!.id
    const phaseOfB = b.phases[0]!.id
    expect(() => harness.engine.updateTask(taskOfA, { phaseId: phaseOfB })).toThrow(/does not belong/u)
    expect(() => harness.engine.moveTask(taskOfA, { phaseId: phaseOfB })).toThrow(/does not belong/u)
  })

  it('moves a task between cells with an explicit position', () => {
    const created = harness.engine.createPlan({
      title: 'Board',
      phases: [{ title: 'One', tasks: ['a', 'b'] }, { title: 'Two', tasks: ['c'] }],
    })
    const first = created.phases[0]!.tasks[0]!
    const secondPhase = created.phases[1]!

    const moved = harness.engine.moveTask(first.id, { status: 'doing', phaseId: secondPhase.id, position: 0 })
    const target = moved.phases[1]
    expect(target?.tasks.map((task) => task.id)).toContain(first.id)
    expect(target?.tasks.find((task) => task.id === first.id)?.status).toBe('doing')
    expect(target?.progress.doing).toBe(1)
    expect(moved.status).toBe('active')
  })
})

describe('archive, restore and purge', () => {
  it('archives, restores and purges with confirmation', () => {
    const created = harness.engine.createPlan({ title: 'Lifecycle', phases: [{ title: 'P', tasks: ['t'] }] })

    const archived = harness.engine.archivePlan(created.id)
    expect(archived.status).toBe('archived')
    expect(harness.engine.listPlans({}).plans).toHaveLength(0)
    expect(harness.engine.listPlans({ includeArchived: true }).plans).toHaveLength(1)

    const restored = harness.engine.restorePlan(created.id)
    expect(restored.status).toBe('backlog')
    expect(restored.archivedAt).toBeNull()

    expect(() => harness.engine.purgePlan(created.id, false)).toThrow(/confirm/u)
    expect(harness.engine.purgePlan(created.id, true)).toBe(true)
    expect(harness.engine.getPlan(created.id)).toBeNull()
    expect(harness.engine.events(created.id)).toHaveLength(0)
  })

  it('journals archive and status changes', () => {
    const created = harness.engine.createPlan({ title: 'Journal' })
    harness.engine.updatePlan(created.id, { description: 'details' })
    harness.engine.updatePlan(created.id, { status: 'active' })
    harness.engine.archivePlan(created.id)
    const kinds = harness.engine.events(created.id, 10).map((event) => event.kind)
    expect(kinds).toContain('updated')
    expect(kinds).toContain('status')
    expect(kinds).toContain('archived')
  })
})

describe('session archiving', () => {
  it('archives every plan of one session and leaves the others alone', () => {
    const mine = harness.engine.createPlan({ title: 'Mine', phases: [{ title: 'P', tasks: ['t'] }] }, { sessionId: 's-1' })
    const other = harness.engine.createPlan({ title: 'Other' }, { sessionId: 's-2' })
    const loose = harness.engine.createPlan({ title: 'Loose' })

    const archived = harness.engine.archiveSessionPlans('s-1')
    expect(archived).toEqual([mine.id])
    expect(harness.engine.requireTree(mine.id).status).toBe('archived')
    expect(harness.engine.requireTree(other.id).status).toBe('backlog')
    expect(harness.engine.requireTree(loose.id).status).toBe('backlog')

    // idempotent: nothing left to archive
    expect(harness.engine.archiveSessionPlans('s-1')).toEqual([])
    expect(harness.engine.archiveSessionPlans('')).toEqual([])
  })

  it('syncs the plans with the host archive set', () => {
    const one = harness.engine.createPlan({ title: 'One' }, { sessionId: 's-1' })
    const two = harness.engine.createPlan({ title: 'Two' }, { sessionId: 's-2' })
    const three = harness.engine.createPlan({ title: 'Three' }, { sessionId: 's-3' })

    expect(harness.engine.syncArchivedSessions([])).toEqual([])
    const affected = harness.engine.syncArchivedSessions(['s-3', 's-missing'])
    expect(affected).toEqual([three.id])
    expect(harness.engine.requireTree(three.id).status).toBe('archived')
    expect(harness.engine.requireTree(one.id).status).toBe('backlog')
    expect(harness.engine.requireTree(two.id).status).toBe('backlog')
    // a second sync is a no-op
    expect(harness.engine.syncArchivedSessions(['s-3'])).toEqual([])
  })

  it('reports the archived session ids through the store', () => {
    harness.engine.createPlan({ title: 'A' }, { sessionId: 's-1' })
    harness.engine.createPlan({ title: 'B' }, { sessionId: 's-2' })
    expect(harness.engine.store.listActivePlanSessionIds().sort()).toEqual(['s-1', 's-2'])
    harness.engine.archiveSessionPlans('s-1')
    expect(harness.engine.store.listActivePlanSessionIds()).toEqual(['s-2'])
  })
})

describe('listing, search and reporting', () => {
  it('summarizes plans with progress and the next task', () => {
    const created = harness.engine.createPlan({
      title: 'Summary',
      workspace: 'demo',
      phases: [{ title: 'Work', tasks: ['todo task', 'doing task', 'done task'] }],
    })
    const tasks = created.phases[0]!.tasks
    harness.engine.updateTask(tasks[1]!.id, { status: 'doing' })
    harness.engine.updateTask(tasks[2]!.id, { status: 'done' })

    const summary = harness.engine.listPlans({ workspace: 'demo' }).plans[0]
    expect(summary?.progress).toMatchObject({ total: 3, doing: 1, done: 1, todo: 1, percent: 33 })
    expect(summary?.nextTask?.title).toBe('doing task')
    expect(summary?.phaseCount).toBe(1)
    expect(summary?.taskCount).toBe(3)
  })

  it('searches through the engine', () => {
    harness.engine.createPlan({ title: 'Kanban board', phases: [{ title: 'Work', tasks: ['drag cards'] }] })
    expect(harness.engine.searchPlans('kanban')).toHaveLength(1)
    expect(harness.engine.searchPlans('drag')[0]?.kind).toBe('task')
  })

  it('reports counters, staleness and the FTS state', () => {
    let current = new Date('2026-09-01T00:00:00.000Z')
    const clocked = makeHarness({ stalePlanDays: 14 }, () => current)
    try {
      const fresh = clocked.engine.createPlan({ title: 'Fresh', workspace: 'demo' })
      clocked.engine.createPlan({ title: 'Archived', workspace: 'demo' })
      clocked.engine.archivePlan(clocked.engine.listPlans({ workspace: 'demo' }).plans[1]!.id)

      current = new Date('2026-09-30T00:00:00.000Z')
      const report = clocked.engine.statusReport('demo')
      expect(report.total).toBe(2)
      expect(report.archived).toBe(1)
      expect(report.byStatus.active + report.byStatus.backlog).toBe(1)
      expect(report.stale.map((plan) => plan.id)).toEqual([fresh.id])
      expect(report.fts).toBe(true)
      expect(report.dbPath).toContain('plans.db')
    } finally {
      clocked.cleanup()
    }
  })

  it('builds the compact prompt summary', () => {
    const created = harness.engine.createPlan({ title: 'Active plan', workspace: 'demo', phases: [{ title: 'Work', tasks: ['a', 'b'] }] })
    harness.engine.updateTask(created.phases[0]!.tasks[0]!.id, { status: 'doing' })
    harness.engine.createPlan({ title: 'Backlog plan', workspace: 'demo' })

    const lines = harness.engine.promptSummary('demo', 5)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[active] Active plan')
    expect(lines[0]).toContain('0/2 tasks')
    expect(lines[0]).toContain('next: a')
    expect(harness.engine.promptSummary('demo', 0)).toEqual([])
  })
})

describe('export', () => {
  it('writes the plan into .dsh/plans and journals the path', () => {
    const created = harness.engine.createPlan({
      title: 'Export me',
      workspaceRoot: harness.workspace,
      phases: [{ title: 'Work', tasks: ['first', 'second'] }],
    })
    harness.engine.updateTask(created.phases[0]!.tasks[1]!.id, { status: 'done' })

    const result = harness.engine.exportPlan(created.id)
    expect(result.path).toBe(join(harness.workspace, '.dsh/plans/export-me.md'))
    expect(existsSync(result.path)).toBe(true)
    const markdown = readFileSync(result.path, 'utf8')
    expect(markdown).toContain('- [ ] first')
    expect(markdown).toContain('- [x] second')
    expect(result.tree.exportPath).toBe(result.path)
    expect(result.tree.events.map((event) => event.kind)).toContain('export')
  })

  it('refuses to export a plan without a workspace root', () => {
    const created = harness.engine.createPlan({ title: 'Nowhere' })
    expect(() => harness.engine.exportPlan(created.id)).toThrow(/workspace root/u)
  })
})
