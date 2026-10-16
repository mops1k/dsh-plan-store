import { describe, expect, it } from 'vitest'

import { Config } from '../src/index'
import { PlanStoreSettingsSchema } from '../src/dsh/settings'

describe('startup-only plugin configuration', () => {
  it('keeps the session-start guide off by default', () => {
    expect(Config({})).toMatchObject({ sessionStartGuide: false })
  })

  it('accepts an enabled session-start guide', () => {
    expect(Config({ sessionStartGuide: true })).toMatchObject({ sessionStartGuide: true })
  })

  it('keeps the startup-only field out of the native settings schema', () => {
    expect(PlanStoreSettingsSchema.dict).not.toHaveProperty('sessionStartGuide')
  })
})
