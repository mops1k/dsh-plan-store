import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  exportPlanToWorkspace,
  generatedMarker,
  isOwnedBy,
  renderPlanMarkdown,
  resolveExportPath,
} from '../src/core/export'
import { makeHarness, type TestHarness } from './helpers'

let harness: TestHarness

beforeEach(() => {
  harness = makeHarness()
})

afterEach(() => {
  harness.cleanup()
})

/** Create a plan with a small tree and return its id. */
function seedPlan(title = 'Export me'): string {
  const created = harness.engine.createPlan({
    title,
    description: 'Rendered from the database',
    workspace: 'demo',
    workspaceRoot: harness.workspace,
    priority: 'urgent',
    tags: ['ui'],
    phases: [
      { title: 'Core', notes: 'phase note', tasks: [{ title: 'first', notes: 'line one\nline two', links: ['src/index.ts'] }] },
      { title: 'Polish', tasks: [{ title: 'second', status: 'doing' }] },
    ],
  })
  const first = created.phases[0]!.tasks[0]!
  harness.engine.updateTask(first.id, { status: 'done' })
  return created.id
}

describe('renderPlanMarkdown', () => {
  it('renders the marker, metadata, phases and checkboxes', () => {
    const id = seedPlan()
    const tree = harness.engine.requireTree(id)
    const markdown = renderPlanMarkdown(tree, '2026-09-23T12:00:00.000Z')

    expect(markdown.startsWith(generatedMarker(id))).toBe(true)
    expect(markdown).toContain('# Export me')
    expect(markdown).toContain('Rendered from the database')
    expect(markdown).toContain('- Status: active')
    expect(markdown).toContain('- Priority: urgent')
    expect(markdown).toContain('- Workspace: demo')
    expect(markdown).toContain('- Tags: ui')
    expect(markdown).toContain('- Progress: 1/2 tasks (50%)')
    expect(markdown).toContain('- Exported: 2026-09-23T12:00:00.000Z by dsh-plan-store')
    expect(markdown).toContain('## Phase 1: Core')
    expect(markdown).toContain('phase note')
    expect(markdown).toContain('- [x] first')
    expect(markdown).toContain('  line one')
    expect(markdown).toContain('  - src/index.ts')
    expect(markdown).toContain('- [ ] second _(doing)_')
    expect(markdown.endsWith('\n')).toBe(true)
  })

  it('renders a plan without phases', () => {
    const created = harness.engine.createPlan({ title: 'Empty' })
    const markdown = renderPlanMarkdown(harness.engine.requireTree(created.id), '2026-09-23T12:00:00.000Z')
    expect(markdown).toContain('_No phases._')
    expect(markdown).toContain('- Progress: 0/0 tasks (0%)')
  })
})

describe('exportPlanToWorkspace', () => {
  it('creates the directory, writes the file and rewrites only its own file', () => {
    const id = seedPlan()
    const tree = harness.engine.requireTree(id)
    const first = exportPlanToWorkspace(tree, {
      workspaceRoot: harness.workspace,
      exportDir: '.kilo/plans',
      exportedAt: '2026-09-23T12:00:00.000Z',
    })
    expect(first.created).toBe(true)
    expect(first.path).toBe(join(harness.workspace, '.kilo/plans/export-me.md'))
    expect(existsSync(first.path)).toBe(true)
    expect(isOwnedBy(first.path, id)).toBe(true)

    const second = exportPlanToWorkspace({ ...tree, description: 'Second revision' }, {
      workspaceRoot: harness.workspace,
      exportDir: '.kilo/plans',
    })
    expect(second.path).toBe(first.path)
    expect(second.created).toBe(false)
    expect(readFileSync(second.path, 'utf8')).toContain('Second revision')
  })

  it('never clobbers a hand-written file and falls back to a suffixed name', () => {
    const directory = join(harness.workspace, '.kilo/plans')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'export-me.md'), '# hand written\n', 'utf8')

    const id = seedPlan()
    const tree = harness.engine.requireTree(id)
    expect(resolveExportPath(tree, directory)).toBe(join(directory, `export-me-${id.replace(/[^a-zA-Z0-9]+/gu, '')}.md`))

    const result = exportPlanToWorkspace(tree, { workspaceRoot: harness.workspace, exportDir: '.kilo/plans' })
    expect(result.path).not.toBe(join(directory, 'export-me.md'))
    expect(readFileSync(join(directory, 'export-me.md'), 'utf8')).toBe('# hand written\n')
  })

  it('keeps the recorded path after a rename', () => {
    const id = seedPlan()
    const exported = harness.engine.exportPlan(id)
    const renamed = harness.engine.updatePlan(id, { title: 'Completely different title' })
    expect(renamed.exportPath).toBe(exported.path)

    const again = harness.engine.exportPlan(id)
    expect(again.path).toBe(exported.path)
    expect(existsSync(exported.path)).toBe(true)
  })

  it('rejects an empty workspace root', () => {
    const id = seedPlan()
    expect(() => exportPlanToWorkspace(harness.engine.requireTree(id), { workspaceRoot: '  ', exportDir: '.kilo/plans' })).toThrow(/workspace root/u)
  })
})
