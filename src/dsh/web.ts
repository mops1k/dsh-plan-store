/**
 * WebUI host half: REST routes served through `ctx.webServer` for the kanban
 * client plugin.
 *
 * The pure {@link createWebHandler} owns routing so it can be unit-tested with
 * mock request/response objects; {@link registerPlanWeb} only wires it to the
 * dsh web server. Routes are loopback-only and carry no authentication, exactly
 * like every other plugin-owned prefix route.
 *
 * @module dsh-plan-store/dsh/web
 */
import { basename } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

import type { PlanStoreConfig } from '../core/config.js'
import { PlanError, type PlanEngine } from '../core/engine.js'
import type { PlanFilter, TaskMove } from '../core/types.js'
import { isPlanPriority, isPlanStatus, isWorkStatus } from '../core/types.js'
import type { SessionSnapshot, SessionTodo } from '../core/import-session.js'
import { archiveWorkspaceSession, archivedSessionIdsOf, resolveWorkspaceRegistry } from './session.js'
import {
  SessionStateError,
  applyGoalAction,
  liveSessionIds,
  readSessionState,
  writeTodos,
  type GoalAction,
  type GoalActionPayload,
} from './session-state.js'

/** Maximum accepted request body size in bytes. */
export const MAX_BODY_BYTES = 1024 * 1024

/** Async request handler shaped like a `WebRoute` handler. */
export type WebHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** One workspace offered to the board filter. */
export interface WorkspaceInfo {
  key: string
  path: string
  title: string
}

/** HTTP error carrying the status code written to the response. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Normalize a configured web path into an absolute, slash-only prefix. */
export function normalizeWebPath(value: string | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  const withSlash = trimmed.length === 0 ? '/plan-store' : trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const stripped = withSlash.replace(/\/+$/u, '')
  return stripped.length === 0 ? '/plan-store' : stripped
}

/** True when the peer is the loopback interface (or unknown, as in tests). */
function isLoopback(req: IncomingMessage): boolean {
  const address = (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress
  if (address === undefined || address.length === 0) return true
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Write one JSON response. */
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

/** Read and validate a JSON object body, enforcing the size limit. */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      rejectPromise(error)
    }
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > limit) {
        fail(new HttpError(413, 'Request body is too large.'))
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => fail(error))
  })
}

/** Parse a JSON object body, returning `{}` for an empty payload. */
async function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const text = await readBody(req, limit)
  if (text.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

/** Case-insensitive string field helper. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Parse an array of non-empty strings, dropping everything else. */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

/** Parse an integer value with bounds. */
function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.round(parsed)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/** One query parameter, treating blank values as absent. */
function param(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  if (value === null) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Required string field of a body. */
function requireString(body: Record<string, unknown>, name: string): string {
  const value = asString(body[name])?.trim() ?? ''
  if (value.length === 0) throw new HttpError(400, `Field "${name}" is required.`)
  return value
}

/** Build the filter accepted by the list and board queries. */
function filterFrom(url: URL): PlanFilter {
  const status = param(url, 'status')
  const workspace = param(url, 'workspace')
  const query = param(url, 'query')
  const includeArchived = param(url, 'includeArchived')
  const filter: PlanFilter = {
    status: isPlanStatus(status) ? status : 'all',
    includeArchived: includeArchived === 'true' || includeArchived === '1',
    limit: asInt(param(url, 'limit'), 100, 1, 500),
  }
  if (workspace !== undefined) filter.workspace = workspace
  if (query !== undefined) filter.query = query
  return filter
}

/** Map an engine error onto an HTTP status. */
function statusOf(error: unknown): number {
  if (error instanceof HttpError) return error.status
  if (error instanceof SessionStateError) {
    if (error.code === 'no_goal') return 404
    if (error.code === 'not_live') return 409
    return 400
  }
  if (error instanceof PlanError) {
    if (error.code === 'not_found') return 404
    if (error.code === 'conflict') return 409
    return 400
  }
  return 500
}

/** Goal and todo access for the session tab, injected by the host half. */
export interface SessionBridge {
  /** Ids of the sessions live in this process, newest last. */
  liveSessions(): string[]
  /** Read the goal and todo state of one live session. */
  read(sessionId: string): SessionSnapshot
  /** Run a goal lifecycle action. */
  goal(sessionId: string, action: GoalAction, payload: GoalActionPayload): SessionSnapshot
  /** Replace the todo list of a live session. */
  todos(sessionId: string, todos: readonly SessionTodo[]): SessionSnapshot
}

/** Options of {@link createWebHandler}. */
export interface WebHandlerOptions {
  /** Known workspaces for the board filter; resolved from the registry by default. */
  getWorkspaces?: () => WorkspaceInfo[]
  /** Session bridge; without it the `/api/session/*` routes answer 503. */
  sessions?: SessionBridge
  /**
   * Archive the plans of sessions the host archived. Called before the board
   * and the session state are read, so the sidebar action takes effect without
   * any polling.
   */
  syncArchive?: () => string[]
  /** Archive the dsh session itself; false when this profile cannot. */
  archiveSession?: (sessionId: string) => Promise<boolean>
}

/**
 * Build the pure HTTP handler for the plugin's prefix route.
 *
 * Supported endpoints (all relative to the configured `webPath`):
 * `GET /api/plans`, `GET /api/plan`, `GET /api/search`, `GET /api/workspaces`,
 * `GET /api/status`, `GET /api/config`, `POST /api/plan/create|update|delete|purge`,
 * `POST /api/phase/add|update|delete`, `POST /api/task/add|update|delete|move`,
 * `POST /api/export`.
 */
export function createWebHandler(
  engine: PlanEngine,
  config: PlanStoreConfig,
  options: WebHandlerOptions = {},
): WebHandler {
  const base = normalizeWebPath(config.webPath)

  /** Archive the plans of host-archived sessions; never fails the request. */
  const syncArchive = (): string[] => {
    const sync = options.syncArchive
    if (sync === undefined) return []
    try {
      return sync()
    } catch {
      return []
    }
  }

  const workspaces = (): WorkspaceInfo[] => {
    if (options.getWorkspaces !== undefined) return options.getWorkspaces()
    const known = new Map<string, WorkspaceInfo>()
    for (const key of engine.workspaces()) known.set(key, { key, path: '', title: key })
    return [...known.values()]
  }

  const handleGet = (rel: string, url: URL, res: ServerResponse): void => {
    if (rel === '/api/plans') {
      const archivedBySync = syncArchive().length
      const filter = filterFrom(url)
      const board = engine.board(filter)
      sendJson(res, 200, { plans: board.plans, total: board.total, workspaces: workspaces(), archivedBySync })
      return
    }
    if (rel === '/api/plan') {
      const id = param(url, 'id')
      if (id === undefined) throw new HttpError(400, 'Missing required query parameter "id".')
      const eventLimit = asInt(param(url, 'eventLimit'), 20, 0, 200)
      sendJson(res, 200, { plan: engine.requireTree(id, eventLimit) })
      return
    }
    if (rel === '/api/search') {
      const query = param(url, 'q')
      if (query === undefined) throw new HttpError(400, 'Missing required query parameter "q".')
      const hits = engine.searchPlans(query, param(url, 'workspace'), asInt(param(url, 'limit'), 20, 1, 100))
      sendJson(res, 200, { hits, count: hits.length })
      return
    }
    if (rel === '/api/workspaces') {
      sendJson(res, 200, { workspaces: workspaces() })
      return
    }
    if (rel === '/api/status') {
      const workspace = param(url, 'workspace')
      sendJson(res, 200, engine.statusReport(workspace))
      return
    }
    if (rel === '/api/session/state') {
      const bridge = options.sessions
      if (bridge === undefined) throw new HttpError(503, 'The session bridge is unavailable in this profile.')
      syncArchive()
      const requested = param(url, 'sessionId')
      const candidates = bridge.liveSessions()
      const sessionId = requested ?? candidates[candidates.length - 1]
      if (sessionId === undefined) throw new HttpError(404, 'No live session in this dsh process.')
      const state = bridge.read(sessionId)
      sendJson(res, 200, { state, candidates })
      return
    }
    if (rel === '/api/config') {
      sendJson(res, 200, {
        webPath: base,
        exportDir: config.exportDir,
        autoExport: config.autoExport,
        promptActivePlans: config.promptActivePlans,
        promptActiveLimit: config.promptActiveLimit,
        stalePlanDays: config.stalePlanDays,
        fts: engine.ftsEnabled,
      })
      return
    }
    sendJson(res, 404, { error: 'Not found' })
  }

  const handlePost = async (rel: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJsonBody(req, MAX_BODY_BYTES)
    const session = asString(body['sessionId'])?.trim() ?? null
    const operation = { sessionId: session }

    if (rel === '/api/plan/create') {
      const phases = Array.isArray(body['phases']) ? body['phases'] : []
      const status = asString(body['status'])
      const priority = asString(body['priority'])
      const plan = engine.createPlan(
        {
          title: requireString(body, 'title'),
          ...(asString(body['description']) !== undefined ? { description: asString(body['description']) as string } : {}),
          ...(asString(body['workspace']) !== undefined ? { workspace: asString(body['workspace']) as string } : {}),
          ...(asString(body['workspaceRoot']) !== undefined ? { workspaceRoot: asString(body['workspaceRoot']) as string } : {}),
          ...(status !== undefined && isPlanStatus(status) ? { status } : {}),
          ...(priority !== undefined && isPlanPriority(priority) ? { priority } : {}),
          ...(asStringArray(body['tags']) !== undefined ? { tags: asStringArray(body['tags']) as string[] } : {}),
          ...(phases.length > 0 ? { phases: phases as never } : {}),
        },
        operation,
      )
      sendJson(res, 200, { plan })
      return
    }
    if (rel === '/api/plan/update') {
      const id = requireString(body, 'id')
      const status = asString(body['status'])
      const priority = asString(body['priority'])
      const plan = engine.updatePlan(
        id,
        {
          ...(asString(body['title']) !== undefined ? { title: asString(body['title']) as string } : {}),
          ...(asString(body['description']) !== undefined ? { description: asString(body['description']) as string } : {}),
          ...(status !== undefined && isPlanStatus(status) ? { status } : {}),
          ...(priority !== undefined && isPlanPriority(priority) ? { priority } : {}),
          ...(asStringArray(body['tags']) !== undefined ? { tags: asStringArray(body['tags']) as string[] } : {}),
          ...(asString(body['workspace']) !== undefined ? { workspace: asString(body['workspace']) as string } : {}),
          ...(asString(body['workspaceRoot']) !== undefined ? { workspaceRoot: asString(body['workspaceRoot']) as string } : {}),
        },
        operation,
      )
      sendJson(res, 200, { plan })
      return
    }
    if (rel === '/api/plan/delete') {
      sendJson(res, 200, { plan: engine.archivePlan(requireString(body, 'id'), operation) })
      return
    }
    if (rel === '/api/plan/purge') {
      const id = requireString(body, 'id')
      const purged = engine.purgePlan(id, body['confirm'] === true)
      sendJson(res, 200, { id, purged })
      return
    }
    if (rel === '/api/phase/add') {
      const status = asString(body['status'])
      const plan = engine.addPhase(
        requireString(body, 'planId'),
        {
          title: requireString(body, 'title'),
          ...(asString(body['notes']) !== undefined ? { notes: asString(body['notes']) as string } : {}),
          ...(status !== undefined && isWorkStatus(status) ? { status } : {}),
          ...(body['position'] !== undefined ? { position: asInt(body['position'], 0, 0, 10_000) } : {}),
          ...(asStringArray(body['tasks']) !== undefined ? { tasks: asStringArray(body['tasks']) as string[] } : {}),
        },
        operation,
      )
      sendJson(res, 200, { plan })
      return
    }
    if (rel === '/api/phase/update') {
      const status = asString(body['status'])
      const plan = engine.updatePhase(
        requireString(body, 'id'),
        {
          ...(asString(body['title']) !== undefined ? { title: asString(body['title']) as string } : {}),
          ...(status !== undefined && isWorkStatus(status) ? { status } : {}),
          ...(asString(body['notes']) !== undefined ? { notes: asString(body['notes']) as string } : {}),
          ...(body['position'] !== undefined ? { position: asInt(body['position'], 0, 0, 10_000) } : {}),
        },
        operation,
      )
      sendJson(res, 200, { plan })
      return
    }
    if (rel === '/api/phase/delete') {
      sendJson(res, 200, { plan: engine.deletePhase(requireString(body, 'id'), operation) })
      return
    }
    if (rel === '/api/task/add') {
      const status = asString(body['status'])
      const plan = engine.addTask(
        requireString(body, 'planId'),
        {
          title: requireString(body, 'title'),
          ...(asString(body['phaseId']) !== undefined ? { phaseId: asString(body['phaseId']) as string } : {}),
          ...(status !== undefined && isWorkStatus(status) ? { status } : {}),
          ...(asString(body['notes']) !== undefined ? { notes: asString(body['notes']) as string } : {}),
          ...(asStringArray(body['links']) !== undefined ? { links: asStringArray(body['links']) as string[] } : {}),
        },
        operation,
      )
      sendJson(res, 200, { plan })
      return
    }
    if (rel === '/api/task/update') {
      const status = asString(body['status'])
      const plan = engine.updateTask(
        requireString(body, 'id'),
        {
          ...(asString(body['title']) !== undefined ? { title: asString(body['title']) as string } : {}),
          ...(status !== undefined && isWorkStatus(status) ? { status } : {}),
          ...(asString(body['notes']) !== undefined ? { notes: asString(body['notes']) as string } : {}),
          ...(asStringArray(body['links']) !== undefined ? { links: asStringArray(body['links']) as string[] } : {}),
          ...(asString(body['phaseId']) !== undefined ? { phaseId: asString(body['phaseId']) as string } : {}),
          ...(body['position'] !== undefined ? { position: asInt(body['position'], 0, 0, 10_000) } : {}),
        },
        operation,
      )
      sendJson(res, 200, { plan })
      return
    }
    if (rel === '/api/task/delete') {
      sendJson(res, 200, { plan: engine.deleteTask(requireString(body, 'id'), operation) })
      return
    }
    if (rel === '/api/task/move') {
      const status = asString(body['status'])
      const move: TaskMove = {
        ...(status !== undefined && isWorkStatus(status) ? { status } : {}),
        ...(asString(body['phaseId']) !== undefined ? { phaseId: asString(body['phaseId']) as string } : {}),
        ...(body['position'] !== undefined ? { position: asInt(body['position'], 0, 0, 10_000) } : {}),
      }
      sendJson(res, 200, { plan: engine.moveTask(requireString(body, 'id'), move, operation) })
      return
    }
    if (rel === '/api/session/goal') {
      const bridge = options.sessions
      if (bridge === undefined) throw new HttpError(503, 'The session bridge is unavailable in this profile.')
      const action = (asString(body['action']) ?? '').trim()
      if (!['pause', 'resume', 'complete', 'block', 'edit', 'clear'].includes(action)) {
        throw new HttpError(400, 'Field "action" must be pause, resume, complete, block, edit or clear.')
      }
      const payload: GoalActionPayload = {
        ...(asString(body['objective']) !== undefined ? { objective: asString(body['objective']) as string } : {}),
        ...(body['maxGoalRounds'] !== undefined
          ? { maxGoalRounds: asInt(body['maxGoalRounds'], 0, 1, 1000) }
          : {}),
        ...(asString(body['reason']) !== undefined ? { reason: asString(body['reason']) as string } : {}),
        ...(asString(body['code']) !== undefined ? { code: asString(body['code']) as string } : {}),
      }
      const state = bridge.goal(requireString(body, 'sessionId'), action as GoalAction, payload)
      sendJson(res, 200, { state })
      return
    }
    if (rel === '/api/session/todos') {
      const bridge = options.sessions
      if (bridge === undefined) throw new HttpError(503, 'The session bridge is unavailable in this profile.')
      const raw = Array.isArray(body['todos']) ? body['todos'] : null
      if (raw === null) throw new HttpError(400, 'Field "todos" must be an array.')
      const todos: SessionTodo[] = []
      for (const item of raw) {
        if (item === null || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const content = (asString(record['content']) ?? '').trim()
        if (content.length === 0) continue
        const status = asString(record['status'])
        todos.push({
          content,
          status: status === 'completed' || status === 'in_progress' ? status : 'pending',
        })
      }
      const state = bridge.todos(requireString(body, 'sessionId'), todos)
      sendJson(res, 200, { state })
      return
    }
    if (rel === '/api/session/archive') {
      const sessionId = requireString(body, 'sessionId')
      // Archive the dsh session first (it disappears from the sidebar), then its
      // plans. Without host support the plans are still archived on their own.
      let sessionArchived = false
      if (options.archiveSession !== undefined) {
        sessionArchived = await options.archiveSession(sessionId)
      }
      const archived = engine.archiveSessionPlans(sessionId, operation)
      sendJson(res, 200, { archived, count: archived.length, sessionArchived })
      return
    }
    if (rel === '/api/session/import') {
      const bridge = options.sessions
      if (bridge === undefined) throw new HttpError(503, 'The session bridge is unavailable in this profile.')
      const sessionId = requireString(body, 'sessionId')
      const snapshot = bridge.read(sessionId)
      const result = engine.importSession(
        snapshot,
        {
          key: (asString(body['workspace']) ?? '').trim(),
          root: (asString(body['workspaceRoot']) ?? '').trim(),
        },
        body['refresh'] !== false,
      )
      sendJson(res, 200, { plan: result.tree, created: result.created })
      return
    }
    if (rel === '/api/export') {
      const id = requireString(body, 'id')
      const tree = engine.requireTree(id)
      const workspaceRoot = (asString(body['workspaceRoot'])?.trim() ?? '') || tree.workspaceRoot
      const result = engine.exportPlan(id, {
        workspaceRoot,
        exportDir: asString(body['exportDir'])?.trim() || config.exportDir,
        sessionId: session,
      })
      sendJson(res, 200, { plan: result.tree, path: result.path })
      return
    }
    sendJson(res, 404, { error: 'Not found' })
  }

  return async (req, res) => {
    try {
      const method = (req.method ?? 'GET').toUpperCase()
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname
      if (pathname !== base && !pathname.startsWith(`${base}/`)) {
        sendJson(res, 404, { error: 'Not found' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: 'This endpoint is available on loopback only.' })
        return
      }
      const rel = pathname.slice(base.length) || '/'
      if (method === 'GET') {
        handleGet(rel, url, res)
        return
      }
      if (method === 'POST') {
        await handlePost(rel, req, res)
        return
      }
      res.setHeader('Allow', 'GET, POST')
      sendJson(res, 405, { error: `Method ${method} is not allowed.` })
    } catch (error) {
      const status = statusOf(error)
      const message = status === 500 ? 'Internal server error' : error instanceof Error ? error.message : String(error)
      if (res.writableEnded !== true) sendJson(res, status, { error: message })
    }
  }
}

/** Log a warning through the Cordis logger, falling back to the console. */
function warnWeb(ctx: Context, message: string): void {
  try {
    ctx.logger.warn(message)
  } catch {
    console.warn(`[dsh-plan-store] ${message}`)
  }
}

/** Resolve the workspaces offered by the board filter. */
function registryWorkspaces(ctx: Context): WorkspaceInfo[] {
  const registry = resolveWorkspaceRegistry(ctx)
  if (registry === undefined) return []
  try {
    return registry.list()
      .filter((workspace) => typeof workspace.path === 'string' && workspace.path.length > 0)
      .map((workspace) => ({
        key: (workspace.title ?? '').trim() || basename(workspace.path),
        path: workspace.path,
        title: (workspace.title ?? '').trim() || basename(workspace.path),
      }))
  } catch {
    return []
  }
}

/**
 * Register the plugin's HTTP routes. The prefix route lives for as long as the
 * plugin fiber.
 */
export function registerPlanWeb(ctx: Context, engine: PlanEngine, config: PlanStoreConfig): void {
  const base = normalizeWebPath(config.webPath)
  const handler = createWebHandler(engine, config, {
    syncArchive: () => engine.syncArchivedSessions(archivedSessionIdsOf(ctx) ?? []),
    archiveSession: (sessionId) => archiveWorkspaceSession(ctx, sessionId),
    sessions: {
      liveSessions: () => liveSessionIds(ctx),
      read: (sessionId) => readSessionState(ctx, sessionId),
      goal: (sessionId, action, payload) => applyGoalAction(ctx, sessionId, action, payload),
      todos: (sessionId, todos) => writeTodos(ctx, sessionId, todos),
    },
    getWorkspaces: () => {
      const known = new Map<string, WorkspaceInfo>()
      for (const workspace of registryWorkspaces(ctx)) known.set(workspace.key, workspace)
      for (const key of engine.workspaces()) {
        if (!known.has(key)) known.set(key, { key, path: '', title: key })
      }
      return [...known.values()].sort((left, right) => left.key.localeCompare(right.key))
    },
  })
  const route: WebRoute = { kind: 'prefix', path: base, handler }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => ctx.webServer.register(route))
    else ctx.webServer.register(route)
  } catch (error) {
    warnWeb(ctx, `Web routes at "${base}" were not registered: ${error instanceof Error ? error.message : String(error)}`)
  }
}
