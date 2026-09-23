/**
 * Storage layout and small naming helpers.
 *
 * Layout (root is `$DSH_HOME/plan-store` or `~/.dsh/plan-store`):
 *   <root>/plans.db     SQLite database with the plans, phases, tasks and journal
 *
 * Exported plan files are written into the workspace itself, by default at
 * `<workspaceRoot>/.dsh/plans/<slug>.md`.
 *
 * @module dsh-plan-store/core/paths
 */
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/** Environment variable holding the dsh home directory. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name of the plugin storage inside the dsh home. */
export const STORE_DIR = 'plan-store'

/** File name of the SQLite database. */
export const DB_FILE = 'plans.db'

/** Default export directory, relative to the workspace root. */
export const DEFAULT_EXPORT_DIR = '.dsh/plans'

/** Maximum length of a generated slug. */
export const MAX_SLUG_LENGTH = 48

/** Fallback project key used when a session has no usable cwd. */
export const NO_WORKSPACE_KEY = '_no-workspace'

/** Resolve the dsh home directory: `$DSH_HOME`, then `~/.dsh`. */
export function dshHome(): string {
  const custom = (process.env[DSH_HOME_ENV] ?? '').trim()
  return custom.length > 0 ? resolve(custom) : join(homedir(), '.dsh')
}

/** Resolve the storage root: explicit override, then `$DSH_HOME/plan-store`. */
export function resolveStorageRoot(override?: string | null): string {
  const custom = typeof override === 'string' ? override.trim() : ''
  return custom.length > 0 ? resolve(custom) : join(dshHome(), STORE_DIR)
}

/** Absolute path of the plans database. */
export function plansDbPath(root?: string | null): string {
  return join(resolveStorageRoot(root), DB_FILE)
}

/** Prefixes used by the generated identifiers. */
export type IdPrefix = 'p' | 'ph' | 't' | 'e'

/** Generate a stable, prefixed identifier (`p_1a2b3c4d5e6f`). */
export function genId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

/** Cyrillic letters mapped to their Latin counterparts (lowercase). */
const TRANSLITERATION: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  і: 'i',
  ї: 'yi',
  є: 'ye',
  ґ: 'g',
}

/** Replace Cyrillic letters with Latin ones so Russian titles keep a usable slug. */
export function transliterate(value: string): string {
  let out = ''
  for (const char of value.toLowerCase()) out += TRANSLITERATION[char] ?? char
  return out
}

/** Turn arbitrary text into a lowercase kebab-case slug. */
export function slugify(value: string): string {
  const ascii = transliterate(
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]+/gu, ''),
  )
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (slug.length === 0) return 'plan'
  return slug.length > MAX_SLUG_LENGTH ? slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/u, '') : slug
}

/** Derive a workspace key from a session working directory. */
export function projectKeyFromCwd(cwd: string): string {
  const trimmed = (cwd ?? '').trim()
  if (trimmed.length === 0) return NO_WORKSPACE_KEY
  const name = basename(resolve(trimmed))
  return name.length > 0 ? name : NO_WORKSPACE_KEY
}
