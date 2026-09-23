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

/** Evaluate the classic browser bundle against a stub module loader. */
function loadClient(): { loaded: LoadedModule[]; exported: Record<string, unknown> } {
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
    if (name === 'react') return React
    throw new Error(`unexpected module request: ${name}`)
  })
  return { loaded, exported }
}

/** Build a host context that records slot registrations. */
function makeClientContext(settingsScope: unknown): { ctx: unknown; slots: RegisteredSlot[] } {
  const slots: RegisteredSlot[] = []
  const ctx = {
    settingsScope,
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

/** Working settings scope stub. */
function workingScope(): unknown {
  return {
    bind: () => ({
      getSnapshot: () => ({ value: { webPath: '/plan-store' }, status: 'ready', revision: 1 }),
      subscribe: () => () => {},
      set: async () => {},
    }),
  }
}

describe('client bundle', () => {
  it('registers one module under the plugin id', () => {
    const { loaded, exported } = loadClient()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.id).toBe('dsh-plan-store')
    expect(typeof exported['apply']).toBe('function')
    expect(exported['inject']).toEqual(['slots', 'settingsScope', 'sessions'])
  })

  it('registers the board view, the goals view and the settings card', () => {
    const { exported } = loadClient()
    const { ctx, slots } = makeClientContext(workingScope())
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

  it('still applies when the settings scope is unavailable', () => {
    const { exported } = loadClient()
    const broken = {
      bind: () => {
        throw new Error('no settings service')
      },
    }
    const { ctx, slots } = makeClientContext(broken)
    expect(() => (exported['apply'] as (context: unknown) => void)(ctx)).not.toThrow()
    expect(slots).toHaveLength(3)
  })
})
