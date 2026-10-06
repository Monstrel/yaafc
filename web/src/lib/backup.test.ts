import { describe, expect, it } from 'vitest'
import { findRecipes } from './cauldron'
import { cauldronIngredients, HEAT } from './gameData'
import { mergeBackup } from './importPlans'
import { buildCatalog } from './processes'
import { sanitizeMyDefaults, sanitizePlans } from './sanitize'
import { solvePlan } from './solver'
import { parseBackup, type Backup } from './store'
import type { Plan, SavedRecipe } from './types'
import { modifiers } from './upgrades'

let next = 0
const newId = () => `new${next++}`

const plan = (partial: Partial<Plan>): Plan => ({ id: 'p', name: 'Plan', targets: [], producers: {}, machines: {}, ...partial })

describe('reading a backup file', () => {
  it('turns down files that are not backups', () => {
    expect(() => parseBackup('not json')).toThrow('Not an Alchemy Calculator backup file')
    expect(() => parseBackup('null')).toThrow('Not an Alchemy Calculator backup file')
    expect(() => parseBackup('{"plans": {}, "savedRecipes": []}')).toThrow('Not an Alchemy Calculator backup file')
  })

  it('keeps only the parts of a malformed file that fit, so nothing it loads can crash the app', () => {
    const backup = parseBackup(
      JSON.stringify({
        savedRecipes: [{}, null, { id: 'r', mode: 'normal', inputs: ['Salt'], output: 'X' }, { id: 'r', mode: 'evil' }],
        plans: [
          {},
          null,
          7,
          {
            id: 'a',
            name: { toString: 'x' },
            producers: 'oops',
            machines: { 'recipe:Coke': 5 },
            targets: [{ item: 'Salt', rate: 'lots' }, { item: 'Salt', rate: 10, unit: 'bogus', feedback: 'yes' }, null],
            branches: { '0/Salt': { producer: 3 }, '0/Coke': { producer: 'recipe:Coke', reuse: 1 } },
            separate: [{ item: 'Salt', anchor: 4 }, {}],
            roundUp: ['0/Salt', 3],
          },
        ],
        progress: { upgrades: { FactorySpeed: 'max', Conveyer: 3 }, tier: '9' },
        myDefaults: { Salt: { producer: 'recipe:Salt_Alt', catalysts: 'Catalyst2' }, Coke: 'recipe:Coke' },
      }),
    )
    expect(backup.savedRecipes).toEqual([])
    expect(backup.plans).toHaveLength(2)
    const [blank, a] = backup.plans
    expect(blank).toMatchObject({ name: 'Untitled plan', targets: [{ item: '', rate: 10 }], producers: {}, machines: {} }) // never empty
    expect(blank.id).not.toBe('')
    expect(a).toEqual({
      id: 'a',
      name: 'Untitled plan',
      targets: [{ item: 'Salt', rate: 10 }],
      producers: {},
      machines: {},
      branches: { '0/Coke': { producer: 'recipe:Coke' } },
      separate: [{ item: 'Salt' }],
      roundUp: ['0/Salt'],
    })
    expect(backup.progress).toEqual({ upgrades: { Conveyer: 3 } })
    expect(backup.myDefaults).toEqual({ Salt: { producer: 'recipe:Salt_Alt' } })
  })

  it('gives repeated ids new ones', () => {
    const plans = sanitizePlans([plan({ id: 'x' }), plan({ id: 'x' }), plan({ id: '' })], newId)!
    expect(new Set(plans.map((p) => p.id)).size).toBe(3)
    expect(plans[0].id).toBe('x')
  })

  it("can't reach Object.prototype through its keys", () => {
    const defaults = sanitizeMyDefaults(JSON.parse('{"__proto__": {"producer": "x"}, "constructor": {"producer": "y"}, "Salt": {"producer": "z"}}'))!
    expect(Object.keys(defaults)).toEqual(['Salt'])
    expect(Object.getPrototypeOf(defaults)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).producer).toBeUndefined()
  })

  it('keeps a well-formed backup as it was', () => {
    const backup: Backup = {
      version: 1,
      savedRecipes: [{ id: 'r', mode: 'advanced', inputs: ['Salt', 'Coal'], output: 'X', name: 'Mine', note: 'n', createdAt: 5 }],
      plans: [
        plan({
          targets: [{ item: 'Salt', rate: 10, unit: 'machines', feedback: false }],
          producers: { Salt: 'recipe:Salt_Alt' },
          machines: { 'recipe:Coke': 'AdvancedAthanor' },
          branches: { '0/Salt': { producer: 'import', machine: 'M', reuse: true } },
          feedbackItems: ['Coal'],
          rowStacks: { '0/Salt': 20 },
          rowCatalysts: { '0/Coke': ['Catalyst2'] },
          separate: [{ item: 'Salt', anchor: 'Coke', at: '0/Coke' }],
          noReuse: ['Salt'],
          roundUp: ['0/Salt'],
        }),
      ],
      progress: { upgrades: { FactorySpeed: 3 }, tier: 4 },
      myDefaults: { Coke: { producer: 'recipe:Coke', machine: 'AdvancedAthanor', catalysts: ['Catalyst2'] } },
    }
    expect(parseBackup(JSON.stringify(backup))).toEqual(backup)
  })
})

describe('adding a backup to your own plans', () => {
  const mods = modifiers({})
  const [one, two] = findRecipes('Catalyst2', 'normal', cauldronIngredients, 5000)
  const recipe = (id: string, inputs: string[]): SavedRecipe => ({ id, mode: 'normal', inputs, output: 'Catalyst2', createdAt: 0 })
  const backupOf = (partial: Partial<Backup>): Backup => ({ version: 1, savedRecipes: [], plans: [], ...partial })

  it('shares saved recipes already saved, and points the plans at the copy kept', () => {
    const mine = { saved: [recipe('a', one.inputs), recipe('b', two.inputs)], plans: [plan({ id: 'p', name: 'Plan' })] }
    const theirs = backupOf({
      // Their 'a' is my 'b'; their 'b' is new but its id is taken.
      savedRecipes: [recipe('a', two.inputs), recipe('b', ['Salt', 'Salt', 'Coal'])],
      plans: [
        plan({
          id: 'p',
          name: 'Plan',
          producers: { Catalyst2: 'cauldron:a', Other: 'cauldron:b' },
          branches: { '0/Catalyst2': { producer: 'cauldron:b' } },
        }),
      ],
    })
    const merged = mergeBackup(mine, theirs, newId)
    expect(merged.saved.map((s) => s.id).slice(0, 2)).toEqual(['a', 'b'])
    expect(merged.saved).toHaveLength(3)
    expect(merged.addedRecipes).toBe(1)
    const added = merged.saved[2].id
    expect(added).not.toBe('b')

    const [p] = merged.added
    expect(p.id).not.toBe('p')
    expect(p.name).toBe('Plan (imported)')
    expect(p.producers).toEqual({ Catalyst2: 'cauldron:b', Other: `cauldron:${added}` })
    expect(p.branches).toEqual({ '0/Catalyst2': { producer: `cauldron:${added}` } })
    expect(merged.plans.map((x) => x.id)).toEqual(['p', p.id])
  })

  it("makes the file's plans the way they were exported, without taking on its defaults", () => {
    const theirs = backupOf({
      plans: [plan({ targets: [{ item: 'Coke', rate: 10 }, { item: 'Salt', rate: 10 }] })],
      myDefaults: {
        Coke: { producer: 'recipe:Coke', machine: 'AdvancedAthanor', catalysts: ['Catalyst2'] },
        Salt: { producer: 'recipe:Salt_Alt' },
        [HEAT]: { producer: 'fuel:Coal' },
      },
    })
    const { added } = mergeBackup({ saved: [], plans: [] }, theirs, newId)
    // Solved without any defaults of mine.
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'BasicFertilizer', mine: {} })
    const [coke, salt] = solvePlan(added[0], catalog, mods).tree
    expect(salt.producer).toBe('recipe:Salt_Alt')
    expect(coke.run?.process.machine?.key).toBe('AdvancedAthanor')
    expect(coke.run?.process.catalysts).toEqual(['Catalyst2'])
    expect(added[0].producers[HEAT]).toBe('fuel:Coal')
  })
})
