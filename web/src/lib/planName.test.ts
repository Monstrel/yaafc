import { describe, expect, it } from 'vitest'
import { itemName } from './gameData'
import { planTitle, targetsName } from './planName'
import { emptyPlan } from './store'
import type { Plan } from './types'

const making = (items: string[], name = ''): Plan => ({
  ...emptyPlan(name),
  targets: items.map((item) => ({ item, rate: 10 })),
})

describe('plan names', () => {
  it('names an unnamed plan after its targets', () => {
    expect(planTitle(emptyPlan())).toBe('New plan')
    expect(planTitle(making(['WoodBoard']))).toBe(itemName('WoodBoard'))
    expect(planTitle(making(['WoodBoard', 'GoldCoin', 'WoodBoard']))).toBe(`${itemName('WoodBoard')} + ${itemName('GoldCoin')}`)
    expect(targetsName(making(['a', 'b', 'c', 'd']))).toBe('a + b + 2 more')
  })

  it('keeps a name the player gave, and treats the old default as unnamed', () => {
    expect(planTitle(making(['WoodBoard'], 'My boards'))).toBe('My boards')
    expect(planTitle(making(['WoodBoard'], 'New plan'))).toBe(itemName('WoodBoard'))
    expect(planTitle(making(['WoodBoard'], '  '))).toBe(itemName('WoodBoard'))
  })
})
