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

/** One hook slot of the driver below. */
interface HookSlot {
  deps?: unknown[]
  value?: unknown
  current?: unknown
}

/** A running board instance driven without a renderer. */
interface BoardRun {
  /** Hook values in call order: 0 is the board data state, 1 the filters. */
  hooks: unknown[]
  /** Every fetch URL, in the order the calls were made. */
  requests: string[]
  /** The element tree of the last render. */
  tree(): unknown
  /** Release the pending answer of the request with that index. */
  answer(index: number): void
  /** Release every pending answer. */
  answerAll(): void
  /** Re-render with other slot props, as the host does when the session changes. */
  setProps(props: Record<string, unknown>): void
  /** Put the real fetch back. */
  restore(): void
}

/** A plan as the board consumes it, with just enough detail for the tests. */
interface LitePlan {
  id: string
  title: string
  description: string
  status: string
  priority: string
  workspace: string
  tags: string[]
  progress: { total: number; done: number; todo: number; doing: number; blocked: number; percent: number }
  phases: unknown[]
}

function apiPlanLite(id: string, workspace: string): LitePlan {
  return {
    id,
    title: id,
    description: '',
    status: 'active',
    priority: 'normal',
    workspace,
    tags: [],
    progress: { total: 0, done: 0, todo: 0, doing: 0, blocked: 0, percent: 0 },
    phases: [],
  }
}

/**
 * Minimal React with hooks, effects and re-rendering for a single component.
 * Enough for the Plan Board: no element tree rendering, no DOM.
 */
function makeHookDriver(): {
  React: Record<string, unknown>
  run(): void
  setRender(render: () => unknown): void
  hooks: unknown[]
  readTree(): unknown
} {
  const hooks: unknown[] = []
  const effects: Array<
    { deps?: unknown[]; fn: () => (() => void) | void; cleanup?: (() => void) | void; pending: boolean } | undefined
  > = []
  const memo: Array<HookSlot | undefined> = []
  let index = 0
  let scheduled = false
  let render: () => unknown = () => null
  let tree: unknown = null

  const sameDeps = (left?: unknown[], right?: unknown[]): boolean =>
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, position) => Object.is(value, right[position]))

  const run = (): void => {
    index = 0
    tree = render()
    for (const slot of effects) {
      if (slot === undefined || !slot.pending) continue
      slot.pending = false
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.cleanup = slot.fn()
    }
  }

  const rerender = (): void => {
    if (scheduled) return
    scheduled = true
    setTimeout(() => {
      scheduled = false
      run()
    }, 0)
  }

  const ReactStub = {
    Fragment: Symbol('Fragment'),
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
    useState: (initial: unknown) => {
      const slot = index++
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      const set = (value: unknown): void => {
        const next = typeof value === 'function' ? (value as (previous: unknown) => unknown)(hooks[slot]) : value
        if (!Object.is(next, hooks[slot])) {
          hooks[slot] = next
          rerender()
        }
      }
      return [hooks[slot], set]
    },
    useEffect: (fn: () => (() => void) | void, deps?: unknown[]) => {
      const slot = index++
      const previous = effects[slot]
      if (previous === undefined || deps === undefined || !sameDeps(previous.deps, deps)) {
        effects[slot] = { deps, fn, cleanup: previous?.cleanup, pending: true }
      }
    },
    useMemo: (fn: () => unknown, deps?: unknown[]) => {
      const slot = index++
      const held = memo[slot]
      if (held === undefined || !sameDeps(held.deps, deps)) memo[slot] = { deps, value: fn() }
      return memo[slot]?.value
    },
    useCallback: (fn: unknown, deps?: unknown[]) => {
      const slot = index++
      const held = memo[slot]
      if (held === undefined || !sameDeps(held.deps, deps)) memo[slot] = { deps, value: fn }
      return memo[slot]?.value
    },
    useRef: (value: unknown) => {
      const slot = index++
      if (memo[slot] === undefined) memo[slot] = { current: value }
      return memo[slot]
    },
  }

  return {
    React: ReactStub,
    run,
    setRender: (fn) => (render = fn),
    hooks,
    readTree: () => tree,
  }
}

/** Let pending promises, effects and re-renders settle. */
async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Depth-first search for a button element with that label. */
function findButton(node: unknown, label: string): (() => void) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  const element = node as { props?: Record<string, unknown>; children?: unknown[] }
  const children = Array.isArray(element.children) ? element.children : []
  if (children.length === 1 && children[0] === label && typeof element.props?.['onClick'] === 'function') {
    return element.props['onClick'] as () => void
  }
  for (const child of children) {
    const found = findButton(child, label)
    if (found !== null) return found
  }
  return null
}

/** Options of one driven slot component. */
interface ViewOptions {
  /** Registered conversation view id to mount. */
  slotId: string
  /** Standard slot props the host passes, `sessionId` above all. */
  props?: Record<string, unknown>
  /** Body of `/api/session/state`, told which session was requested. */
  sessionState: (requestedSession: string | null) => unknown
  /** Body of `/api/plans`. */
  planBody?: (position: number, url: string) => unknown
}

/**
 * Run one conversation view against a controllable fetch: every answer stays
 * pending until the test releases it, so the response order is the test's
 * decision. The component receives the given slot props, exactly like the host
 * renders it.
 */
function startView(options: ViewOptions): BoardRun {
  const realFetch = globalThis.fetch
  const requests: string[] = []
  const releases: Array<() => void> = []
  let props: Record<string, unknown> = { ...(options.props ?? { sessionId: 'session-1' }) }
  globalThis.fetch = ((url: unknown) =>
    new Promise((resolve) => {
      const target = String(url)
      const isSession = target.includes('/api/session/state')
      const position = requests.length
      requests.push(target.replace(/^\/plan-store/, ''))
      const requested = new URL(target, 'http://board.test').searchParams.get('sessionId')
      releases.push(() =>
        resolve({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(
              isSession ? options.sessionState(requested) : options.planBody ? options.planBody(position, target) : {},
            ),
        }),
      )
    })) as typeof fetch

  const driver = makeHookDriver()
  let component: ((props: Record<string, unknown>) => unknown) | undefined
  driver.setRender(() => component?.(props))
  const { exported } = loadClient(driver.React)
  const { ctx, slots } = makeClientContext(workingSettings())
  ;(exported['apply'] as (context: unknown) => void)(ctx)
  component = slots.find((slot) => slot.name === 'conversation.view' && slot.id === options.slotId)?.component as
    | ((props: Record<string, unknown>) => unknown)
    | undefined
  if (component === undefined) throw new Error(`the ${options.slotId} view is not registered`)
  driver.run()

  return {
    hooks: driver.hooks,
    requests,
    tree: driver.readTree,
    answer: (position) => releases[position]?.(),
    answerAll: () => {
      for (const release of releases) release()
    },
    setProps: (next) => {
      props = { ...next }
      driver.run()
    },
    restore: () => {
      globalThis.fetch = realFetch
    },
  }
}

/**
 * Run the Plan Board. `sessionWorkspace` is the project the server reports for
 * the requested session, either fixed or derived from the session id.
 */
function startBoard(
  sessionWorkspace: string | null | ((requestedSession: string | null) => string | null),
  planAnswers: (position: number, url: string) => unknown,
  props: Record<string, unknown> = { sessionId: 'session-1' },
): BoardRun {
  return startView({
    slotId: 'plan-board',
    props,
    sessionState: (requested) => {
      const key = typeof sessionWorkspace === 'function' ? sessionWorkspace(requested) : sessionWorkspace
      return {
        sessionId: requested ?? '',
        goal: null,
        todos: [],
        candidates: requested === null ? [] : [requested],
        ...(key === null ? {} : { state: { workspace: { key, root: '/repo' } } }),
      }
    },
    planBody: planAnswers,
  })
}

describe('board loading', () => {
  /** Answer like the real server: honour the workspace query parameter. */
  const serverAnswer = (_position: number, url: string): unknown => {
    const workspace = new URL(url, 'http://board.test').searchParams.get('workspace')
    const all = [apiPlanLite('p_project', 'dsh-plan-store'), apiPlanLite('p_other', 'bookshelf')]
    const plans = workspace === null ? all : all.filter((plan) => plan.workspace === workspace)
    return { plans, total: plans.length, workspaces: [{ key: 'dsh-plan-store' }, { key: 'bookshelf' }] }
  }

  it('loads the board once, already filtered by the session project', async () => {
    const run = startBoard('dsh-plan-store', serverAnswer)
    try {
      await settle()
      run.answer(0) // the session state resolves first
      await settle()
      const boardCalls = run.requests.filter((url) => url.includes('/api/plans'))
      // Exactly one board request, and it already carries the project filter.
      expect(boardCalls).toEqual(['/api/plans?limit=200&workspace=dsh-plan-store'])
      run.answerAll()
      await settle()
      const data = run.hooks[0] as { plans: Array<{ id: string; workspace: string }> }
      expect(data.plans.map((plan) => plan.workspace)).toEqual(['dsh-plan-store'])
    } finally {
      run.restore()
    }
  })

  it('keeps the filtered answer when the unfiltered one arrives later', async () => {
    const run = startBoard('dsh-plan-store', serverAnswer)
    try {
      await settle()
      run.answer(0)
      await settle()
      // Release the board answers in the hostile order: whatever the board asked
      // for first lands last. The rendered board must still be the filtered one.
      const boardCalls = run.requests.length
      for (let position = boardCalls - 1; position >= 1; position -= 1) {
        run.answer(position)
        await settle()
      }
      const data = run.hooks[0] as { plans: Array<{ workspace: string }> }
      expect(data.plans.map((plan) => plan.workspace)).toEqual(['dsh-plan-store'])
      // The filter shown by the select and sent to the server is the same
      // derived value, so the request URL is the user-visible filter.
      const boardRequests = run.requests.filter((url) => url.includes('/api/plans'))
      expect(boardRequests).toEqual(['/api/plans?limit=200&workspace=dsh-plan-store'])
    } finally {
      run.restore()
    }
  })

  it('ignores a stale refresh answer that arrives after a newer one', async () => {
    const run = startBoard('dsh-plan-store', (position) => ({
      plans: [apiPlanLite(`p_answer_${position}`, 'dsh-plan-store')],
      total: 1,
      workspaces: [{ key: 'dsh-plan-store' }],
    }))
    try {
      await settle()
      run.answer(0)
      await settle()
      run.answerAll()
      await settle()

      const refresh = findButton(run.tree(), 'Refresh')
      expect(refresh).not.toBeNull()
      ;(refresh as () => void)()
      await settle()
      ;(refresh as () => void)()
      await settle()
      const newest = run.requests.length - 1
      const stale = newest - 1
      expect(run.requests[newest]).toContain('workspace=dsh-plan-store')
      // The newest answer lands first, the stale one last: it must be ignored.
      run.answer(newest)
      run.answer(stale)
      await settle()
      const data = run.hooks[0] as { plans: Array<{ id: string }> }
      expect(data.plans.map((plan) => plan.id)).toEqual([`p_answer_${newest}`])
    } finally {
      run.restore()
    }
  })
})


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
    // The host page owns the timers the views use (the goals tab polls).
    setInterval: (): number => 0,
    clearInterval: (): void => {},
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
    sessions: {
      list: {
        // The real list state has ids/byId/phase/projectionsBySession — and no
        // `current`, which is exactly why the views must use the slot prop.
        getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
        subscribe: () => () => {},
      },
    },
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
    expect(exported['inject']).toEqual(['slots', 'remote', 'remote.settings'])
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
  return flattenTree(component({ sessionId: 'session-1' }))
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

describe('session identity', () => {
  /** The server reports the project that belongs to the requested session. */
  const workspaceOfSession = (requested: string | null): string | null =>
    requested === null ? null : `project-${requested}`

  const plansOf = (_position: number, url: string): unknown => {
    const workspace = new URL(url, 'http://board.test').searchParams.get('workspace')
    const all = [apiPlanLite('p_a', 'project-session-a'), apiPlanLite('p_b', 'project-session-b')]
    const plans = workspace === null ? all : all.filter((plan) => plan.workspace === workspace)
    return { plans, total: plans.length, workspaces: [{ key: 'project-session-a' }, { key: 'project-session-b' }] }
  }

  it('reads the project of the session the host handed to the board', async () => {
    const run = startBoard(workspaceOfSession, plansOf, { sessionId: 'session-a' })
    try {
      await settle()
      // The very first call names the opened session — not "the last live one".
      expect(run.requests[0]).toBe('/api/session/state?sessionId=session-a')
      run.answer(0)
      await settle()
      expect(run.requests.filter((url) => url.includes('/api/plans'))).toEqual([
        '/api/plans?limit=200&workspace=project-session-a',
      ])
      run.answerAll()
      await settle()
      const data = run.hooks[0] as { plans: Array<{ workspace: string }> }
      expect(data.plans.map((plan) => plan.workspace)).toEqual(['project-session-a'])
    } finally {
      run.restore()
    }
  })

  it('follows the host when it switches to another session', async () => {
    const run = startBoard(workspaceOfSession, plansOf, { sessionId: 'session-a' })
    try {
      await settle()
      run.answer(0)
      await settle()
      run.answerAll()
      await settle()

      run.setProps({ sessionId: 'session-b' })
      await settle()
      const sessionCalls = run.requests.filter((url) => url.includes('/api/session/state'))
      expect(sessionCalls).toEqual([
        '/api/session/state?sessionId=session-a',
        '/api/session/state?sessionId=session-b',
      ])
      // Release the new session's project, then let the board ask again.
      run.answer(run.requests.length - 1)
      await settle()
      run.answerAll()
      await settle()
      const boardCalls = run.requests.filter((url) => url.includes('/api/plans'))
      expect(boardCalls[boardCalls.length - 1]).toBe('/api/plans?limit=200&workspace=project-session-b')
      const data = run.hooks[0] as { plans: Array<{ workspace: string }> }
      expect(data.plans.map((plan) => plan.workspace)).toEqual(['project-session-b'])
    } finally {
      run.restore()
    }
  })

  it('reads the goal and todo state of the session handed to the goals tab', async () => {
    const run = startView({
      slotId: 'goals-todos',
      props: { sessionId: 'session-a' },
      sessionState: (requested) => ({
        sessionId: requested ?? '',
        candidates: requested === null ? [] : [requested],
        state: {
          sessionId: requested ?? '',
          goal: null,
          todos: [],
          workspace: requested === null ? undefined : { key: `project-${requested}`, root: '/repo' },
        },
      }),
    })
    try {
      await settle()
      expect(run.requests[0]).toBe('/api/session/state?sessionId=session-a')
      run.answerAll()
      await settle()
      // The tab keeps the identity it was rendered with, not the last live one.
      const state = run.hooks.find(
        (hook) => typeof hook === 'object' && hook !== null && 'goal' in (hook as Record<string, unknown>),
      ) as { sessionId?: string } | undefined
      expect(state?.sessionId).toBe('session-a')
    } finally {
      run.restore()
    }
  })
})
