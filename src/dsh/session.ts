/**
 * Session and workspace resolution for the host half.
 *
 * Tools need two facts about their caller: the working directory of the session
 * that issued the call (for the workspace key and for plan export) and, when a
 * tool names a workspace explicitly, its absolute root. Both are optional
 * services, so every lookup degrades to `null` instead of failing activation —
 * the plugin keeps working in headless profiles.
 *
 * @module dsh-plan-store/dsh/session
 */
import { basename } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { NO_WORKSPACE_KEY, projectKeyFromCwd, slugify } from '../core/paths.js'

/** Structural view of `ctx.sessions` limited to what the plugin needs. */
export interface SessionStoreLike {
  get(id: string): { header?: { cwd?: string } } | undefined
}

/** One workspace as exposed by `ctx.workspaceRegistry`. */
export interface WorkspaceLike {
  path: string
  title?: string
}

/** Structural view of `ctx.workspaceRegistry`. */
export interface WorkspaceRegistryLike {
  list(): WorkspaceLike[]
  /** Registry-global archive set; absent on hosts without session archiving. */
  readonly archivedSessionIds?: readonly string[]
  /** Archive one session durably; absent on hosts without session archiving. */
  archiveSession?(sessionId: string): Promise<void>
}

/** Structural view of the tool execution used to find the calling session. */
export interface ToolExecutionLike {
  agent?: { id?: unknown }
}

/** Read a service property with the reflected, `get` and non-strict fallbacks. */
export function readService<T>(ctx: Context, name: string): T | undefined {
  const source = ctx as unknown as {
    [key: string]: unknown
    get?: (service: string) => unknown
    reflect?: { get?: (service: string, strict?: boolean) => unknown }
  }
  const readers: Array<() => unknown> = [
    () => source[name],
    () => source.get?.(name),
    () => source.reflect?.get?.(name, false),
  ]
  for (const read of readers) {
    try {
      const value = read()
      if (value !== null && typeof value === 'object') return value as T
    } catch {
      /* try the next resolution path */
    }
  }
  return undefined
}

/** Resolve `ctx.sessions` when the host provides it. */
export function resolveSessionStore(ctx: Context): SessionStoreLike | undefined {
  const candidate = readService<SessionStoreLike>(ctx, 'sessions')
  return candidate !== undefined && typeof candidate.get === 'function' ? candidate : undefined
}

/** Resolve `ctx.workspaceRegistry` when the host provides it. */
export function resolveWorkspaceRegistry(ctx: Context): WorkspaceRegistryLike | undefined {
  const candidate = readService<WorkspaceRegistryLike>(ctx, 'workspaceRegistry')
  return candidate !== undefined && typeof candidate.list === 'function' ? candidate : undefined
}

/** Identifier of the agent that issued a tool call. */
export function sessionAgentId(exec: unknown): string | null {
  const agentId = (exec as ToolExecutionLike | undefined)?.agent?.id
  if (agentId === undefined || agentId === null) return null
  const id = String(agentId)
  return id.length > 0 ? id : null
}

/** Working directory of the session that issued a tool call. */
export function sessionCwd(ctx: Context, exec: unknown): string | null {
  const sessions = resolveSessionStore(ctx)
  const id = sessionAgentId(exec)
  if (sessions === undefined || id === null) return null
  try {
    const cwd = sessions.get(id)?.header?.cwd
    if (typeof cwd !== 'string' || cwd.trim().length === 0) return null
    return cwd.trim()
  } catch {
    return null
  }
}

/** Resolve a workspace key to its absolute root through the registry. */
export function findWorkspacePath(ctx: Context, key: string): string | null {
  const wanted = key.trim()
  if (wanted.length === 0) return null
  const registry = resolveWorkspaceRegistry(ctx)
  if (registry === undefined) return null
  try {
    for (const workspace of registry.list()) {
      if (typeof workspace.path !== 'string' || workspace.path.length === 0) continue
      if (workspace.title === wanted) return workspace.path
      if (slugify(basename(workspace.path)) === slugify(wanted)) return workspace.path
      if (basename(workspace.path) === wanted) return workspace.path
    }
  } catch {
    return null
  }
  return null
}

/**
 * Sessions archived in the workspace registry, or `null` when the host has no
 * archiving (or no registry at all).
 */
export function archivedSessionIdsOf(ctx: Context): string[] | null {
  const registry = resolveWorkspaceRegistry(ctx)
  if (registry === undefined) return null
  const ids = registry.archivedSessionIds
  if (!Array.isArray(ids)) return null
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/**
 * Archive one session through the workspace registry.
 *
 * @returns `true` when the host archived it, `false` when this profile has no
 *   session archiving (the plans can still be archived on their own).
 */
export async function archiveWorkspaceSession(ctx: Context, sessionId: string): Promise<boolean> {
  const id = sessionId.trim()
  if (id.length === 0) return false
  const registry = resolveWorkspaceRegistry(ctx)
  const archive = registry?.archiveSession
  if (registry === undefined || typeof archive !== 'function') return false
  await archive.call(registry, id)
  return true
}

/** Workspace key plus the absolute root the plan belongs to. */
export interface WorkspaceRef {
  key: string
  root: string
}

/**
 * Resolve the workspace of a tool call.
 *
 * An explicit key wins (its root comes from the explicit root, the workspace
 * registry or the session cwd, in that order); otherwise the session cwd
 * defines both the key and the root.
 */
export function resolveWorkspace(
  ctx: Context,
  exec: unknown,
  explicitKey?: string,
  explicitRoot?: string,
): WorkspaceRef {
  const cwd = sessionCwd(ctx, exec)
  const key = (explicitKey ?? '').trim()
  if (key.length > 0) {
    const root = (explicitRoot ?? '').trim() || findWorkspacePath(ctx, key) || cwd || ''
    return { key, root }
  }
  if (cwd === null) return { key: NO_WORKSPACE_KEY, root: '' }
  return { key: projectKeyFromCwd(cwd), root: cwd }
}
