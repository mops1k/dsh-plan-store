import { describe, expect, it } from 'vitest'

import { genId, projectKeyFromCwd, slugify, transliterate } from '../src/core/paths'

describe('slugify', () => {
  it('builds kebab-case slugs from latin text', () => {
    expect(slugify('Kanban board: v2!')).toBe('kanban-board-v2')
    expect(slugify('  spaced  out  ')).toBe('spaced-out')
  })

  it('transliterates cyrillic so russian titles keep a usable name', () => {
    expect(transliterate('Плагин планов в БД')).toBe('plagin planov v bd')
    expect(slugify('Правки по замечаниям')).toBe('pravki-po-zamechaniyam')
    expect(slugify('dsh-plan-store: плагин планов в БД (сессия 23.09.2026)')).toBe(
      'dsh-plan-store-plagin-planov-v-bd-sessiya-23-09',
    )
  })

  it('falls back for text without usable characters and truncates long slugs', () => {
    expect(slugify('!!!')).toBe('plan')
    expect(slugify('ёж')).toBe('ezh')
    expect(slugify('a'.repeat(80)).length).toBeLessThanOrEqual(48)
  })
})

describe('identifiers', () => {
  it('prefixes generated ids', () => {
    expect(genId('p')).toMatch(/^p_[0-9a-f]{12}$/)
    expect(genId('ph')).toMatch(/^ph_[0-9a-f]{12}$/)
    expect(genId('t')).toMatch(/^t_[0-9a-f]{12}$/)
    expect(genId('e')).toMatch(/^e_[0-9a-f]{12}$/)
  })

  it('derives a workspace key from a cwd', () => {
    expect(projectKeyFromCwd('/home/mops1k/Development/dsh-plan-store')).toBe('dsh-plan-store')
    expect(projectKeyFromCwd('   ')).toBe('_no-workspace')
  })
})
