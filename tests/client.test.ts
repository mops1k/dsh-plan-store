import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import * as React from 'react'

/** One module passed to the dsh client module loader. */
interface LoadedModule {
  id: string
  factory: (require: (name: string) => unknown) => Record<string, unknown>
}

/** One slot registration captured from the client plugin. */
interface RegisteredSlot {
  name: string
  id: string
  order?: number
  label?: () => string
  component: unknown
}

/**
 * Evaluate the classic browser bundle against a stub module loader. `react`
 * defaults to the real React; the markup test passes a hook stub instead, so a
 * component can be called without a renderer.
 */
function loadClient(
  react: unknown = React,
): { loaded: LoadedModule[]; exported: Record<string, unknown> } {
  const code = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')
  const loaded: LoadedModule[] = []
  const windowStub = {
    __ModuleLoader__: {
      load(module: LoadedModule): void {
        loaded.push(module)
      },
    },
  }
  const run = new Function('window', 'document', code) as (window: unknown, document: unknown) => void
  run(windowStub, undefined)
  const module = loaded[0]
  if (module === undefined) throw new Error('the client bundle registered no module')
  const exported = module.factory((name: string) => {
    if (name === 'react') return react
    throw new Error(`unexpected module request: ${name}`)
  })
  return { loaded, exported }
}

/** Build a host context that records slot registrations. */
function makeClientContext(settings: unknown): { ctx: unknown; slots: RegisteredSlot[] } {
  const slots: RegisteredSlot[] = []
  const ctx = {
    remote: { settings },
    slots: {
      inject(_name: string, callback: () => void): void {
        callback()
      },
      register(options: RegisteredSlot, component: unknown): () => void {
        slots.push({ ...options, component })
        return () => {}
      },
    },
  }
  return { ctx, slots }
}

/** The pure collapse helpers the client exposes for the tests. */
interface ClientInternals {
  phaseIsComplete(phase: unknown): boolean
  phaseCollapsed(phaseOpen: Record<string, boolean>, phase: unknown): boolean
}

/** Read the helpers the bundle exposes next to `apply`/`inject`. */
function internalsOf(exported: Record<string, unknown>): ClientInternals {
  const internals = exported['internals'] as ClientInternals | undefined
  if (internals === undefined) throw new Error('the client bundle exposes no internals')
  return internals
}

/** One phase as the board receives it from the HTTP API. */
function apiPhase(id: string, total: number, done: number): unknown {
  return {
    id,
    title: id,
    status: total > 0 && done === total ? 'done' : 'doing',
    progress: { total, done, todo: 0, doing: 0, blocked: 0, percent: total === 0 ? 0 : (done / total) * 100 },
  }
}

/** One namespace view as the settings remote returns it. */
function namespaceView(revision: number): unknown {
  return { ns: 'dsh-plan-store', value: { webPath: '/plan-store' }, revision, applies: 'live' }
}

/** Working `ctx.remote.settings` stub (dsh >= 0.1.7-rc.2). */
function workingSettings(): unknown {
  return {
    describe: async () => ({ ok: true, value: { writable: true, hasDocument: false, namespaces: [namespaceView(1)] } }),
    update: async () => ({ ok: true, value: namespaceView(2) }),
  }
}

describe('client bundle', () => {
  it('registers one module under the plugin id', () => {
    const { loaded, exported } = loadClient()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.id).toBe('dsh-plan-store')
    expect(typeof exported['apply']).toBe('function')
    expect(exported['inject']).toEqual(['slots', 'sessions', 'remote', 'remote.settings'])
  })

  it('registers the board view, the goals view and the settings card', () => {
    const { exported } = loadClient()
    const { ctx, slots } = makeClientContext(workingSettings())
    ;(exported['apply'] as (context: unknown) => void)(ctx)

    expect(slots.map((slot) => slot.name)).toEqual([
      'conversation.view',
      'conversation.view',
      'settings.section',
    ])
    expect(slots.map((slot) => slot.id)).toEqual(['plan-board', 'goals-todos', 'plan-board'])
    expect(slots.every((slot) => typeof slot.component === 'function')).toBe(true)
    expect(slots[0]?.label?.()).toBe('Plan Board')
    expect(slots[1]?.label?.()).toBe('Goals & Todos')
    expect(slots[0]?.order).toBe(40)
    expect(slots[1]?.order).toBe(41)
  })

  it('defaults the board workspace filter to the session project', () => {
    const code = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')
    expect(code).toContain('sessionWorkspace')
    expect(code).toContain('workspaceChosen')
    expect(code).toContain('setWorkspaceChosen(true)')
    // the board resolves the current session through the sessions service
    expect(code).toContain('createBoardView(ctx, scope)')
  })

  it('styles controls and expanded selects with the dsh design tokens', () => {
    const code = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')
    // The closed control, its dropdown menu and the text colors must come from
    // the dsh tokens, otherwise the native popup falls back to white-on-light.
    expect(code).toContain('--dsw-specific-menu')
    expect(code).toContain('--dsw-alias-bg-layer-1')
    expect(code).toContain('--dsw-alias-label-primary')
    expect(code).toContain('--dsw-alias-border-l2')
    expect(code).toContain('style: S.option')
    expect(code).not.toContain('--vscode-editor-background')
  })

  it('still applies when the settings remote is unavailable', () => {
    const { exported } = loadClient()
    const { ctx, slots } = makeClientContext(undefined)
    expect(() => (exported['apply'] as (context: unknown) => void)(ctx)).not.toThrow()
    expect(slots).toHaveLength(3)
  })

  it('still applies when the settings read is refused', async () => {
    const { exported } = loadClient()
    const refused = {
      describe: async () => ({ ok: false, error: { code: 'settings/rejected', message: 'read refused' } }),
      update: async () => ({ ok: false, error: { code: 'settings/rejected', message: 'write refused' } }),
    }
    const { ctx, slots } = makeClientContext(refused)
    expect(() => (exported['apply'] as (context: unknown) => void)(ctx)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(slots).toHaveLength(3)
  })
})

/** One element created by the hook stub below. */
interface StubElement {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/** Flatten a created element tree to text; function components are skipped. */
function flattenTree(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenTree).join('')
  const element = node as StubElement
  if (typeof element.type === 'function') return ''
  const title = typeof element.props?.['title'] === 'string' ? element.props['title'] + ' ' : ''
  const children = Array.isArray(element.children) ? element.children : []
  return title + children.map(flattenTree).join('')
}

/** Whether a `useState` seed is the board data state, not a filter or a toggle. */
function isBoardData(value: unknown): boolean {
  const candidate = value as { plans?: unknown; total?: unknown } | null
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    Array.isArray(candidate.plans) &&
    candidate.total === 0
  )
}

/** One plan with a finished and a running phase, as the HTTP API returns it. */
function boardPlan(): unknown {
  return {
    id: 'p_board',
    title: 'Board plan',
    description: '',
    status: 'active',
    priority: 'normal',
    workspace: 'demo',
    tags: [],
    progress: { total: 4, done: 2, todo: 1, doing: 1, blocked: 0, percent: 50 },
    phases: [
      {
        id: 'ph_finished',
        title: 'Finished phase',
        status: 'done',
        notes: 'finished notes',
        progress: { total: 2, done: 2, todo: 0, doing: 0, blocked: 0, percent: 100 },
        tasks: [
          { id: 't_done', title: 'done task', status: 'done', notes: '', links: [], position: 0 },
        ],
      },
      {
        id: 'ph_running',
        title: 'Running phase',
        status: 'doing',
        notes: 'running notes',
        progress: { total: 2, done: 0, todo: 1, doing: 1, blocked: 0, percent: 0 },
        tasks: [
          { id: 't_open', title: 'open task', status: 'doing', notes: '', links: [], position: 0 },
        ],
      },
    ],
  }
}

/**
 * Render the Plan Board and return its markup as text. The board loads its
 * plans in an effect, which a plain function call does not run, so the React
 * stub seeds the board state whose default is an empty list.
 */
function renderBoardWithPhases(): string {
  const data = { plans: [boardPlan()], total: 1, workspaces: [] }
  const ReactStub = {
    Fragment: Symbol('Fragment'),
    createElement: (type: unknown, props: unknown, ...children: unknown[]): StubElement => ({
      type,
      props: (props ?? {}) as Record<string, unknown>,
      children,
    }),
    useState: (initial: unknown): [unknown, () => void] => [isBoardData(initial) ? data : initial, () => {}],
    useEffect: (): void => {},
    useMemo: (factory: () => unknown): unknown => factory(),
    useCallback: (callback: unknown): unknown => callback,
    useRef: (value: unknown): { current: unknown } => ({ current: value }),
  }
  const { exported } = loadClient(ReactStub)
  const { ctx, slots } = makeClientContext(workingSettings())
  ;(exported['apply'] as (context: unknown) => void)(ctx)
  const board = slots.find((slot) => slot.name === 'conversation.view' && slot.id === 'plan-board')
  const component = board?.component as ((props: Record<string, unknown>) => unknown) | undefined
  if (component === undefined) throw new Error('the board view is not registered')
  return flattenTree(component())
}

describe('phase collapse', () => {
  const internals = internalsOf(loadClient().exported)

  it('counts a phase as complete only with tasks, all of them done', () => {
    expect(internals.phaseIsComplete(apiPhase('ph_full', 3, 3))).toBe(true)
    expect(internals.phaseIsComplete(apiPhase('ph_partial', 3, 2))).toBe(false)
    expect(internals.phaseIsComplete(apiPhase('ph_empty', 0, 0))).toBe(false)
    expect(internals.phaseIsComplete({ id: 'ph_no_progress' })).toBe(false)
    expect(internals.phaseIsComplete(null)).toBe(false)
  })

  it('collapses a finished phase and keeps running and empty phases open', () => {
    expect(internals.phaseCollapsed({}, apiPhase('ph_done', 2, 2))).toBe(true)
    expect(internals.phaseCollapsed({}, apiPhase('ph_running', 2, 1))).toBe(false)
    expect(internals.phaseCollapsed({}, apiPhase('ph_empty', 0, 0))).toBe(false)
  })

  it('lets the explicit user choice win over the automatic default', () => {
    // The user opened a finished phase: it stays open.
    expect(internals.phaseCollapsed({ ph_done: true }, apiPhase('ph_done', 2, 2))).toBe(false)
    // The user closed a running phase: it stays closed.
    expect(internals.phaseCollapsed({ ph_running: false }, apiPhase('ph_running', 2, 1))).toBe(true)
    // A choice made for another phase does not leak into this one.
    expect(internals.phaseCollapsed({ ph_other: true }, apiPhase('ph_done', 2, 2))).toBe(true)
  })

  it('renders a per-phase toggle and hides the phase body when collapsed', () => {
    const board = renderBoardWithPhases()
    // Both phase headers stay visible, each with its own toggle.
    expect(board).toContain('Finished phase')
    expect(board).toContain('Running phase')
    expect(board).toContain('Expand phase')
    expect(board).toContain('Collapse phase')
    // The finished phase renders as a header only: no notes, no task, no columns.
    expect(board).not.toContain('finished notes')
    expect(board).not.toContain('done task')
    expect(board.split('To do (').length - 1).toBe(1)
    // The running phase keeps its note and its task cards.
    expect(board).toContain('running notes')
    expect(board).toContain('open task')
  })
})
