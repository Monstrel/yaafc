import { cauldronStats, evaluate } from './cauldron'
import {
  ADVANCED_ATHANOR,
  ADVANCED_CAULDRON,
  ATHANOR,
  CATALYSTS,
  HEAT,
  MONEY,
  heightMultiplier,
  NURSERY,
  NUTRIENTS,
  MAX_TIER,
  MINI_WORLD_TREE,
  WORLD_TREE_NURSERY,
  buyTier,
  COINS,
  coinValue,
  gameRecipes,
  itemName,
  items,
  itemsByKey,
  licenseFor,
  machinesByKey,
  machineTier,
  machinesForCraftType,
  manualCraftTypes,
  recipeTier,
  seeds,
  STEAM,
  type GameRecipe,
  type Item,
  type Machine,
  type Stack,
} from './gameData'
import { itemNameFor, noun } from './plural'
import { COIN_STACK, itemsPerSlot } from './machineRate'
import { BOILER_SETTINGS, STEAM_HEAT } from './steamBoiler'
import type { MyDefaults, SavedRecipe } from './types'
import type { Modifiers } from './upgrades'

export type ProcessKind =
  | 'recipe'
  | 'cauldron'
  | 'nursery'
  | 'paradox'
  | 'bank'
  | 'boiler'
  | 'buy'
  | 'fuel'
  | 'fertilizer'
  | 'spend'

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
  /** Coins per output belt entry, when the row sets it (Bank Portal: the "Conversion Amount"). */
  stack?: number
  /**
   * Coins per input belt entry, per ingredient, where a Bank Portal row below feeds smaller stacks
   * than the full 50 (which the row's input belts then carry fewer of).
   */
  inputStacks?: Record<string, number>
  /** Research tier its recipe and machine need (seeds too, for nurseries). */
  tier: number
  /** License the recipe needs, if any (alternate ingots). */
  license?: string
  /** Seed planted in its Nursery (not set for World Trees, which have no choice of seed). */
  seed?: string
  /** Fertilizer its Nursery grows on, which sets its speed (not set for World Trees, which grow at their own pace). */
  fertilizer?: string
  /** Coin its Purchasing Portals are paid in, which sets their pace. */
  coin?: string
  /**
   * A Paradox Crucible row refining several items off one belt, as solved: `inputs` are each one's
   * share of an entry and `seconds` their average (see `blendParadox`).
   */
  mixed?: boolean
}

export interface ProcessContext {
  saved: SavedRecipe[]
  /** Chosen machine per process id. */
  machines: Record<string, string>
  mods: Modifiers
  /** Fertilizer nurseries grow on unless their row spreads another (sets their growth speed). */
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

type Seed = (typeof seeds)[number]

type Growing = Seed & { plant: string }

const grows = (s: Seed): s is Growing => !!s.plant && itemsByKey.has(s.plant) && s.nutrientCost > 0

/** A seed growing in its nursery on `fertilizer`, which sets an ordinary Nursery's speed. */
function nurseryProcess(s: Growing, fertilizer: string | null): Process {
  const stage = s.seed.match(/^TreeStage(\d)$/)?.[1]
  const worldTree = stage !== undefined
  const machine = (!worldTree ? machinesByKey.get(NURSERY) : machinesByKey.get(stage === '2' ? MINI_WORLD_TREE : WORLD_TREE_NURSERY)) ?? null
  const fert = !worldTree && fertilizer ? itemsByKey.get(fertilizer) : undefined
  const speed = worldTree ? WORLD_TREE_STAGE_RATE[Number(stage) - 1] : fert?.nutrientSpeed || 1
  // One nutrient "charge" grows one plant (and its side product in proportion).
  const sidePerPlant = !s.side ? 0 : worldTree ? 1 / WORLD_TREE_LEAVES_PER_CORE : s.count ? s.sideCount / s.count : 0
  const nutrients = s.nutrientCost * (1 + sidePerPlant)
  const outputs: Stack[] = [{ item: s.plant, count: 1 }]
  if (s.side && sidePerPlant) outputs.push({ item: s.side, count: sidePerPlant })
  return {
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
    ...(fert && { fertilizer: fert.key }),
    notes: [
      !worldTree
        ? `Growth speed from ${fert?.name ?? 'fertilizer'} (${speed} nutrients/s)`
        : stage === '2'
          ? `Stays a stage 2 tree: leaves only, ${speed} nutrients/s; fertilizer only supplies nutrients`
          : `Mature (stage 3) tree, ${speed} nutrients/s; fertilizer only supplies nutrients. A new tree first grows through stages 1 and 2`,
    ],
  }
}

// ---- Paradox Crucible: any item → Oblivion Essence ----
// Native code (UParadoxFacilityComponent), not in the data tables. The crucible takes one belt entry
// (a single item, or a whole coin stack), holds count × CauldronCost of value (not BaseCost: Sage
// Seeds take 8.6 s in game, 1500 / 175), and turns it into one Oblivion Essence in
// clamp(1500 / value, 0.5, 1500) seconds, burning 1200 P/s while it works.
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
  (i) => !i.hidden && !i.liquid && i.cauldronCost > 0 && i.key !== OBLIVION && i.key !== VITALITY,
)

/**
 * Seconds per Oblivion Essence from one belt entry of `item`, at Factory Efficiency level 0. Coins
 * come `coinStack` to an entry: full stacks, unless a Bank Portal feeds smaller ones.
 */
export function paradoxSeconds(item: string, coinStack?: number): number {
  const value = (itemsByKey.get(item)?.cauldronCost ?? 0) * itemsPerSlot(item, coinStack)
  if (value <= 0) return PARADOX_MAX_SECONDS
  return Math.min(PARADOX_MAX_SECONDS, Math.max(PARADOX_MIN_SECONDS, PARADOX_VALUE_SECONDS / value))
}

function paradoxProcess(i: Item, coinStack?: number): Process {
  const machine = machinesByKey.get(PARADOX_CRUCIBLE) ?? null
  const stack = itemsPerSlot(i.key, coinStack)
  const seconds = paradoxSeconds(i.key, coinStack)
  const notes = [`1 belt entry (${stack} × ${i.name}) → 1 Oblivion Essence`]
  if (seconds === PARADOX_MIN_SECONDS) notes.push('At the 0.5 s minimum: cheaper inputs give the same speed')
  return {
    id: paradoxId(i.key),
    kind: 'paradox',
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
}

/**
 * A crucible row refining several items off one belt, as one process: each item's share of the
 * entries, at the average time and heat per Oblivion Essence. A crucible handed a run of different
 * items takes each one's own time, so a row of them works the same as one group per item.
 * `parts` are each input's process (the row's own first) and its crafts per minute.
 */
export function blendParadox(parts: { process: Process; crafts: number }[]): Process {
  const own = parts[0].process
  const total = parts.reduce((t, x) => t + x.crafts, 0)
  const used = parts.filter((x) => x.crafts > 0)
  if (total <= 0 || used.length < 2) return used[0]?.process ?? own
  const share = (x: { crafts: number }) => x.crafts / total
  const heat = used.reduce((t, x) => t + share(x) * (x.process.inputs.find((s) => s.item === HEAT)?.count ?? 0), 0)
  const items = used.map((x) => x.process.inputs[0].item)
  return {
    ...own,
    label: `Oblivion Essence ← ${items.map(itemName).join(' + ')}`,
    seconds: used.reduce((t, x) => t + share(x) * x.process.seconds, 0),
    inputs: [...used.map((x) => ({ ...x.process.inputs[0], count: share(x) * x.process.inputs[0].count })), { item: HEAT, count: heat }],
    notes: ['One belt entry → 1 Oblivion Essence, each at its own speed: the row averages them'],
    inputStacks: undefined,
    mixed: true,
  }
}

// ---- Bank Portal: one coin → another ----
// Native code (UBankFacilityComponent, build 25321648), not in the data tables. Each belt entry of
// coins (any denomination) adds its value to a buffer; whenever the buffer holds CoinStack coins'
// worth of the output coin, the portal emits one entry of CoinStack coins and keeps the remainder,
// so nothing is lost. No craft time, heat or Factory Efficiency: it moves an entry per belt slot,
// so its belts are its only limit. The "Conversion Amount" (CoinStack) is 1–50, 1 in a new portal.
export const BANK_PORTAL = 'Portal_Bank'
/** Coins per output entry when a row doesn't set its own: the most a portal converts at once. */
export const DEFAULT_BANK_STACK = 50
export const MAX_BANK_STACK = 50

export const bankId = (input: string, output: string) => `bank:${input}:${output}`
export const clampBankStack = (stack: number) => Math.min(MAX_BANK_STACK, Math.max(1, Math.round(stack) || 1))

type Coin = (typeof COINS)[number]

function bankProcess(input: Coin, output: Coin, stack: number, mods: Modifiers): Process {
  const machine = machinesByKey.get(BANK_PORTAL) ?? null
  return {
    id: bankId(input.coin, output.coin),
    kind: 'bank',
    label: `${itemName(output.coin)} ← ${itemName(input.coin)}`,
    product: output.coin,
    secondary: [],
    machine,
    machineOptions: machine ? [machine] : [],
    // One output entry per belt slot.
    seconds: 60 / mods.beltSpeed,
    inputs: [{ item: input.coin, count: (stack * output.copper) / input.copper }],
    outputs: [{ item: output.coin, count: stack }],
    alternate: false,
    notes: [`Outputs ${stack} ${itemNameFor(output.coin, stack)} per belt entry, from coins in full stacks of ${COIN_STACK}`],
    catalysts: [],
    acceptsCatalysts: false,
    height: 0,
    acceptsHeight: false,
    stack,
    tier: machine ? machineTier(machine.key) : 1,
  }
}

// ---- Purchasing Portal: money → an item ----
// Native code (UPortalFacilityComponent, build 25321648), not in the data tables. The portal takes
// coins of any kind into a buffer, a belt entry at a time while it holds less than the item's
// price; once it holds the price it pays it, keeping the change, and puts one entry of the item on
// its belt (a whole bundle, like a Log). No craft time, heat or Factory Efficiency: its belts are
// its only limit, so the coin it's paid in sets its pace. An entry of 50 copper buys 1/24 of an
// Iron Ore; one of 50 silver buys 41.
export const PURCHASING_PORTAL = 'Portal_AlchGuild'
export const buyId = (item: string) => `buy:${item}`
export const spendId = (coin: string) => `spend:${coin}`
/** Items the Purchasing Portal sells (liquids would need a pipe portal the game doesn't offer yet). */
const sold = items.filter((i) => i.buyPrice != null && !i.liquid)

/**
 * The coin a plan pays with unless it picks another: the largest any price is written in among the
 * goods portals sell by its research tier, as players move their bus to bigger coins when prices
 * do. Copper to tier IV, silver from the Grand Portal Sigil (16 silver) at V, gold from the World
 * Tree Seed (50 gold) at VIII. Raw materials last long enough that copper's slow portals keep up.
 */
export function defaultCoin(tier: number): string {
  const written = new Set(sold.filter((i) => buyTier(i.key) <= tier).map((i) => i.buyCoin))
  return COINS.find((c) => written.has(c.coin))?.coin ?? 'CopperCoin'
}

const decimals = (x: number) => x.toLocaleString(undefined, { maximumFractionDigits: 2 })

/** Buying an item, paid in `coin` arriving `stack` to a belt entry (full stacks, unless a Bank Portal feeds smaller ones). */
function buyProcess(i: Item, coin: string, mods: Modifiers, stack = COIN_STACK): Process {
  const machine = machinesByKey.get(PURCHASING_PORTAL) ?? null
  const price = i.buyPrice!
  const perEntry = stack * (coinValue(coin) ?? 1)
  // Belt entries of coins one purchase takes: below one, the output belt sets the pace.
  const entries = price / perEntry
  const coins = itemNameFor(coin, stack)
  return {
    id: buyId(i.key),
    kind: 'buy',
    label: `Buy ${i.name}`,
    product: i.key,
    secondary: [],
    machine,
    machineOptions: machine ? [machine] : [],
    seconds: (60 / mods.beltSpeed) * Math.max(1, entries),
    inputs: [{ item: MONEY, count: price }],
    outputs: [{ item: i.key, count: 1 }],
    alternate: false,
    notes: [
      entries > 1
        ? `Paid in ${coins}: each belt entry of ${stack} pays for ${decimals(1 / entries)} of one, so the coins set its pace`
        : `Paid in ${coins}: each belt entry of ${stack} pays for ${decimals(1 / entries)}, so its output belt sets its pace`,
    ],
    catalysts: [],
    acceptsCatalysts: false,
    height: 0,
    acceptsHeight: false,
    tier: Math.max(machine ? machineTier(machine.key) : 1, buyTier(i.key)),
    coin,
    ...(stack < COIN_STACK && { inputStacks: { [coin]: stack } }),
  }
}

/** Paying with a coin: what it's worth, in copper. */
function spendProcess(c: Coin): Process {
  return {
    id: spendId(c.coin),
    kind: 'spend',
    label: `Pay with ${itemNameFor(c.coin, 2)}`,
    product: MONEY,
    secondary: [],
    machine: null,
    machineOptions: [],
    seconds: 0,
    inputs: [{ item: c.coin, count: 1 }],
    outputs: [{ item: MONEY, count: c.copper }],
    alternate: false,
    notes: [],
    catalysts: [],
    acceptsCatalysts: false,
    height: 0,
    acceptsHeight: false,
    tier: 1,
  }
}

/** Conversions between different coins (re-stacking one coin would feed its own row). */
const bankPairs = COINS.flatMap((input) => COINS.filter((output) => output !== input).map((output) => ({ input, output })))

// ---- Heat: the machines on a furnace or heating pad ----
// Heat-using machines sit on a Stone or Blast Furnace burning a solid fuel, or on a Steam Heating
// Pad taking Steam from pipes. Both pass the heat on without loss, however many machines share one,
// so they aren't counted: what a row burns depends only on the heat its machines use. Steam comes
// from Steam Boilers, themselves heated machines (see steamBoiler.ts).

/** Heating with Steam, on Steam Heating Pads. */
export const STEAM_HEAT_ID = `fuel:${STEAM}`

function fuelProcess(i: Item, heat: number, label: string, notes: string[] = []): Process {
  return {
    id: `fuel:${i.key}`,
    kind: 'fuel',
    label,
    product: HEAT,
    secondary: [],
    machine: null,
    machineOptions: [],
    seconds: 0,
    inputs: [{ item: i.key, count: 1 }],
    outputs: [{ item: HEAT, count: heat }],
    alternate: false,
    notes,
    catalysts: [],
    acceptsCatalysts: false,
    height: 0,
    acceptsHeight: false,
    tier: 1,
  }
}

function fuelProcesses(mods: Modifiers): Process[] {
  const steam = itemsByKey.get(STEAM)
  return [
    ...items.filter((i) => i.heatValue > 0 && i.key !== STEAM).map((i) => fuelProcess(i, i.heatValue * mods.fuel, `Burn ${i.name}`)),
    // A heating pad gives back the heat a boiler put into the Steam: Fuel Efficiency doesn't apply.
    ...(steam
      ? [
          {
            ...fuelProcess(steam, STEAM_HEAT, 'Heat with Steam', [`Steam Heating Pads: ${STEAM_HEAT} P per Steam`]),
            tier: machineTier(STEAM_HEATER),
          },
        ]
      : []),
  ]
}

const STEAM_BOILER = 'SteamBoiler'
const STEAM_HEATER = 'SteamHeater'
export const boilerId = (setting: string) => `boiler:${setting}`

/** A Steam Boiler on one of its settings: heat from the furnace under it in, Steam out to its pipes. */
function boilerProcess(setting: (typeof BOILER_SETTINGS)[number]): Process {
  const machine = machinesByKey.get(STEAM_BOILER) ?? null
  return {
    id: boilerId(setting.name),
    kind: 'boiler',
    label: `Steam (${setting.name})`,
    product: STEAM,
    secondary: [],
    machine,
    machineOptions: machine ? [machine] : [],
    seconds: setting.seconds,
    inputs: [{ item: HEAT, count: setting.steam * STEAM_HEAT }],
    outputs: [{ item: STEAM, count: setting.steam }],
    alternate: false,
    notes: [`${setting.name} setting: ${setting.steam} Steam every ${setting.seconds} s`],
    catalysts: [],
    acceptsCatalysts: false,
    height: 0,
    acceptsHeight: false,
    tier: machine ? machineTier(machine.key) : 1,
  }
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

/**
 * How one row runs a process: its machine, catalysts, the height its machines are built at, the
 * coins its Bank Portals output per entry, the fertilizer its Nurseries grow on and the coin its
 * Purchasing Portals are paid in.
 */
export interface RunChange {
  machine?: string
  catalysts?: string[]
  height?: number
  stack?: number
  fertilizer?: string
  coin?: string
  /** Coins per belt entry a Purchasing Portal is paid in, where a Bank Portal feeds smaller stacks than 50. */
  coinStack?: number
  /** Coins per input belt entry, per ingredient fed smaller stacks than 50 (empty: none). */
  inputStacks?: Record<string, number>
}

export interface ProcessCatalog {
  byId: Map<string, Process>
  /** Producer options per product item, game recipes first, then saved cauldron recipes. */
  byProduct: Map<string, Process[]>
  /**
   * The process as it runs on another of its machines (for previewing the choice), and with the
   * catalysts loaded, height built at, coin stack output and coin stacks fed in one row of the plan.
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

const sameStacks = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, n]) => b[k] === n)

export function buildCatalog(ctx: ProcessContext): ProcessCatalog {
  const recipes = new Map(gameRecipes.map((r) => [`recipe:${r.key}`, r]))
  const banks = new Map(bankPairs.map((b) => [bankId(b.input.coin, b.output.coin), b]))
  const paradox = new Map(paradoxInputs.map((i) => [paradoxId(i.key), i]))
  const nurseries = new Map(seeds.filter(grows).map((s) => [`nursery:${s.seed}`, s]))
  const portals = new Map(sold.map((i) => [buyId(i.key), i]))
  const rerun = (p: Process, change: RunChange) => {
    const bank = banks.get(p.id)
    if (bank) {
      const stack = clampBankStack(change.stack ?? p.stack ?? DEFAULT_BANK_STACK)
      return stack === p.stack ? p : bankProcess(bank.input, bank.output, stack, ctx.mods)
    }
    const seed = nurseries.get(p.id)
    // World Trees grow at their own pace: only ordinary Nurseries (with a seed) take a fertilizer.
    if (seed) return !p.seed || !change.fertilizer || change.fertilizer === p.fertilizer ? p : nurseryProcess(seed, change.fertilizer)
    const { machine = p.machine?.key, catalysts = p.catalysts, height = p.height } = change
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
  /** The process taking smaller coin stacks than 50 where `stacks` says (the crucible refines an entry at a time). */
  const fedStacks = (p: Process, stacks: Record<string, number>) => {
    const fed = Object.fromEntries(
      Object.entries(stacks).filter(([item, n]) => n < COIN_STACK && p.inputs.some((s) => s.item === item)),
    )
    if (sameStacks(p.inputStacks ?? {}, fed)) return p
    const crucible = paradox.get(p.id)
    const base = crucible ? paradoxProcess(crucible, fed[crucible.key]) : p
    return Object.keys(fed).length ? { ...base, inputStacks: fed } : { ...base, inputStacks: undefined }
  }
  const variant = (p: Process, change: RunChange) => {
    // A portal's coin stacks come from the coin row under it, not its own ingredients.
    const bought = portals.get(p.id)
    if (bought) {
      const coin = change.coin ?? p.coin!
      const stack = change.coinStack ?? (coin === p.coin ? p.inputStacks?.[coin] : undefined) ?? COIN_STACK
      return coin === p.coin && stack === (p.inputStacks?.[coin] ?? COIN_STACK) ? p : buyProcess(bought, coin, ctx.mods, stack)
    }
    const stacks = change.inputStacks ?? p.inputStacks
    const run = rerun(p, change)
    return stacks || run.inputStacks ? fedStacks(run, stacks ?? {}) : run
  }
  const all: Process[] = [
    ...gameRecipes.filter((r) => !r.hidden && !manualCraftTypes.has(r.craftType)).map((r) => recipeProcess(r, ctx)),
    ...seeds.filter(grows).map((s) => nurseryProcess(s, ctx.fertilizer)),
    ...ctx.saved.map(savedRecipeProcess).filter((p): p is Process => !!p),
    ...paradoxInputs.map((i) => paradoxProcess(i)),
    ...bankPairs.map(({ input, output }) => bankProcess(input, output, DEFAULT_BANK_STACK, ctx.mods)),
    ...BOILER_SETTINGS.map(boilerProcess),
    ...sold.map((i) => buyProcess(i, defaultCoin(ctx.tier ?? MAX_TIER), ctx.mods)),
    ...COINS.map(spendProcess),
    ...fuelProcesses(ctx.mods),
    ...fertilizerProcesses(ctx.mods),
  ]
  const byId = new Map(all.map((p) => [p.id, p]))
  const byProduct = new Map<string, Process[]>()
  for (const p of all) byProduct.set(p.product, [...(byProduct.get(p.product) ?? []), p])
  // Multi-output processes are also offered for their side products, after the main producers.
  for (const p of all) for (const item of p.secondary) byProduct.set(item, [...(byProduct.get(item) ?? []), p])
  // Every output is one a recipe can be run for: failed crafts too (Impure Copper Powder from the
  // Athanor's Copper Powder), last. Not where the recipe takes the item in as well (Steel Ingots give
  // back some of their Iron Ingot): running it uses more than it makes.
  for (const p of all)
    for (const o of p.outputs)
      if (
        o.item !== p.product &&
        !o.item.startsWith('@') &&
        !p.secondary.includes(o.item) &&
        !p.inputs.some((s) => s.item === o.item)
      )
        byProduct.set(o.item, [...(byProduct.get(o.item) ?? []), p])

  // Lower each item's reach to that of the processes making it until nothing changes (loops settle
  // on their cheapest way in). Items nothing makes and portals don't sell come from outside: tier 1.
  const reached = new Map<string, number>()
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
 * a saved cauldron recipe, else a Steam Boiler on High, else bought at a Purchasing Portal, else
 * taken from the bus. Coins are money off the bus: they're taken in at face value, and minted only for a
 * target (`asTarget`).
 */
export function defaultProducer(catalog: ProcessCatalog, item: string, asTarget = false): string {
  if (coinValue(item) !== null && !asTarget) return 'bus'
  const open = (p: Process | undefined): p is Process => !!p && catalog.reach(p) <= catalog.tier
  // The unlocked solid fuel with the most heat per item (Steam has to be made first).
  if (item === HEAT) {
    const fuels = (catalog.byProduct.get(HEAT) ?? []).filter((p) => p.id !== STEAM_HEAT_ID)
    return ([...fuels].filter(open).sort((a, b) => b.outputs[0].count - a.outputs[0].count)[0] ?? fuels[0])?.id ?? 'import'
  }
  if (item === NUTRIENTS) {
    const list = catalog.byProduct.get(item) ?? []
    return (list.find(open) ?? list[0])?.id ?? 'import'
  }
  if (item === MONEY) return spendId(defaultCoin(catalog.tier))
  const rank = (all: Process[]) => {
    const options = all.filter((p) => p.product === item && p.kind !== 'buy')
    return (
      options.find((p) => p.kind === 'recipe' && !p.alternate) ??
      // The Miniature World Tree is a player's pick, never the default.
      options.find((p) => p.kind === 'nursery' && p.machine?.key !== MINI_WORLD_TREE) ??
      options.find((p) => p.kind === 'nursery') ??
      options.find((p) => p.id === paradoxId(DEFAULT_PARADOX_INPUT)) ??
      options.find((p) => p.kind === 'paradox') ??
      options.find((p) => p.kind === 'recipe') ??
      options.find((p) => p.kind === 'cauldron') ??
      // The fewest boilers.
      options.find((p) => p.id === boilerId('High')) ??
      // Only made as a side product (e.g. Gentian Nectar from the Gentian nursery).
      all.find((p) => p.secondary.includes(item) && (p.kind === 'nursery' || p.kind === 'recipe')) ??
      all.find((p) => p.secondary.includes(item))
    )
  }
  // Only made by failed crafts (Crude Silver Powder from the Advanced Athanor's Silver Powder).
  const failing = (list: Process[]) =>
    list.find((p) => p.kind === 'recipe' && !p.alternate) ?? list.find((p) => p.kind !== 'buy')
  const all = catalog.byProduct.get(item) ?? []
  // Bought only when nothing makes it, and before running a recipe only for its failed crafts.
  const buy = all.find((p) => p.kind === 'buy')
  return (rank(all.filter(open)) ?? rank(all) ?? buy ?? failing(all.filter(open)) ?? failing(all))?.id ?? 'bus'
}

/**
 * Identifies a process on its machine with its catalysts, height and coin stack: branches can run one
 * recipe on different machines, load different catalysts, build them at different heights, or set
 * their Bank Portals to output different stacks (or be fed smaller stacks by one).
 */
export const runKey = (p: Process) =>
  [
    p.machine && p.machineOptions.length > 1 ? `${p.id}@${p.machine.key}` : p.id,
    ...[...p.catalysts].sort(),
    ...(p.acceptsHeight ? [`h${p.height}`] : []),
    ...(p.stack !== undefined ? [`s${p.stack}`] : []),
    ...(p.fertilizer ? [`f${p.fertilizer}`] : []),
    ...(p.coin ? [`c${p.coin}`] : []),
    ...Object.entries(p.inputStacks ?? {})
      .sort()
      .map(([item, n]) => `${item}@${n}`),
  ].join('+')

/** The same recipe on the same machine (catalysts and height aside): what a row loops back to. */
export const sameRecipe = (a: Process, b: Process) => a.id === b.id && a.machine?.key === b.machine?.key

/**
 * Short name for a producer option shown next to its product: the machine, or what sets the
 * option apart (the fuel burned, a saved mix's name or what it makes).
 */
export function processTitle(p: Process): string {
  if (p.kind === 'cauldron') return p.name || `${p.machine?.name ?? 'Cauldron'}: ${itemName(p.product)}`
  if (p.kind === 'fuel' || p.kind === 'fertilizer' || p.kind === 'spend') return itemName(p.inputs[0]?.item ?? '')
  if (p.kind === 'boiler') return `${p.machine?.name ?? 'Steam Boiler'} · ${p.label.slice(p.label.indexOf('(') + 1, -1)}`
  return p.machine?.name ?? p.label
}

/** Label for a producer option: ★ marks saved cauldron recipes. */
export function processLabel(p: Process, forItem?: string): string {
  const prefix = p.kind === 'cauldron' ? '★ ' : ''
  const machine = p.machine ? ` · ${p.machine.name}` : ''
  const side = forItem && forItem !== p.product ? ' (by-product)' : ''
  return `${prefix}${p.label}${p.kind === 'recipe' || p.kind === 'nursery' || p.kind === 'boiler' ? machine : ''}${side}`
}
