#!/usr/bin/env node
/**
 * Post-upgrade compatibility check for dsh-plan-store.
 *
 * Since DSH 0.2.0-rc.2 the profile loader refuses to mount a bundle whose
 * `@deepseek-ai/dsh*` peerDependencies do not satisfy the running runtime
 * (`evaluatePluginCompatibility` in @deepseek-ai/dsh-app-boot): the whole
 * bundle is skipped, tools and WebUI silently disappear. This script fails
 * fast in that situation and additionally verifies that every runtime symbol
 * the plugin reaches for still exists in the installed DSH packages.
 *
 * Usage:
 *   node scripts/check-dsh-compat.mjs [--dsh-version 0.2.0-rc.2]
 *
 * Exit code 0 — the plugin can be mounted; 1 — the gate would skip it or a
 * runtime symbol is gone.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Runtime symbols the plugin imports or reaches through a service. */
const RUNTIME_CHECKS = [
  ['@deepseek-ai/dsh-tools', ['defineTool']],
  ['@deepseek-ai/dsh-llm', ['createUserMessage']],
  ['@deepseek-ai/dsh-system-prompt', ['SystemPrompt']],
  ['@deepseek-ai/dsh-host-webserver', ['WebServer']],
  ['@deepseek-ai/dsh-settings', ['SettingsForms']],
  ['@deepseek-ai/schemastery', ['default']],
]

/** Service methods the plugin calls on an injected context. */
const SERVICE_METHODS = [
  ['@deepseek-ai/dsh-tools', 'ToolRuntime', ['register', 'get', 'restrict']],
  ['@deepseek-ai/dsh-system-prompt', 'SystemPrompt', ['section']],
  ['@deepseek-ai/dsh-host-webserver', 'WebServer', ['register']],
  ['@deepseek-ai/dsh-settings', 'SettingsForms', ['configure']],
]

const failures = []
const notes = []

/** Read the running DSH version from the flag, the environment or the CLI. */
function runtimeVersion() {
  const flag = process.argv.indexOf('--dsh-version')
  if (flag !== -1 && process.argv[flag + 1] !== undefined) return process.argv[flag + 1]
  if (process.env.DSH_RUNTIME_VERSION) return process.env.DSH_RUNTIME_VERSION
  try {
    return execFileSync('dsh', ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    for (const candidate of ['@deepseek-ai/dsh-app-boot/package.json', '@deepseek-ai/dsh/package.json']) {
      try {
        return JSON.parse(readFileSync(require.resolve(candidate), 'utf8')).version
      } catch {
        /* try the next candidate */
      }
    }
    const installed = dshRoot()
    if (installed !== undefined) {
      try {
        return JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version
      } catch {
        /* fall through */
      }
    }
  }
  return undefined
}

/** Load semver from the installed DSH packages without declaring a dependency. */
function loadSemver() {
  for (const anchor of ['@deepseek-ai/dsh-tools/package.json', '@deepseek-ai/dsh-app-boot/package.json']) {
    try {
      return createRequire(require.resolve(anchor))('semver')
    } catch {
      /* try the next anchor */
    }
  }
  const installed = dshRoot()
  if (installed !== undefined) {
    try {
      return createRequire(join(installed, 'package.json'))('semver')
    } catch {
      /* give up */
    }
  }
  return undefined
}

/** Root directory of the globally installed DSH package, when there is one. */
function dshRoot() {
  try {
    const bin = execFileSync('sh', ['-c', 'readlink -f "$(command -v dsh)"'], { encoding: 'utf8' }).trim()
    return bin === '' ? undefined : dirname(dirname(bin))
  } catch {
    return undefined
  }
}

/** Import one runtime module from this repository or from the installed DSH. */
async function importRuntime(specifier) {
  try {
    return await import(specifier)
  } catch {
    /* not installed locally — fall back to the global DSH */
  }
  const installed = dshRoot()
  if (installed !== undefined) {
    try {
      const resolved = createRequire(join(installed, 'package.json')).resolve(specifier)
      return await import(pathToFileURL(resolved).href)
    } catch {
      /* give up */
    }
  }
  return undefined
}

const runtime = runtimeVersion()
const semver = loadSemver()

if (runtime === undefined) {
  failures.push('cannot determine the installed DSH version; pass --dsh-version <exact>')
}

const WORKSPACE_RANGES = ['workspace:^', 'workspace:~', 'workspace:*']
const peers = Object.entries(manifest.peerDependencies ?? {}).filter(
  ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
)

if (peers.length === 0) {
  notes.push('no @deepseek-ai/dsh* peerDependencies declared — the compatibility gate never evaluates this plugin')
}

for (const [name, range] of peers) {
  if (WORKSPACE_RANGES.includes(range)) {
    notes.push(`${name}: ${range} → always the running runtime`)
    continue
  }
  if (runtime === undefined) continue
  if (semver === undefined) {
    notes.push(`${name}: semver unavailable, range "${range}" not verified`)
    continue
  }
  if (!semver.satisfies(runtime, range, { includePrerelease: true })) {
    failures.push(`${name}: peer range "${range}" does not satisfy dsh ${runtime} — the bundle would be skipped`)
  }
}

for (const [specifier, symbols] of RUNTIME_CHECKS) {
  const module = await importRuntime(specifier)
  if (module === undefined) {
    notes.push(`${specifier}: not resolvable here (no local peers and no global dsh) — symbols not verified`)
    continue
  }
  for (const symbol of symbols) {
    if (module[symbol] === undefined) failures.push(`${specifier}: export "${symbol}" is gone`)
  }
}

for (const [specifier, className, methods] of SERVICE_METHODS) {
  const module = await importRuntime(specifier)
  if (module === undefined) continue
  const klass = module[className]
  if (typeof klass !== 'function') {
    failures.push(`${specifier}: class "${className}" is gone`)
    continue
  }
  for (const method of methods) {
    if (typeof klass.prototype?.[method] !== 'function') {
      failures.push(`${specifier}: ${className}.${method}() is gone`)
    }
  }
}

for (const note of notes) console.log(`note: ${note}`)
for (const failure of failures) console.error(`FAIL: ${failure}`)

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} incompatibility(ies) found for dsh ${runtime ?? 'unknown'}.`)
  process.exit(1)
}

console.log(`ok: dsh-plan-store is compatible with dsh ${runtime ?? 'unknown'}`)
