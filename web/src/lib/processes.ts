import { cauldronStats, evaluate } from './cauldron'
import {
  ADVANCED_ATHANOR,
  ADVANCED_CAULDRON,
  ATHANOR,
  CATALYSTS,
  HEAT,
  heightMultiplier,
  NURSERY,
  NUTRIENTS,
  MAX_TIER,
  MINI_WORLD_TREE,
  WORLD_TREE_NURSERY,
  buyTier,
  coinValue,
  gameRecipes,
  itemName,
  items,
  itemsByKey,
  licenseFor,
  machinesByKey,
  machineTier,
  machinesForCraftType,
  recipeTier,
  seeds,
  type GameRecipe,
  type Machine,
  type Stack,
} from './gameData'
import { noun } from './plural'
import { itemsPerSlot } from './machineRate'
import type { MyDefaults, SavedRecipe } from './types'
import type { Modifiers } from './upgrades'

export type ProcessKind = 'recipe' | 'cauldron' | 'nursery' | 'paradox' | 'fuel' | 'fertilizer'

/**
 * One way of turning inputs into outputs, normalised to a single craft.
 * Heat and nutrients appear as pseudo-item inputs so the solver balances them like any item.
 */
export interface Process {
  id: string
  kind: ProcessKind
  label: string
  /** Name the player gave a saved cauldron recipe. */
  name?: string
  /** Main product: the item this process is offered as a producer for. */
  product: string
  /** Guaranteed side outputs (not fail products); the process is also offered as their producer. */
  secondary: string[]
  machine: Machine | null
  /** Machines able to run this process (for the machine picker). */
  machineOptions: Machine[]
  /** Seconds per craft on the chosen machine at Factory Efficiency level 0. */
  seconds: number
  inputs: Stack[]
  /** Expected outputs per craft (fail chances averaged in). */
  outputs: Stack[]
  alternate: boolean
  notes: string[]
  /** Catalysts applied (item keys), when running on an Advanced Athanor. */
  catalysts: string[]
  /** Whether this process can take catalysts on its current machine. */
  acceptsCatalysts: boolean
  /** Height its machines are built at, in grid spaces, when that sets their output (else 0). */
  height: number
  /** Whether its current machine's output depends on the height it's built at (Thermal Extractor). */
  acceptsHeight: boolean
  /** Research tier its recipe and machine need (seeds too, for nurseries). */
  tier: number
  /** License the recipe needs, if any (alternate ingots). */
  license?: string
  /** Seed planted in its Nursery (not set for World Trees, which have no choice of seed). */
  seed?: string
}

export interface ProcessContext {
  saved: SavedRecipe[]
  /** Chosen machine per process id. */
  machines: Record<string, string>
  mods: Modifiers
  /** Fertilizer item feeding nurseries (sets their growth speed). */
  fertilizer: string | null
  /** Catalysts loaded per process id (Advanced Athanor). */
  catalysts?: Record<string, string[]>
  /** Height machines are built at per process id, where it sets their output (Thermal Extractor). */
  heights?: Record<string, number>
  /** Research tier reached: defaults stick to what it unlocks (all tiers when absent). */
  tier?: number
  /** The player's saved defaults, used where a plan picks nothing. */
  mine?: MyDefaults
}

function merge(stacks: Stack[]): Stack[] {
  const map = new Map<string, number>()
  for (const s of stacks) if (s.count) map.set(s.item, (map.get(s.item) ?? 0) + s.count)
  return [...map].map(([item, count]) => ({ item, count }))
}

/** The plan's pick, else the first machine the research tier unlocks, else the first. */
function pickMachine(id: string, options: Machine[], ctx: ProcessContext): Machine | null {
  return (
    options.find((m) => m.key === ctx.machines[id]) ??
    options.find((m) => machineTier(m.key) <= (ctx.tier ?? MAX_TIER)) ??
    options[0] ??
    null
  )
}

/**
 * Items moved by one full craft. A recipe runs `batch` steps of `time` seconds; each step moves
 * `count` of every ingredient and product. Bundle items (negative max stack, e.g. a Log = 200 plank
 * fractions, a Jupiter = 300 fractions) are counted in fractions by the recipe, so divide by the
 * bundle size: 1 Log → 200 Planks, and 1,200 Planks + 1,800 Gears + 600 Pulleys → 1 Jupiter.
 */
function perCraft(s: Stack, batch: number): number {
  const stack = itemsByKey.get(s.item)?.maxStack ?? 1
  return (s.count * batch) / (stack < 0 ? -stack : 1)
}

function recipeProcess(r: GameRecipe, ctx: ProcessContext): Process {
  const id = `recipe:${r.key}`
  const isCauldron = r.craftType === 'Cauldron'
  const options = machinesForCraftType.get(r.craftType) ?? []
  const machine = pickMachine(id, options, ctx)
  const notes: string[] = []

  const baseSeconds = r.time * r.batch
  const seconds = baseSeconds / (machine?.speed ?? 1)

  const acceptsHeight = !!machine?.heightScaled
  const height = acceptsHeight ? (ctx.heights?.[id] ?? 0) : 0
  let yieldMultiplier = acceptsHeight ? heightMultiplier(height) : 1
  if (acceptsHeight)
    notes.push(`Built at height ${height}: ×${yieldMultiplier.toLocaleString(undefined, { maximumFractionDigits: 3 })} output`)
  if (r.craftType === 'Extract') yieldMultiplier *= ctx.mods.extractor
  if (r.craftType === 'Distill' || r.craftType === 'AdDistill') yieldMultiplier *= ctx.mods.alembic

  // Catalysts only work in the Advanced Athanor, on recipes with a charge cost.
  const acceptsCatalysts = machine?.key === ADVANCED_ATHANOR && r.catalystCost > 0
  const catalysts = acceptsCatalysts
    ? CATALYSTS.filter((c) => (ctx.catalysts?.[id] ?? []).includes(c.key))
    : []
  const has = (effect: string) => catalysts.some((c) => c.effect === effect)

  // Outcome of each craft: index 0 = main product, k = fail product k.
  const products = [r.output, ...r.fail.map((f) => f.product)]
  const chances = outcomeChances(r, has('unstable'), has('resonant'))
  const outputMultiplier = has('fertile') ? 2 : 1
  const outputs: Stack[] = []
  products.forEach((p, k) => {
    if (p && chances[k]) outputs.push({ item: p.item, count: perCraft(p, r.batch) * chances[k] * outputMultiplier })
  })
  if (r.side) outputs.push({ item: r.side.item, count: perCraft(r.side, r.batch) * outputMultiplier })
  if (products.length > 1) notes.push(describeOutcomes(r, chances, catalysts.length > 0))

  const inputs: Stack[] = has('eternal') ? [] : r.inputs.map((s) => ({ item: s.item, count: perCraft(s, r.batch) }))
  for (const c of catalysts) inputs.push({ item: c.key, count: r.catalystCost / c.charges })
  if (catalysts.length) {
    const effects = catalysts.map((c) => c.effect[0].toUpperCase() + c.effect.slice(1)).join(' + ')
    const extras = [has('fertile') ? 'output ×2' : '', has('eternal') ? 'no materials used' : ''].filter(Boolean)
    const charges = `${r.catalystCost} ${noun(r.catalystCost, 'charge')} per craft from each`
    notes.push(`${effects}: ${[...extras, charges].join(' · ')}`)
  }

  // Athanor recipes on the Advanced Athanor keep the standard Athanor's heat (building description).
  const heatMachine =
    machine?.key === ADVANCED_ATHANOR && r.craftType === 'Athanor' ? machinesByKey.get(ATHANOR) : machine
  const heatPerSecond = isCauldron
    ? cauldronStats(itemsByKey.get(r.output.item)?.cauldronTarget ?? 0).heatPerSecond
    : (heatMachine?.heatCost ?? 0)
  if (heatPerSecond > 0) inputs.push({ item: HEAT, count: heatPerSecond * seconds })

  return {
    id,
    kind: 'recipe',
    label: `${itemName(r.output.item)}${r.alternate ? ' (alt)' : ''}`,
    product: r.output.item,
    secondary: r.side ? [r.side.item] : [],
    machine,
    machineOptions: options,
    seconds,
    inputs: merge(inputs),
    outputs: merge(outputs.map((o) => ({ ...o, count: o.count * yieldMultiplier }))),
    alternate: r.alternate,
    notes,
    catalysts: catalysts.map((c) => c.key),
    acceptsCatalysts,
    height,
    acceptsHeight,
    tier: Math.max(recipeTier(r.key), machine ? machineTier(machine.key) : 1),
    license: licenseFor(r.key),
  }
}

/**
 * Chance of each outcome per craft (index 0 = main product, k = fail product k).
 * The recipe's product sequence cycles through outcomes (e.g. Steel [1,1,1,0] = 75% fail);
 * Unstable swaps in the unstable sequence; Resonant yields every product each craft.
 */
function outcomeChances(r: GameRecipe, unstable: boolean, resonant: boolean): number[] {
  const n = r.fail.length + 1
  if (resonant) return Array.from({ length: n }, () => 1)
  const sequence = unstable && r.unstableSequence.length ? r.unstableSequence : r.productSequence
  if (sequence.length) {
    const chances = Array.from({ length: n }, () => 0)
    for (const k of sequence) if (k < n) chances[k] += 1 / sequence.length
    return chances
  }
  const failRate = r.fail.reduce((sum, f) => sum + f.rate, 0)
  return [1 - failRate, ...r.fail.map((f) => f.rate)]
}

function describeOutcomes(r: GameRecipe, chances: number[], catalysed: boolean): string {
  const names = [r.output.item, ...r.fail.map((f) => f.product?.item ?? '')]
  const parts = chances
    .map((c, k) => (c > 0 ? `${Math.round(c * 100)}% ${itemName(names[k])}` : ''))
    .filter(Boolean)
  return `${parts.join(' · ')}${catalysed ? '' : ' (averaged, no catalyst)'}`
}

export function savedRecipeProcess(s: SavedRecipe): Process | null {
  const result = evaluate(s.mode, s.inputs)
  if (!result) return null
  const machine = machinesByKey.get(s.mode === 'normal' ? 'Cauldron' : ADVANCED_CAULDRON) ?? null
  const stats = cauldronStats(result.output.cauldronTarget)
  const notes = result.output.key !== s.output ? [`Game data changed: this mix now makes ${result.output.name}`] : []
  return {
    id: `cauldron:${s.id}`,
    kind: 'cauldron',
    label: s.name || `${result.output.name} ← ${s.inputs.map(itemName).join(' + ')}`,
    name: s.name || undefined,
    product: result.output.key,
    secondary: [],
    machine,
    machineOptions: machine ? [machine] : [],
    seconds: stats.seconds,
    inputs: merge([...s.inputs.map((item) => ({ item, count: 1 })), { item: HEAT, count: stats.heatPerSecond * stats.seconds }]),
    outputs: [{ item: result.output.key, count: 1 }],
    alternate: false,
    notes,
    catalysts: [],
    acceptsCatalysts: false,
    height: 0,
    acceptsHeight: false,
    tier: machine ? machineTier(machine.key) : 1,
  }
}

// World Tree: native code (UTreeNurseryFacilityComponent), mostly not in the data tables. The tree
// grows at a fixed nutrient rate per stage (× Factory Efficiency) whatever the fertilizer: fertilizer
// only fills its nutrient buffer. A leaf/core turn counter ignores the table's GrowthNum/SideGrowthNum
// (99/1): a stage-3 tree emits 100 leaves, then 1 core. Every item, core included, costs one
// GrowthNutrientValue.
// Players don't pick the stage: a World Tree Nursery grows through stages 1 and 2 on its own and stays
// at stage 3, while the Miniature World Tree (IsMininature) is pinned to stage 2 and grows only leaves.
// So stage 2 runs on the miniature and stage 3 on the nursery.
const WORLD_TREE_STAGE_RATE = [5000, 10000, 20000] // nutrients/s for TreeStage1..3
const WORLD_TREE_LEAVES_PER_CORE = 100

function nurseryProcesses(ctx: ProcessContext): Process[] {
  const nursery = machinesByKey.get(NURSERY) ?? null
  const treeNursery = machinesByKey.get(WORLD_TREE_NURSERY) ?? null
  const miniTree = machinesByKey.get(MINI_WORLD_TREE) ?? null
  const fert = ctx.fertilizer ? itemsByKey.get(ctx.fertilizer) : undefined
  const fertSpeed = fert?.nutrientSpeed || 1
  const result: Process[] = []
  for (const s of seeds) {
    if (!s.plant || !itemsByKey.has(s.plant) || s.nutrientCost <= 0) continue
    const stage = s.seed.match(/^TreeStage(\d)$/)?.[1]
    const worldTree = stage !== undefined
    const machine = !worldTree ? nursery : stage === '2' ? miniTree : treeNursery
    const speed = worldTree ? WORLD_TREE_STAGE_RATE[Number(stage) - 1] : fertSpeed
    // One nutrient "charge" grows one plant (and its side product in proportion).
    const sidePerPlant = !s.side ? 0 : worldTree ? 1 / WORLD_TREE_LEAVES_PER_CORE : s.count ? s.sideCount / s.count : 0
    const nutrients = s.nutrientCost * (1 + sidePerPlant)
    const outputs: Stack[] = [{ item: s.plant, count: 1 }]
    if (s.side && sidePerPlant) outputs.push({ item: s.side, count: sidePerPlant })
    result.push({
      id: `nursery:${s.seed}`,
      kind: 'nursery',
      label: `${itemName(s.plant)} (${worldTree ? (machine?.name ?? `stage ${stage}`) : 'nursery'})`,
      product: s.plant,
      secondary: s.side && sidePerPlant ? [s.side] : [],
      machine,
      machineOptions: machine ? [machine] : [],
      seconds: nutrients / speed,
      inputs: [{ item: NUTRIENTS, count: nutrients }],
      outputs,
      alternate: false,
      catalysts: [],
      acceptsCatalysts: false,
      height: 0,
      acceptsHeight: false,
      // Nurseries grow from bought seeds.
      tier: Math.max(machine ? machineTier(machine.key) : 1, buyTier(worldTree ? 'WorldTreeSeed' : s.seed)),
      ...(!worldTree && { seed: s.seed }),
      notes: [
        !worldTree
          ? `Growth speed from ${fert?.name ?? 'fertilizer'} (${speed} nutrients/s)`
          : stage === '2'
            ? `Stays a stage 2 tree: leaves only, ${speed} nutrients/s; fertilizer only supplies nutrients`
            : `Mature (stage 3) tree, ${speed} nutrients/s; fertilizer only supplies nutrients. A new tree first grows through stages 1 and 2`,
      ],
    })
  }
  return result
}

// ---- Paradox Crucible: any item → Oblivion Essence ----
// Native code (UParadoxFacilityComponent), not in the data tables. The crucible takes one belt entry
// (a single item, or a whole coin stack), holds count × BaseCost of value, and turns it into one
// Oblivion Essence in clamp(1500 / value, 0.5, 1500) seconds, burning 1200 P/s while it works.
// Oblivion ↔ Vitality are ordinary recipes (5 s each).
export const OBLIVION = 'Mors'
export const VITALITY = 'Vitae'
const PARADOX_VALUE_SECONDS = 1500
const PARADOX_MIN_SECONDS = 0.5
const PARADOX_MAX_SECONDS = 1500
/** Input picked when a plan first switches Oblivion Essence to the crucible (the Codex's example). */
export const DEFAULT_PARADOX_INPUT = 'SageSeed'
export const PARADOX_CRUCIBLE = 'ParadoxCrucible'

export const paradoxId = (item: string) => `paradox:${item}`

/** Items the crucible can refine into Oblivion Essence: anything with a value that travels on a belt. */
export const paradoxInputs = items.filter(
  (i) => !i.hidden && !i.liquid && i.baseCost > 0 && i.key !== OBLIVION && i.key !== VITALITY,
)

/** Seconds per Oblivion Essence from one belt entry of `item`, at Factory Efficiency level 0. */
export function paradoxSeconds(item: string, mods: Modifiers): number {
  const value = (itemsByKey.get(item)?.baseCost ?? 0) * itemsPerSlot(item, mods)
  if (value <= 0) return PARADOX_MAX_SECONDS
  return Math.min(PARADOX_MAX_SECONDS, Math.max(PARADOX_MIN_SECONDS, PARADOX_VALUE_SECONDS / value))
}

function paradoxProcesses(mods: Modifiers): Process[] {
  const machine = machinesByKey.get(PARADOX_CRUCIBLE) ?? null
  return paradoxInputs.map((i) => {
    const stack = itemsPerSlot(i.key, mods)
    const seconds = paradoxSeconds(i.key, mods)
    const notes = [`1 belt entry (${stack} × ${i.name}) → 1 Oblivion Essence`]
    if (seconds === PARADOX_MIN_SECONDS) notes.push('At the 0.5 s minimum: cheaper inputs give the same speed')
    return {
      id: paradoxId(i.key),
      kind: 'paradox' as const,
      label: `Oblivion Essence ← ${i.name}`,
      product: OBLIVION,
      secondary: [],
      machine,
      machineOptions: machine ? [machine] : [],
      seconds,
      inputs: [
        { item: i.key, count: stack },
        { item: HEAT, count: (machine?.heatCost ?? 0) * seconds },
      ],
      outputs: [{ item: OBLIVION, count: 1 }],
      alternate: false,
      notes,
      catalysts: [],
      acceptsCatalysts: false,
      height: 0,
      acceptsHeight: false,
      tier: machine ? machineTier(machine.key) : 1,
    }
  })
}

/**
 * Steam has a heat value, but it isn't a fuel: boilers make it from the heat of a burned fuel and
 * heating pads turn it back (see steamBoiler.ts), so the plan's fuel is what the boilers burn.
 */
const NOT_FUEL = new Set(['Steam'])

function fuelProcesses(mods: Modifiers): Process[] {
  return items
    .filter((i) => i.heatValue > 0 && !NOT_FUEL.has(i.key))
    .map((i) => ({
      id: `fuel:${i.key}`,
      kind: 'fuel' as const,
      label: `Burn ${i.name}`,
      product: HEAT,
      secondary: [],
      machine: null,
      machineOptions: [],
      seconds: 0,
      inputs: [{ item: i.key, count: 1 }],
      outputs: [{ item: HEAT, count: i.heatValue * mods.fuel }],
      alternate: false,
      notes: [],
      catalysts: [],
      acceptsCatalysts: false,
      height: 0,
      acceptsHeight: false,
      tier: 1,
    }))
}

function fertilizerProcesses(mods: Modifiers): Process[] {
  return items
    .filter((i) => i.nutrientValue > 0)
    .map((i) => ({
      id: `fert:${i.key}`,
      kind: 'fertilizer' as const,
      label: `Fertilize with ${i.name}`,
      product: NUTRIENTS,
      secondary: [],
      machine: null,
      machineOptions: [],
      seconds: 0,
      inputs: [{ item: i.key, count: 1 }],
      outputs: [{ item: NUTRIENTS, count: i.nutrientValue * mods.fertilizer }],
      alternate: false,
      notes: [],
      catalysts: [],
      acceptsCatalysts: false,
      height: 0,
      acceptsHeight: false,
      tier: 1,
    }))
}

/** The machine a process runs on unless one is picked: the first one the research tier unlocks. */
export const defaultMachine = (p: Process, tier: number) =>
  (p.machineOptions.find((m) => machineTier(m.key) <= tier) ?? p.machineOptions[0])?.key

/** Items a building makes natively, outside the recipe tables. */
const BUILDING_MADE: Record<string, string> = { Steam: 'SteamBoiler' }

/** How one row runs a process: its machine, catalysts and the height its machines are built at. */
export interface RunChange {
  machine?: string
  catalysts?: string[]
  height?: number
}

export interface ProcessCatalog {
  byId: Map<string, Process>
  /** Producer options per product item, game recipes first, then saved cauldron recipes. */
  byProduct: Map<string, Process[]>
  /**
   * The process as it runs on another of its machines (for previewing the choice), and with the
   * catalysts loaded and height built at in one row of the plan.
   */
  variant: (p: Process, change: RunChange) => Process
  /** Research tier the plan has reached. */
  tier: number
  /** Earliest research tier an item can be had at: bought, or made from things reachable by then. */
  itemReach: (item: string) => number
  /** Earliest research tier a process can run at: its own, and its ingredients'. */
  reach: (p: Process) => number
  /** The player's saved defaults. */
  mine: MyDefaults
}

export function buildCatalog(ctx: ProcessContext): ProcessCatalog {
  const recipes = new Map(gameRecipes.map((r) => [`recipe:${r.key}`, r]))
  const variant = (p: Process, { machine = p.machine?.key, catalysts = p.catalysts, height = p.height }: RunChange) => {
    const r = recipes.get(p.id)
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((k) => b.includes(k))
    if (!r || (p.machine?.key === machine && same(p.catalysts, catalysts) && p.height === height)) return p
    return recipeProcess(r, {
      ...ctx,
      machines: machine ? { ...ctx.machines, [p.id]: machine } : ctx.machines,
      catalysts: { ...ctx.catalysts, [p.id]: catalysts },
      heights: { ...ctx.heights, [p.id]: height },
    })
  }
  const all: Process[] = [
    ...gameRecipes.filter((r) => !r.hidden).map((r) => recipeProcess(r, ctx)),
    ...nurseryProcesses(ctx),
    ...ctx.saved.map(savedRecipeProcess).filter((p): p is Process => !!p),
    ...paradoxProcesses(ctx.mods),
    ...fuelProcesses(ctx.mods),
    ...fertilizerProcesses(ctx.mods),
  ]
  const byId = new Map(all.map((p) => [p.id, p]))
  const byProduct = new Map<string, Process[]>()
  for (const p of all) byProduct.set(p.product, [...(byProduct.get(p.product) ?? []), p])
  // Multi-output processes are also offered for their side products, after the main producers.
  for (const p of all) for (const item of p.secondary) byProduct.set(item, [...(byProduct.get(item) ?? []), p])
  // Items only ever made as a failed craft (Impure Copper Powder from the Athanor's Copper Powder)
  // are offered from those recipes too, for rows that make their own instead of reusing them.
  const failOnly = new Map<string, Process[]>()
  for (const p of all)
    for (const o of p.outputs)
      if (o.item !== p.product && !o.item.startsWith('@') && !byProduct.has(o.item))
        failOnly.set(o.item, [...(failOnly.get(o.item) ?? []), p])
  for (const [item, list] of failOnly) byProduct.set(item, list)

  // Lower each item's reach to that of the processes making it until nothing changes (loops settle
  // on their cheapest way in). Items nothing makes and portals don't sell come from outside: tier 1.
  const reached = new Map<string, number>(Object.entries(BUILDING_MADE).map(([item, b]) => [item, machineTier(b)]))
  const itemReach = (item: string) => {
    if (item.startsWith('@')) return 1
    const known = reached.get(item)
    if (known !== undefined) return known
    if (itemsByKey.get(item)?.buyPrice != null) return buyTier(item)
    return byProduct.has(item) ? Infinity : 1
  }
  const reach = (p: Process) => Math.max(p.tier, ...p.inputs.map((s) => itemReach(s.item)))
  for (let changed = true; changed; ) {
    changed = false
    for (const p of all) {
      const r = reach(p)
      for (const s of p.outputs)
        if (r < itemReach(s.item)) {
          reached.set(s.item, r)
          changed = true
        }
    }
  }
  return { byId, byProduct, variant, tier: ctx.tier ?? MAX_TIER, itemReach, reach, mine: ctx.mine ?? {} }
}

/**
 * Default producer, among what the plan's research tier can run (anything, when nothing can): the
 * standard game recipe, else a nursery (preferred over seed plots; the World Tree Nursery over the
 * Miniature World Tree), else the Paradox Crucible (for
 * Oblivion Essence, whose only recipe loops back through Vitality), else an alternate recipe, else
 * a saved cauldron recipe, else import. Coins are money off the bus: they're taken in at face value,
 * and minted only for a target (`asTarget`).
 */
export function defaultProducer(catalog: ProcessCatalog, item: string, asTarget = false): string {
  if (coinValue(item) !== null && !asTarget) return 'import'
  const open = (p: Process | undefined): p is Process => !!p && catalog.reach(p) <= catalog.tier
  // The unlocked fuel with the most heat per item.
  if (item === HEAT) {
    const fuels = catalog.byProduct.get(HEAT) ?? []
    return ([...fuels].filter(open).sort((a, b) => b.outputs[0].count - a.outputs[0].count)[0] ?? fuels[0])?.id ?? 'import'
  }
  if (item === NUTRIENTS) {
    const list = catalog.byProduct.get(item) ?? []
    return (list.find(open) ?? list[0])?.id ?? 'import'
  }
  const rank = (all: Process[]) => {
    const options = all.filter((p) => p.product === item)
    return (
      options.find((p) => p.kind === 'recipe' && !p.alternate && p.machine?.key !== 'SeedPlot') ??
      // The Miniature World Tree is a player's pick, never the default.
      options.find((p) => p.kind === 'nursery' && p.machine?.key !== MINI_WORLD_TREE) ??
      options.find((p) => p.kind === 'nursery') ??
      options.find((p) => p.id === paradoxId(DEFAULT_PARADOX_INPUT)) ??
      options.find((p) => p.kind === 'paradox') ??
      options.find((p) => p.kind === 'recipe') ??
      options.find((p) => p.kind === 'cauldron') ??
      // Only made as a side product (e.g. Gentian Nectar from the Gentian nursery). Items only made
      // by failed crafts aren't run for: they're reused, else brought in.
      all.find(
        (p) => p.secondary.includes(item) && (p.kind === 'nursery' || (p.kind === 'recipe' && p.machine?.key !== 'SeedPlot')),
      ) ?? all.find((p) => p.secondary.includes(item))
    )
  }
  const all = catalog.byProduct.get(item) ?? []
  return (rank(all.filter(open)) ?? rank(all))?.id ?? 'import'
}

/**
 * Identifies a process on its machine with its catalysts and height: branches can run one recipe
 * on different machines, load different catalysts, or build them at different heights.
 */
export const runKey = (p: Process) =>
  [
    p.machine && p.machineOptions.length > 1 ? `${p.id}@${p.machine.key}` : p.id,
    ...[...p.catalysts].sort(),
    ...(p.acceptsHeight ? [`h${p.height}`] : []),
  ].join('+')

/** The same recipe on the same machine (catalysts and height aside): what a row loops back to. */
export const sameRecipe = (a: Process, b: Process) => a.id === b.id && a.machine?.key === b.machine?.key

/**
 * Short name for a producer option shown next to its product: the machine, or what sets the
 * option apart (the fuel burned, a saved mix's name or what it makes).
 */
export function processTitle(p: Process): string {
  if (p.kind === 'cauldron') return p.name || `${p.machine?.name ?? 'Cauldron'}: ${itemName(p.product)}`
  if (p.kind === 'fuel' || p.kind === 'fertilizer') return itemName(p.inputs[0]?.item ?? '')
  return p.machine?.name ?? p.label
}

/** Label for a producer option: ★ marks saved cauldron recipes. */
export function processLabel(p: Process, forItem?: string): string {
  const prefix = p.kind === 'cauldron' ? '★ ' : ''
  const machine = p.machine ? ` · ${p.machine.name}` : ''
  const side = forItem && forItem !== p.product ? ' (by-product)' : ''
  return `${prefix}${p.label}${p.kind === 'recipe' || p.kind === 'nursery' ? machine : ''}${side}`
}
