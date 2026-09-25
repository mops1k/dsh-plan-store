import { describe, expect, it } from 'vitest'

import { Config } from '../src/index'
import { PlanStoreSettingsSchema } from '../src/dsh/settings'

describe('startup-only plugin configuration', () => {
  it('keeps compatibility defaults in the runtime schema', () => {
    expect(Config({})).toMatchObject({ sessionStartGuide: true })
  })

  it('accepts a disabled session-start guide', () => {
    expect(Config({ sessionStartGuide: false })).toMatchObject({ sessionStartGuide: false })
  })

  it('keeps the startup-only field out of the native settings schema', () => {
    expect(PlanStoreSettingsSchema.dict).not.toHaveProperty('sessionStartGuide')
  })
})
