import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

import { PLAN_FULL_ONLY_TOOL_NAMES } from '../src/dsh/tools'
import { apply, Config, inject, name } from '../src/tool-restrict'

describe('dsh-plan-store tool restriction', () => {
  it('exposes a scoped plugin that denies the exact full-only set by default', () => {
    expect(name).toBe('dsh-plan-store-tool-restrict')
    expect(inject).toEqual(['tools'])

    const restrict = vi.fn(() => () => {})
    const ctx = { tools: { restrict } } as unknown as Context
    apply(ctx, Config({}))

    expect(restrict).toHaveBeenCalledWith({ deny: [...PLAN_FULL_ONLY_TOOL_NAMES] })
  })

  it('accepts an explicit deny list and rejects unknown tools', () => {
    expect(Config({ deny: ['plan_status'] }).deny).toEqual(['plan_status'])
    expect(() => Config({ deny: ['plan_create'] })).toThrow()
  })

  it('fails loudly when mounted on an unscoped context', () => {
    const ctx = new Context()
    ctx.provide('systemPrompt', {
      tools: (): void => {},
      section: (): (() => void) => () => {},
      getSectionOrder: () => 0,
    })
    new ToolRuntime(ctx)

    expect(() => apply(ctx, Config({}))).toThrow(/requires a scoped context/u)
  })

  it('publishes the built subpath through package exports', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>
    }
    expect(manifest.exports['./tool-restrict']).toEqual({
      types: './lib/tool-restrict.d.ts',
      default: './lib/tool-restrict.js',
    })
  })
})
