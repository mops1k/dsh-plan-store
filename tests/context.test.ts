import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

import { DEFAULT_SYSTEM_PROMPT } from '../src/core/config'
import {
  PLAN_STORE_GUIDE,
  promptSectionText,
  registerPlanContext,
  registerPlanPrompt,
  runPlanCommand,
} from '../src/dsh/context'
import { makeHarness, type TestHarness } from './helpers'

interface ContextHarness {
  ctx: Context
  sections: PromptSection[]
  listeners: Array<{ event: string; callback: (...args: never[]) => void }>
  commands: CommandDefinition[]
}

/** Build a host context that records sections, listeners and commands. */
function makeContextHarness(cwd: string | null): ContextHarness {
  const sections: PromptSection[] = []
  const listeners: Array<{ event: string; callback: (...args: never[]) => void }> = []
  const commands: CommandDefinition[] = []
  const ctx = {
    logger: { warn: () => {} },
    systemPrompt: {
      section(section: PromptSection): () => void {
        sections.push(section)
        return () => {}
      },
    },
    on(event: string, callback: (...args: never[]) => void): () => void {
      listeners.push({ event, callback })
      return () => {}
    },
    inject(services: string[], callback: (child: unknown) => void): () => void {
      if (services.includes('commands')) {
        callback({
          commands: {
            register(definition: CommandDefinition): () => void {
              commands.push(definition)
              return () => {}
            },
          },
        })
      }
      return () => {}
    },
    sessions: { get: () => (cwd === null ? undefined : { header: { cwd } }) },
  } as unknown as Context
  return { ctx, sections, listeners, commands }
}

/** Minimal invocation shape accepted by `runPlanCommand`. */
function invocation(rawInput: string): CommandInvocation {
  return { rawInput, agent: { id: 'agent-1' } } as unknown as CommandInvocation
}

let harness: TestHarness

beforeEach(() => {
  harness = makeHarness()
})

afterEach(() => {
  harness.cleanup()
})

describe('system-prompt section', () => {
  it('registers the plan-store section with the configured guidance', () => {
    const { ctx, sections } = makeContextHarness(harness.workspace)
    registerPlanPrompt(ctx, harness.engine, harness.config)
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe('plan-store')
    expect(sections[0]?.order).toBe(160)
    const text = typeof sections[0]?.text === 'function' ? sections[0].text({}) : String(sections[0]?.text)
    expect(text).toContain(DEFAULT_SYSTEM_PROMPT)
    expect(text).not.toContain('Plans currently active')
  })

  it('appends the active-plan summary and follows the setting', () => {
    const created = harness.engine.createPlan({ title: 'Active plan', workspace: 'demo', phases: [{ title: 'Work', tasks: ['a'] }] })
    harness.engine.updateTask(created.phases[0]!.tasks[0]!.id, { status: 'doing' })

    const withSummary = promptSectionText(harness.engine, harness.config)
    expect(withSummary).toContain('Plans currently active or blocked in the store:')
    expect(withSummary).toContain('(demo)')
    expect(withSummary).toContain('next: a')

    const disabled = promptSectionText(harness.engine, { ...harness.config, promptActivePlans: false })
    expect(disabled).not.toContain('Plans currently active')

    const zeroLimit = promptSectionText(harness.engine, { ...harness.config, promptActiveLimit: 0 })
    expect(zeroLimit).not.toContain('Plans currently active')
  })

  it('keeps the default prompt neutral about full-only tools', () => {
    const text = promptSectionText(harness.engine, harness.config)
    expect(text).toContain('plan_create')
    expect(text).toContain('plan_export')
    for (const name of [
      'plan_delete',
      'plan_purge',
      'plan_phase_delete',
      'plan_task_delete',
      'plan_status',
      'plan_import_session',
    ]) {
      expect(text).not.toContain(name)
    }
  })

  it('reports a failing summary through the error sink', () => {
    const messages: string[] = []
    const broken = { promptSummary: () => { throw new Error('boom') } } as never
    const text = promptSectionText(broken, harness.config, (message) => messages.push(message))
    expect(text).toContain(DEFAULT_SYSTEM_PROMPT)
    expect(messages[0]).toContain('boom')
  })
})

describe('session-start guide', () => {
  it('injects the plan guide into a starting session', () => {
    const { ctx, listeners } = makeContextHarness(harness.workspace)
    registerPlanContext(ctx, harness.engine, harness.config)
    const listener = listeners.find((entry) => entry.event === 'agent/session-start')
    expect(listener).toBeDefined()

    const injected: Array<{ content: Array<{ type: string; text?: string }> }> = []
    const agent = { inject: (message: unknown) => injected.push(message as never) }
    listener!.callback({ agent } as never)

    expect(injected).toHaveLength(1)
    expect(injected[0]?.content[0]?.text).toBe(PLAN_STORE_GUIDE)
    expect(PLAN_STORE_GUIDE).toContain('plan_export')
  })

  it('does not register a session-start listener when the startup guide is disabled', () => {
    const { ctx, listeners, sections, commands } = makeContextHarness(harness.workspace)
    registerPlanContext(ctx, harness.engine, { ...harness.config, sessionStartGuide: false })
    registerPlanPrompt(ctx, harness.engine, harness.config)

    expect(listeners.some((entry) => entry.event === 'agent/session-start')).toBe(false)
    expect(sections).toHaveLength(1)
    expect(commands.map((command) => command.name)).toEqual(['plans'])
  })
})

describe('/plans command', () => {
  it('registers the command and lists, reports and exports plans', async () => {
    const { ctx, commands } = makeContextHarness(harness.workspace)
    registerPlanContext(ctx, harness.engine, harness.config)
    expect(commands.map((command) => command.name)).toEqual(['plans'])

    const created = harness.engine.createPlan({ title: 'Command plan', phases: [{ title: 'Work', tasks: ['a'] }] })

    const listed = await runPlanCommand(invocation('list'), ctx, harness.engine)
    expect(listed.kind).toBe('success')
    expect(listed.text).toContain('Command plan')

    const status = await runPlanCommand(invocation('status'), ctx, harness.engine)
    expect(status.kind).toBe('success')
    expect(status.text).toContain('Plan store: 1 plan(s)')

    const exported = await runPlanCommand(invocation(`export ${created.id}`), ctx, harness.engine)
    expect(exported.kind).toBe('success')
    expect(exported.text).toContain('.dsh/plans/command-plan.md')
    expect(existsSync(join(harness.workspace, '.dsh/plans/command-plan.md'))).toBe(true)

    const all = await runPlanCommand(invocation('export'), ctx, harness.engine)
    expect(all.kind).toBe('success')
    expect(all.text).toContain('Exported 1 plan(s)')

    const unknown = await runPlanCommand(invocation('bogus'), ctx, harness.engine)
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toContain('Unknown plans subcommand')
  })

  it('archives the session plans, and the session itself when the host supports it', async () => {
    const bare = makeContextHarness(harness.workspace)
    const created = harness.engine.createPlan({ title: 'Session plan' }, { sessionId: 'agent-1' })

    const unsupported = await runPlanCommand(invocation('archive-session'), bare.ctx, harness.engine)
    expect(unsupported.kind).toBe('success')
    expect(unsupported.text).toContain('cannot archive the session itself')
    expect(unsupported.text).toContain('archived 1 plan(s)')
    expect(harness.engine.requireTree(created.id).status).toBe('archived')

    const hosted = makeContextHarness(harness.workspace)
    const archived: string[] = []
    ;(hosted.ctx as unknown as { workspaceRegistry: unknown }).workspaceRegistry = {
      list: () => [],
      archivedSessionIds: [],
      archiveSession: async (sessionId: string) => {
        archived.push(sessionId)
      },
    }
    const second = harness.engine.createPlan({ title: 'Session plan 2' }, { sessionId: 'agent-1' })
    const supported = await runPlanCommand(invocation('archive-session'), hosted.ctx, harness.engine)
    expect(supported.kind).toBe('success')
    expect(supported.text).toContain('Session archived')
    expect(supported.text).toContain('archived 1 plan(s)')
    expect(archived).toEqual(['agent-1'])
    expect(harness.engine.requireTree(second.id).status).toBe('archived')
  })

  it('reports an error when the session has no working directory', async () => {
    const { ctx } = makeContextHarness(null)
    const result = await runPlanCommand(invocation('export p_x'), ctx, harness.engine)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('working directory')
  })
})
