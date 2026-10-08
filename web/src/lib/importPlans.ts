import { recipeSignature } from './cauldron'
import { HEAT, NUTRIENTS } from './gameData'
import { planFertilizer } from './planModel'
import { namedAfterTargets } from './planName'
import { DEFAULT_BANK_STACK, buildCatalog } from './processes'
import type { Backup } from './store'
import type { MyDefaults, Plan, Progress, SavedRecipe } from './types'
import { planChoice, unfold } from './unfold'
import { modifiers } from './upgrades'

const SAVED = 'cauldron:'

export interface Merged {
  saved: SavedRecipe[]
  plans: Plan[]
  /** The file's plans as added (new ids where they clashed). */
  added: Plan[]
  /** How many of the file's saved recipes were new. */
  addedRecipes: number
}

/**
 * Adds a file's plans and saved recipes next to the player's own, keeping their upgrades and
 * defaults. Recipes the player already saved are shared rather than doubled, and the plans point
 * at whichever copy is kept. Where the file's plans followed its own saved defaults, those become
 * the plans' own picks, so each plan is made the way it was exported.
 */
export function mergeBackup(mine: { saved: SavedRecipe[]; plans: Plan[] }, backup: Backup, newId: () => string): Merged {
  const bySignature = new Map(mine.saved.map((s) => [recipeSignature(s.mode, s.inputs), s.id]))
  const usedIds = new Set(mine.saved.map((s) => s.id))
  const ids = new Map<string, string>()
  const addedRecipes: SavedRecipe[] = []
  for (const s of backup.savedRecipes) {
    const signature = recipeSignature(s.mode, s.inputs)
    const kept = bySignature.get(signature)
    if (kept !== undefined) {
      ids.set(s.id, kept)
      continue
    }
    let id = s.id
    while (usedIds.has(id)) id = newId()
    usedIds.add(id)
    bySignature.set(signature, id)
    ids.set(s.id, id)
    addedRecipes.push(id === s.id ? s : { ...s, id })
  }
  const saved = [...mine.saved, ...addedRecipes]

  const remap = (producer: string) =>
    producer.startsWith(SAVED) ? SAVED + (ids.get(producer.slice(SAVED.length)) ?? producer.slice(SAVED.length)) : producer
  const defaults: MyDefaults = Object.fromEntries(
    Object.entries(backup.myDefaults ?? {}).map(([item, d]) => [item, { ...d, producer: remap(d.producer) }]),
  )

  const planIds = new Set(mine.plans.map((p) => p.id))
  // Plans named after their targets keep that: their name follows what they make.
  const names = new Set(mine.plans.filter((p) => !namedAfterTargets(p)).map((p) => p.name))
  const added = backup.plans.map((p) => {
    let id = p.id
    while (planIds.has(id)) id = newId()
    planIds.add(id)
    const name = names.has(p.name) ? `${p.name} (imported)` : p.name
    return { ...withDefaults(remapPlan(p, remap), defaults, saved, backup.progress), id, name }
  })
  return { saved, plans: [...mine.plans, ...added], added, addedRecipes: addedRecipes.length }
}

function remapPlan(plan: Plan, remap: (producer: string) => string): Plan {
  const keys = <T>(rows: Record<string, T>) => Object.fromEntries(Object.entries(rows).map(([k, v]) => [remap(k), v]))
  return {
    ...plan,
    producers: Object.fromEntries(Object.entries(plan.producers).map(([item, p]) => [item, remap(p)])),
    machines: keys(plan.machines),
    ...(plan.branches && {
      branches: Object.fromEntries(Object.entries(plan.branches).map(([id, b]) => [id, { ...b, producer: remap(b.producer) }])),
    }),
    ...(plan.catalysts && { catalysts: keys(plan.catalysts) }),
  }
}

/** The plan with the rows that followed `defaults` picking the same, so they don't need them. */
function withDefaults(plan: Plan, defaults: MyDefaults, saved: SavedRecipe[], progress: Progress | undefined): Plan {
  if (!Object.keys(defaults).length) return plan
  try {
    const catalog = buildCatalog({
      saved,
      machines: plan.machines,
      mods: modifiers(progress?.upgrades ?? {}),
      fertilizer: planFertilizer(plan),
      tier: progress?.tier,
      mine: defaults,
    })
    const branches = { ...plan.branches }
    const rowCatalysts = { ...plan.rowCatalysts }
    const rowHeights = { ...plan.rowHeights }
    const rowStacks = { ...plan.rowStacks }
    const mixedFeed = { ...plan.mixedFeed }
    for (const n of unfold(plan, catalog).nodes) {
      const d = n.mine ? defaults[n.item] : undefined
      if (!d) continue
      branches[n.id] = { ...branches[n.id], producer: d.producer, ...(d.machine && { machine: d.machine }) }
      if (n.defaultCatalysts.length && !rowCatalysts[n.id]) rowCatalysts[n.id] = [...n.defaultCatalysts]
      if (n.defaultHeight && rowHeights[n.id] === undefined) rowHeights[n.id] = n.defaultHeight
      if (n.process?.stack !== undefined && n.defaultStack !== DEFAULT_BANK_STACK && rowStacks[n.id] === undefined)
        rowStacks[n.id] = n.defaultStack
      if (n.defaultMixed && n.mixable?.length && mixedFeed[n.id] === undefined) mixedFeed[n.id] = true
    }
    // Heat and nutrients come off the bus rather than from rows: the plan-wide pick says what feeds them.
    const producers = { ...plan.producers }
    for (const item of [HEAT, NUTRIENTS]) {
      const choice = planChoice(plan, catalog, item)
      if (choice.mine) producers[item] = choice.producer
    }
    return {
      ...plan,
      producers,
      branches,
      rowCatalysts,
      rowHeights: Object.keys(rowHeights).length ? rowHeights : undefined,
      rowStacks: Object.keys(rowStacks).length ? rowStacks : undefined,
      mixedFeed: Object.keys(mixedFeed).length ? mixedFeed : undefined,
    }
  } catch {
    // A plan the catalog can't lay out still imports, just without its defaults.
    return plan
  }
}
