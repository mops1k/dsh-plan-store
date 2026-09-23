#!/usr/bin/env node
/**
 * Live acceptance check for dsh-plan-store.
 *
 * Run it after restarting the dsh profile that has the plugin installed:
 *
 *   node scripts/verify-live.mjs            # defaults to http://127.0.0.1:3080/plan-store
 *   PLAN_STORE_URL=http://127.0.0.1:3080/plan-store node scripts/verify-live.mjs
 *
 * It exercises the running server end to end (create with a rich task, notes,
 * transliterated export path, session bridge) and cleans up the probe plan and
 * its files afterwards. A failing "export slug" check means the running process
 * still holds the previous build: restart the profile and run it again.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const base = (process.env['PLAN_STORE_URL'] ?? 'http://127.0.0.1:3080/plan-store').replace(/\/+$/u, '')
const workspace = process.env['PLAN_STORE_WORKSPACE'] ?? '/tmp/dsh-plan-store-verify'
const title = 'Проверка транслитерации slug'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`)
}

async function request(path, init) {
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  let body = null
  try {
    body = text.length > 0 ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body }
}

const post = (path, payload) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

let planId = null
try {
  const config = await request('/api/config')
  check('server reachable', config.status === 200, `GET /api/config -> ${config.status}`)
  check('web path', config.body?.webPath === '/plan-store', String(config.body?.webPath))

  const created = await post('/api/plan/create', {
    title,
    description: 'Локальная проверка приёмки плагина',
    workspaceRoot: workspace,
    phases: [
      {
        title: 'Проверка',
        notes: 'заметки фазы',
        tasks: [{ title: 'богатая задача', notes: 'заметка задачи', status: 'doing', links: ['README.md'] }],
      },
    ],
  })
  planId = created.body?.plan?.id ?? null
  const plan = created.body?.plan
  check('plan created', created.status === 200 && typeof planId === 'string', String(planId))
  check('phase notes kept', plan?.phases?.[0]?.notes === 'заметки фазы')
  check('task notes/status/links kept', plan?.phases?.[0]?.tasks?.[0]?.notes === 'заметка задачи' && plan?.phases?.[0]?.tasks?.[0]?.status === 'doing')

  const exported = await post('/api/export', { id: planId, workspaceRoot: workspace })
  const path = String(exported.body?.path ?? '')
  const file = path.split('/').pop() ?? ''
  check('export written', exported.status === 200 && existsSync(path), path)
  check(
    'export slug transliterated (new build)',
    file.length > 0 && !file.startsWith('slug') && file.includes('proverka'),
    file || 'no file',
  )
  check('export contains description and notes', existsSync(path) && readFileSync(path, 'utf8').includes('Локальная проверка приёмки плагина'))
  check('export file has the plan id (id shown by plan_get)', typeof planId === 'string')

  const state = await request('/api/session/state')
  check('session bridge answers', state.status === 200, `GET /api/session/state -> ${state.status}`)
  const session = state.body?.state
  check('session detected', typeof session?.sessionId === 'string', String(session?.sessionId ?? 'none'))
  console.log(
    `INFO goal: ${session?.goal ? `${session.goal.phase} · ${session.goal.objective}` : 'none'} (source: ${session?.goalSource ?? 'n/a'}) | todos: ${(session?.todos ?? []).length} (source: ${session?.todosSource ?? 'n/a'})`,
  )
} catch (error) {
  check('script completed', false, error instanceof Error ? error.message : String(error))
} finally {
  if (planId !== null) {
    const purged = await post('/api/plan/purge', { id: planId, confirm: true }).catch(() => null)
    console.log(`INFO probe plan ${planId} purged: ${purged?.body?.purged === true}`)
  }
  rmSync(join(workspace, '.kilo'), { recursive: true, force: true })
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('Failed:', failed.map((entry) => entry.name).join(', '))
  console.log('Hint: a failed export-slug check means the running profile still holds the previous build — restart it and rerun.')
  process.exitCode = 1
}
