import { cauldronStats, evaluate } from './cauldron'
import {
  ADVANCED_ATHANOR,
  ADVANCED_CAULDRON,
  ATHANOR,
  CATALYSTS,
  HEAT,
  NURSERY,
  NUTRIENTS,
  WORLD_TREE_NURSERY,
  gameRecipes,
  itemName,
  items,
  itemsByKey,
  machinesByKey,
  machinesForCraftType,
  seeds,
  type GameRecipe,
  type Machine,
  type Stack,
} from './gameData'
import { itemsPerSlot } from './machineRate'
import type { SavedRecipe } from './types'
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
}

function merge(stacks: Stack[]): Stack[] {
  const map = new Map<string, number>()
  for (const s of stacks) if (s.count) map.set(s.item, (map.get(s.item) ?? 0) + s.count)
  return [...map].map(([item, count]) => ({ item, count }))
}

function pickMachine(id: string, options: Machine[], ctx: ProcessContext): Machine | null {
  return options.find((m) => m.key === ctx.machines[id]) ?? options[0] ?? null
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

  let yieldMultiplier = machine?.outputMultiplier ?? 1
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
    const charges = `${r.catalystCost} charge${r.catalystCost === 1 ? '' : 's'} per craft from each`
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
  }
}

// World Tree: native code (UTreeNurseryFacilityComponent), mostly not in the data tables. The tree
// grows at a fixed nutrient rate per stage (× Factory Efficiency) whatever the fertilizer: fertilizer
// only fills its nutrient buffer. A leaf/core turn counter ignores the table's GrowthNum/SideGrowthNum
// (99/1): a stage-3 tree emits 100 leaves, then 1 core. Every item, core included, costs one
// GrowthNutrientValue.
const WORLD_TREE_STAGE_RATE = [5000, 10000, 20000] // nutrients/s for TreeStage1..3
const WORLD_TREE_LEAVES_PER_CORE = 100

function nurseryProcesses(ctx: ProcessContext): Process[] {
  const nursery = machinesByKey.get(NURSERY) ?? null
  const treeNursery = machinesByKey.get(WORLD_TREE_NURSERY) ?? null
  const fert = ctx.fertilizer ? itemsByKey.get(ctx.fertilizer) : undefined
  const fertSpeed = fert?.nutrientSpeed || 1
  const result: Process[] = []
  for (const s of seeds) {
    if (!s.plant || !itemsByKey.has(s.plant) || s.nutrientCost <= 0) continue
    const stage = s.seed.match(/^TreeStage(\d)$/)?.[1]
    const worldTree = stage !== undefined
    const machine = worldTree ? treeNursery : nursery
    const speed = worldTree ? WORLD_TREE_STAGE_RATE[Number(stage) - 1] : fertSpeed
    // One nutrient "charge" grows one plant (and its side product in proportion).
    const sidePerPlant = !s.side ? 0 : worldTree ? 1 / WORLD_TREE_LEAVES_PER_CORE : s.count ? s.sideCount / s.count : 0
    const nutrients = s.nutrientCost * (1 + sidePerPlant)
    const outputs: Stack[] = [{ item: s.plant, count: 1 }]
    if (s.side && sidePerPlant) outputs.push({ item: s.side, count: sidePerPlant })
    result.push({
      id: `nursery:${s.seed}`,
      kind: 'nursery',
      label: `${itemName(s.plant)} (${worldTree ? `stage ${stage}` : 'nursery'})`,
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
      notes: [
        worldTree
          ? `Fixed stage ${stage} growth speed (${speed} nutrients/s); fertilizer only supplies nutrients`
          : `Growth speed from ${fert?.name ?? 'fertilizer'} (${speed} nutrients/s)`,
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
    }
  })
}

function fuelProcesses(mods: Modifiers): Process[] {
  return items
    .filter((i) => i.heatValue > 0)
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
    }))
}

export interface ProcessCatalog {
  byId: Map<string, Process>
  /** Producer options per product item, game recipes first, then saved cauldron recipes. */
  byProduct: Map<string, Process[]>
  /** The process as it would run on another of its machines (for previewing the choice). */
  onMachine: (p: Process, machine: string) => Process
}

export function buildCatalog(ctx: ProcessContext): ProcessCatalog {
  const recipes = new Map(gameRecipes.map((r) => [`recipe:${r.key}`, r]))
  const onMachine = (p: Process, machine: string) => {
    const r = recipes.get(p.id)
    if (!r || p.machine?.key === machine) return p
    return recipeProcess(r, { ...ctx, machines: { ...ctx.machines, [p.id]: machine } })
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
  return { byId, byProduct, onMachine }
}

/**
 * Default producer: the standard game recipe, else a nursery (preferred over seed plots),
 * else the Paradox Crucible (for Oblivion Essence, whose only recipe loops back through Vitality),
 * else an alternate recipe, else a saved cauldron recipe, else import.
 */
export function defaultProducer(catalog: ProcessCatalog, item: string): string {
  if (item === HEAT) return catalog.byId.has('fuel:Steam') ? 'fuel:Steam' : (catalog.byProduct.get(HEAT)?.[0]?.id ?? 'import')
  if (item === NUTRIENTS) return catalog.byProduct.get(NUTRIENTS)?.[0]?.id ?? 'import'
  const all = catalog.byProduct.get(item) ?? []
  const options = all.filter((p) => p.product === item)
  const pick =
    options.find((p) => p.kind === 'recipe' && !p.alternate && p.machine?.key !== 'SeedPlot') ??
    options.find((p) => p.kind === 'nursery') ??
    options.find((p) => p.id === paradoxId(DEFAULT_PARADOX_INPUT)) ??
    options.find((p) => p.kind === 'paradox') ??
    options.find((p) => p.kind === 'recipe') ??
    options.find((p) => p.kind === 'cauldron') ??
    // Only made as a side product (e.g. Gentian Nectar from the Gentian nursery).
    all.find((p) => p.kind === 'nursery' || (p.kind === 'recipe' && p.machine?.key !== 'SeedPlot')) ??
    all[0]
  return pick?.id ?? 'import'
}

/**
 * Short name for a producer option shown next to its product: the machine, or what sets the
 * option apart (the fuel burned, a saved mix's name, the World Tree's stage).
 */
export function processTitle(p: Process): string {
  if (p.kind === 'cauldron') return p.name || 'Saved mix'
  if (p.kind === 'fuel' || p.kind === 'fertilizer') return itemName(p.inputs[0]?.item ?? '')
  const machine = p.machine?.name ?? p.label
  const stage = p.kind === 'nursery' ? p.id.match(/TreeStage(\d)$/)?.[1] : undefined
  return stage ? `${machine} · stage ${stage}` : machine
}

/** Label for a producer option: ★ marks saved cauldron recipes. */
export function processLabel(p: Process, forItem?: string): string {
  const prefix = p.kind === 'cauldron' ? '★ ' : ''
  const machine = p.machine ? ` · ${p.machine.name}` : ''
  const side = forItem && forItem !== p.product ? ' (by-product)' : ''
  return `${prefix}${p.label}${p.kind === 'recipe' || p.kind === 'nursery' ? machine : ''}${side}`
}
