import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWebHandler, normalizeWebPath, type SessionBridge, type WebHandler } from '../src/dsh/web'
import { makeHarness, type TestHarness } from './helpers'

/** In-memory session bridge used by the session endpoint tests. */
function makeSessionBridge(): SessionBridge {
  const state = {
    sessionId: 's-1',
    goal: {
      id: 'g_1',
      revision: 3,
      objective: 'Ship the plan store',
      phase: 'active' as const,
      maxGoalRounds: 8,
      roundsStarted: 2,
    },
    todos: [{ content: 'write the mapping', status: 'pending' as const }],
  }
  return {
    liveSessions: () => ['s-0', 's-1'],
    read: (sessionId) => ({ ...state, sessionId }),
    goal: (sessionId, action) => ({
      ...state,
      sessionId,
      goal: { ...state.goal, phase: action === 'complete' ? ('complete' as const) : ('paused' as const) },
    }),
    todos: (sessionId, todos) => ({ ...state, sessionId, todos: [...todos] }),
  }
}

interface MockResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
  writableEnded: boolean
  setHeader(name: string, value: string): void
  end(chunk?: string): void
}

let harness: TestHarness
let handler: WebHandler

beforeEach(() => {
  harness = makeHarness()
  handler = createWebHandler(harness.engine, harness.config, {
    getWorkspaces: () => [{ key: 'demo', path: harness.workspace, title: 'demo' }],
    sessions: makeSessionBridge(),
  })
})

afterEach(() => {
  harness.cleanup()
})

/** Build a mock incoming request with an optional JSON body. */
function makeRequest(method: string, url: string, body?: unknown, address = '127.0.0.1'): IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as IncomingMessage & {
    method: string
    url: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json' }
  req.socket = { remoteAddress: address }
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  process.nextTick(() => {
    if (payload.length > 0) req.push(payload)
    req.push(null)
  })
  return req
}

/** Build a mock response capturing status, headers and body. */
function makeResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(name: string, value: string): void {
      res.headers[name.toLowerCase()] = value
    },
    end(chunk?: string): void {
      res.body = chunk ?? ''
      res.writableEnded = true
    },
  }
  return res
}

/** Run one request through the handler and parse the JSON response. */
async function request(
  method: string,
  url: string,
  body?: unknown,
  address = '127.0.0.1',
): Promise<{ status: number; json: Record<string, unknown>; res: MockResponse }> {
  const res = makeResponse()
  await handler(makeRequest(method, url, body, address), res as unknown as ServerResponse)
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown>, res }
}

describe('normalizeWebPath', () => {
  it('defaults, adds a leading slash and strips trailing ones', () => {
    expect(normalizeWebPath(undefined)).toBe('/plan-store')
    expect(normalizeWebPath('  ')).toBe('/plan-store')
    expect(normalizeWebPath('plans')).toBe('/plans')
    expect(normalizeWebPath('/plans/')).toBe('/plans')
    expect(normalizeWebPath('///')).toBe('/plan-store')
  })
})

describe('read endpoints', () => {
  it('returns the board with plans and workspaces', async () => {
    const created = harness.engine.createPlan({
      title: 'Board plan',
      workspace: 'demo',
      phases: [{ title: 'Core', tasks: ['schema'] }],
    })
    harness.engine.updateTask(created.phases[0]!.tasks[0]!.id, { status: 'doing' })

    const { status, json } = await request('GET', '/plan-store/api/plans?workspace=demo')
    expect(status).toBe(200)
    const plans = json['plans'] as Array<Record<string, unknown>>
    expect(plans).toHaveLength(1)
    expect(plans[0]?.['title']).toBe('Board plan')
    const firstProgress = plans[0]?.['progress'] as Record<string, unknown>
    expect(firstProgress['doing']).toBe(1)
    expect(json['total']).toBe(1)
    expect(json['workspaces']).toEqual([{ key: 'demo', path: harness.workspace, title: 'demo' }])
  })

  it('hides archived plans unless requested', async () => {
    const created = harness.engine.createPlan({ title: 'Archived' })
    harness.engine.archivePlan(created.id)
    expect(((await request('GET', '/plan-store/api/plans')).json['plans'] as unknown[])).toHaveLength(0)
    const withArchived = await request('GET', '/plan-store/api/plans?includeArchived=true')
    expect((withArchived.json['plans'] as unknown[])).toHaveLength(1)
  })

  it('returns one plan tree and 404 for an unknown id', async () => {
    const created = harness.engine.createPlan({ title: 'Detail', phases: [{ title: 'Core', tasks: ['a'] }] })
    const found = await request('GET', `/plan-store/api/plan?id=${created.id}`)
    expect(found.status).toBe(200)
    expect((found.json['plan'] as Record<string, unknown>)['title']).toBe('Detail')

    const missing = await request('GET', '/plan-store/api/plan?id=p_missing')
    expect(missing.status).toBe(404)
    expect(String(missing.json['error'])).toContain('not found')
  })

  it('requires the id query parameter', async () => {
    const { status, json } = await request('GET', '/plan-store/api/plan')
    expect(status).toBe(400)
    expect(String(json['error'])).toContain('"id"')
  })

  it('searches plans and tasks', async () => {
    harness.engine.createPlan({ title: 'Kanban board', phases: [{ title: 'Core', tasks: ['drag cards'] }] })
    const { status, json } = await request('GET', '/plan-store/api/search?q=kanban')
    expect(status).toBe(200)
    expect(json['count']).toBe(1)
  })

  it('reports status, config and workspaces', async () => {
    harness.engine.createPlan({ title: 'Counted' })
    const status = await request('GET', '/plan-store/api/status')
    expect(status.json['total']).toBe(1)
    expect(status.json['fts']).toBe(true)

    const config = await request('GET', '/plan-store/api/config')
    expect(config.json).toMatchObject({ webPath: '/plan-store', exportDir: '.kilo/plans', autoExport: true })

    const workspaces = await request('GET', '/plan-store/api/workspaces')
    expect(workspaces.json['workspaces']).toHaveLength(1)
  })
})

describe('write endpoints', () => {
  it('creates a plan and adds phases and tasks', async () => {
    const created = await request('POST', '/plan-store/api/plan/create', {
      title: 'From the board',
      description: 'created in the UI',
      workspace: 'demo',
      workspaceRoot: harness.workspace,
      priority: 'high',
      phases: [{ title: 'Core', tasks: ['schema'] }],
    })
    expect(created.status).toBe(200)
    const plan = created.json['plan'] as Record<string, unknown>
    const planId = String(plan['id'])
    expect(plan['priority']).toBe('high')

    const withPhase = await request('POST', '/plan-store/api/phase/add', { planId, title: 'UI', tasks: ['board'] })
    const phases = (withPhase.json['plan'] as Record<string, unknown>)['phases'] as Array<Record<string, unknown>>
    expect(phases).toHaveLength(2)

    const phaseId = String(phases[1]?.['id'])
    const withTask = await request('POST', '/plan-store/api/task/add', { planId, phaseId, title: 'drag' })
    const tasks = ((withTask.json['plan'] as Record<string, unknown>)['phases'] as Array<Record<string, unknown>>)[1]?.[
      'tasks'
    ] as Array<Record<string, unknown>>
    expect(tasks).toHaveLength(2)

    const renamed = await request('POST', '/plan-store/api/plan/update', { id: planId, title: 'Renamed plan' })
    expect((renamed.json['plan'] as Record<string, unknown>)['title']).toBe('Renamed plan')

    const phaseUpdated = await request('POST', '/plan-store/api/phase/update', { id: phaseId, status: 'doing' })
    expect(
      ((phaseUpdated.json['plan'] as Record<string, unknown>)['phases'] as Array<Record<string, unknown>>)[1]?.['status'],
    ).toBe('doing')

    const taskId = String(tasks[0]?.['id'])
    const taskUpdated = await request('POST', '/plan-store/api/task/update', { id: taskId, title: 'dragged', notes: 'n' })
    expect(JSON.stringify(taskUpdated.json['plan'])).toContain('dragged')

    const moved = await request('POST', '/plan-store/api/task/move', { id: taskId, status: 'done', position: 0 })
    const movedPlan = moved.json['plan'] as Record<string, unknown>
    expect((movedPlan['progress'] as Record<string, unknown>)['done']).toBe(1)

    const taskDeleted = await request('POST', '/plan-store/api/task/delete', { id: taskId })
    const tasksAfterDelete = ((taskDeleted.json['plan'] as Record<string, unknown>)['phases'] as Array<
      Record<string, unknown>
    >)[1]?.['tasks'] as unknown[]
    expect(tasksAfterDelete).toHaveLength(1)

    const phaseDeleted = await request('POST', '/plan-store/api/phase/delete', { id: phaseId })
    expect(((phaseDeleted.json['plan'] as Record<string, unknown>)['phases'] as unknown[])).toHaveLength(1)
  })

  it('validates required fields and unknown values', async () => {
    const missing = await request('POST', '/plan-store/api/plan/create', { description: 'no title' })
    expect(missing.status).toBe(400)
    expect(String(missing.json['error'])).toContain('"title"')

    const badStatus = await request('POST', '/plan-store/api/plan/create', { title: 'x', status: 'someday' })
    expect(badStatus.status).toBe(200)

    const badJson = await request('POST', '/plan-store/api/plan/create', '{not json')
    expect(badJson.status).toBe(400)
    expect(String(badJson.json['error'])).toContain('valid JSON')

    const notAnObject = await request('POST', '/plan-store/api/plan/create', '[1,2]')
    expect(notAnObject.status).toBe(400)
  })

  it('archives and purges a plan', async () => {
    const created = harness.engine.createPlan({ title: 'Lifecycle' })
    const archived = await request('POST', '/plan-store/api/plan/delete', { id: created.id })
    expect((archived.json['plan'] as Record<string, unknown>)['status']).toBe('archived')

    const unconfirmed = await request('POST', '/plan-store/api/plan/purge', { id: created.id })
    expect(unconfirmed.status).toBe(400)
    expect(String(unconfirmed.json['error'])).toContain('confirm')

    const purged = await request('POST', '/plan-store/api/plan/purge', { id: created.id, confirm: true })
    expect(purged.json['purged']).toBe(true)
  })

  it('exports a plan into its workspace', async () => {
    const created = harness.engine.createPlan({
      title: 'Export from board',
      workspace: 'demo',
      workspaceRoot: harness.workspace,
      phases: [{ title: 'Core', tasks: ['a'] }],
    })
    const { status, json } = await request('POST', '/plan-store/api/export', { id: created.id })
    expect(status).toBe(200)
    const path = String(json['path'])
    expect(path).toBe(join(harness.workspace, '.kilo/plans/export-from-board.md'))
    expect(existsSync(path)).toBe(true)
  })

  it('returns 404 for a missing plan on a mutation', async () => {
    const { status } = await request('POST', '/plan-store/api/plan/update', { id: 'p_missing', title: 'x' })
    expect(status).toBe(404)
  })
})

describe('session archiving', () => {
  it('archives the session and its plans', async () => {
    const created = harness.engine.createPlan({ title: 'Session plan' }, { sessionId: 's-arch' })
    const archived: string[] = []
    const withBridge = createWebHandler(harness.engine, harness.config, {
      archiveSession: async (sessionId) => {
        archived.push(sessionId)
        return true
      },
    })

    const res = makeResponse()
    await withBridge(
      makeRequest('POST', '/plan-store/api/session/archive', { sessionId: 's-arch' }),
      res as unknown as ServerResponse,
    )
    const json = JSON.parse(res.body) as Record<string, unknown>
    expect(res.statusCode).toBe(200)
    expect(json['count']).toBe(1)
    expect(json['sessionArchived']).toBe(true)
    expect(archived).toEqual(['s-arch'])
    expect(harness.engine.requireTree(created.id).status).toBe('archived')

    const missing = await request('POST', '/plan-store/api/session/archive', {})
    expect(missing.status).toBe(400)
  })

  it('reports that the host cannot archive the session itself', async () => {
    harness.engine.createPlan({ title: 'Only plans' }, { sessionId: 's-x' })
    const { status, json } = await request('POST', '/plan-store/api/session/archive', { sessionId: 's-x' })
    expect(status).toBe(200)
    expect(json['sessionArchived']).toBe(false)
    expect(json['count']).toBe(1)
  })

  it('syncs host-archived sessions before serving the board', async () => {
    const created = harness.engine.createPlan({ title: 'To archive' }, { sessionId: 's-sync' })
    const withSync = createWebHandler(harness.engine, harness.config, {
      syncArchive: () => harness.engine.syncArchivedSessions(['s-sync']),
    })
    const res = makeResponse()
    await withSync(makeRequest('GET', '/plan-store/api/plans'), res as unknown as ServerResponse)
    const json = JSON.parse(res.body) as Record<string, unknown>
    expect(json['archivedBySync']).toBe(1)
    expect(json['plans']).toHaveLength(0)
    expect(harness.engine.requireTree(created.id).status).toBe('archived')
  })
})

describe('routing guards', () => {
  it('rejects non-loopback peers and unknown routes', async () => {
    const forbidden = await request('GET', '/plan-store/api/plans', undefined, '10.0.0.5')
    expect(forbidden.status).toBe(403)

    const outside = await request('GET', '/other/api/plans')
    expect(outside.status).toBe(404)

    const unknown = await request('GET', '/plan-store/api/nope')
    expect(unknown.status).toBe(404)

    const method = await request('DELETE', '/plan-store/api/plans')
    expect(method.status).toBe(405)
    expect(method.res.headers['allow']).toBe('GET, POST')
  })
})

describe('session bridge endpoints', () => {
  it('reads the goal and todo state of a live session', async () => {
    const { status, json } = await request('GET', '/plan-store/api/session/state?sessionId=s-1')
    expect(status).toBe(200)
    const state = json['state'] as Record<string, unknown>
    expect((state['goal'] as Record<string, unknown>)['objective']).toBe('Ship the plan store')
    expect((state['todos'] as unknown[])).toHaveLength(1)
    expect(json['candidates']).toEqual(['s-0', 's-1'])
  })

  it('falls back to the newest live session when none is given', async () => {
    const { json } = await request('GET', '/plan-store/api/session/state')
    expect((json['state'] as Record<string, unknown>)['sessionId']).toBe('s-1')
  })

  it('runs a goal action and validates it', async () => {
    const done = await request('POST', '/plan-store/api/session/goal', { sessionId: 's-1', action: 'complete' })
    expect(done.status).toBe(200)
    expect(((done.json['state'] as Record<string, unknown>)['goal'] as Record<string, unknown>)['phase']).toBe('complete')

    const bad = await request('POST', '/plan-store/api/session/goal', { sessionId: 's-1', action: 'explode' })
    expect(bad.status).toBe(400)
    expect(String(bad.json['error'])).toContain('"action"')

    const missing = await request('POST', '/plan-store/api/session/goal', { action: 'pause' })
    expect(missing.status).toBe(400)
  })

  it('replaces the todo list', async () => {
    const { status, json } = await request('POST', '/plan-store/api/session/todos', {
      sessionId: 's-1',
      todos: [{ content: 'ship it', status: 'in_progress' }],
    })
    expect(status).toBe(200)
    const todos = (json['state'] as Record<string, unknown>)['todos'] as Array<Record<string, unknown>>
    expect(todos).toEqual([{ content: 'ship it', status: 'in_progress' }])

    const invalid = await request('POST', '/plan-store/api/session/todos', { sessionId: 's-1', todos: 'nope' })
    expect(invalid.status).toBe(400)
  })

  it('imports a session into a plan and refreshes it', async () => {
    const created = await request('POST', '/plan-store/api/session/import', { sessionId: 's-1' })
    expect(created.status).toBe(200)
    expect(created.json['created']).toBe(true)
    const plan = created.json['plan'] as Record<string, unknown>
    expect(plan['title']).toBe('Ship the plan store')
    expect(plan['sessionId']).toBe('s-1')

    const refreshed = await request('POST', '/plan-store/api/session/import', { sessionId: 's-1' })
    expect(refreshed.json['created']).toBe(false)
    expect((refreshed.json['plan'] as Record<string, unknown>)['id']).toBe(plan['id'])
  })

  it('answers 503 when the profile has no session bridge', async () => {
    const bare = createWebHandler(harness.engine, harness.config)
    const res = makeResponse()
    await bare(makeRequest('GET', '/plan-store/api/session/state?sessionId=s-1'), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(503)
    expect(String(JSON.parse(res.body)['error'])).toContain('session bridge')
  })
})
