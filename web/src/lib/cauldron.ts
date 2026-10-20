import { cauldronTargets, itemsByKey, type Item } from './gameData'

export type CauldronMode = 'normal' | 'advanced'

export interface CauldronResult {
  output: Item
  /** Value the game compares against target values (after duplicate penalty / difference). */
  value: number
  /** Duplicate penalty multiplier (normal mode). */
  ratio: number
  /** How far the value is from the output's target value (value − target). */
  offset: number
}

const EPS = 1e-9

function item(key: string): Item {
  const it = itemsByKey.get(key)
  if (!it) throw new Error(`Unknown item ${key}`)
  return it
}

/** Normal cauldron: three ingredients, value = sum × duplicate penalty, closest target wins. */
export function evaluateNormal(keys: [string, string, string], targets: Item[] = cauldronTargets): CauldronResult | null {
  const [a, b, c] = keys.map(item)
  const allSame = a.key === b.key && b.key === c.key
  const twoSame = a.key === b.key || b.key === c.key || a.key === c.key
  const ratio = allSame ? 0.5 : twoSame ? 0.65 : 1
  const value = (a.cauldronCost + b.cauldronCost + c.cauldronCost) * ratio

  let best: Item | null = null
  let bestDistance = Infinity
  for (const t of targets) {
    const d = Math.abs((value - t.cauldronTarget) * t.cauldronMulti)
    if (d < bestDistance - EPS || (Math.abs(d - bestDistance) <= EPS && best && t.id < best.id)) {
      best = t
      bestDistance = d
    }
  }
  return best ? { output: best, value, ratio, offset: value - best.cauldronTarget } : null
}

/**
 * Advanced cauldron: two ingredients.
 * Different items → |A − B|, closest target below the higher cost (the higher item itself excluded).
 * Same item twice → the next target strictly above its cost.
 */
export function evaluateAdvanced(keys: [string, string], targets: Item[] = cauldronTargets): CauldronResult | null {
  const [a, b] = keys.map(item)
  if (a.key === b.key) {
    const next = targets
      .filter((t) => t.key !== a.key && t.cauldronTarget > a.cauldronCost)
      .sort((x, y) => x.cauldronTarget - y.cauldronTarget || x.id - y.id)[0]
    return next ? { output: next, value: a.cauldronCost, ratio: 1, offset: a.cauldronCost - next.cauldronTarget } : null
  }

  const value = Math.abs(a.cauldronCost - b.cauldronCost)
  const high = Math.max(a.cauldronCost, b.cauldronCost)
  const higher = a.cauldronCost > b.cauldronCost ? a : b.cauldronCost > a.cauldronCost ? b : a.id < b.id ? a : b
  let best: Item | null = null
  let bestDistance = Infinity
  for (const t of targets) {
    if (t.cauldronTarget >= high || t.key === higher.key) continue
    const d = Math.abs(value - t.cauldronTarget)
    if (d < bestDistance - EPS || (Math.abs(d - bestDistance) <= EPS && best && t.id < best.id)) {
      best = t
      bestDistance = d
    }
  }
  return best ? { output: best, value, ratio: 1, offset: value - best.cauldronTarget } : null
}

export function evaluate(mode: CauldronMode, keys: string[]): CauldronResult | null {
  if (mode === 'normal' && keys.length === 3) return evaluateNormal(keys as [string, string, string])
  if (mode === 'advanced' && keys.length === 2) return evaluateAdvanced(keys as [string, string])
  return null
}

// ---- Craft time and heat ----
// Not stored in the data tables. ABeltTDGameStateBase::GetCauldronProduct (VA 0x144A624C0, build
// 25991404) runs the output's CauldronTarget through this piecewise-linear curve (segments split at
// 100 / 1000 / 10000, the first and last extrapolated), clamps time to 3–60 s and heat to 1–10000 P/s,
// then rounds both half-up to 0.1 and stores the rounded values: Charcoal (target 2) is exactly
// 3.0 s and 1.2 P/s, not 3.0303… and 1.1919….
// Each segment is start + (v − segment start) × slope, the slope a precomputed constant (3/99, 6/900,
// …). Evaluated in any other order, a value landing on a .x5 tie can round the other way (647.5 gives
// 9.7 s in the game, 9.6 s via (v − lo) / (hi − lo)).
const CURVE_VALUE = [1, 100, 1e3, 1e4, 1e6]
const CURVE_TIME = [3, 6, 12, 24, 60]
const CURVE_HEAT = [1, 20, 200, 1500, 1e4]

/** The game's rounding: floor(x × 10 + 0.5) × 0.1. */
const roundTenth = (x: number) => Math.floor(x * 10 + 0.5) * 0.1

export interface CauldronStats {
  /** Seconds per craft at Factory Efficiency level 0. */
  seconds: number
  /** Heat consumption in P/s while crafting at level 0. */
  heatPerSecond: number
}

export function cauldronStats(targetValue: number): CauldronStats {
  const v = targetValue
  let i = 0
  while (i < CURVE_VALUE.length - 2 && v >= CURVE_VALUE[i + 1]) i++
  const span = CURVE_VALUE[i + 1] - CURVE_VALUE[i]
  const dv = v - CURVE_VALUE[i]
  const seconds = dv * ((CURVE_TIME[i + 1] - CURVE_TIME[i]) / span) + CURVE_TIME[i]
  const heat = dv * ((CURVE_HEAT[i + 1] - CURVE_HEAT[i]) / span) + CURVE_HEAT[i]
  return {
    seconds: roundTenth(Math.max(Math.min(seconds, CURVE_TIME.at(-1)!), CURVE_TIME[0])),
    heatPerSecond: roundTenth(Math.max(Math.min(heat, CURVE_HEAT.at(-1)!), CURVE_HEAT[0])),
  }
}

// ---- Reverse search ----

export interface FoundRecipe {
  mode: CauldronMode
  inputs: string[]
  result: CauldronResult
}

/**
 * All ingredient combinations (unordered, repeats allowed) producing `targetKey`.
 * Combinations that consume the target itself are skipped: they never make sense to build.
 */
export function findRecipes(targetKey: string, mode: CauldronMode, ingredients: Item[], limit = 5000): FoundRecipe[] {
  const sorted = ingredients
    .filter((i) => i.key !== targetKey)
    .sort((a, b) => a.cauldronCost - b.cauldronCost || a.id - b.id)
  const found: FoundRecipe[] = []

  if (mode === 'advanced') {
    for (let i = 0; i < sorted.length && found.length < limit; i++)
      for (let j = i; j < sorted.length; j++) {
        const keys: [string, string] = [sorted[i].key, sorted[j].key]
        const r = evaluateAdvanced(keys)
        if (r?.output.key === targetKey) found.push({ mode, inputs: keys, result: r })
      }
    return found
  }

  // Normal: the winning value range for this target is bounded by the neighbouring targets, so
  // only sums inside [lo, hi] (per duplicate ratio) can match; prune the triple loop with it.
  const target = itemsByKey.get(targetKey)
  if (!target) return found
  const values = cauldronTargets.map((t) => t.cauldronTarget).sort((a, b) => a - b)
  const below = values.filter((v) => v < target.cauldronTarget).at(-1)
  const above = values.find((v) => v > target.cauldronTarget)
  const lo = below === undefined ? -Infinity : (below + target.cauldronTarget) / 2 - EPS
  const hi = above === undefined ? Infinity : (above + target.cauldronTarget) / 2 + EPS
  const n = sorted.length
  const costs = sorted.map((s) => s.cauldronCost)

  for (let i = 0; i < n && found.length < limit; i++) {
    for (let j = i; j < n && found.length < limit; j++) {
      // Smallest possible sum with this i, j already too big even at the 0.5 ratio → stop.
      if ((costs[i] + costs[j] + costs[j]) * 0.5 > hi) break
      for (let k = j; k < n; k++) {
        const sum = costs[i] + costs[j] + costs[k]
        const ratio = i === j && j === k ? 0.5 : i === j || j === k ? 0.65 : 1
        const value = sum * ratio
        if (sum * 0.5 > hi) break
        if (value < lo || value > hi) continue
        const keys: [string, string, string] = [sorted[i].key, sorted[j].key, sorted[k].key]
        const r = evaluateNormal(keys)
        if (r?.output.key === targetKey) found.push({ mode, inputs: keys, result: r })
      }
    }
  }
  return found
}

/** Order-independent identity of a cauldron mix, used to spot already-saved recipes. */
export function recipeSignature(mode: CauldronMode, inputs: string[]) {
  return `${mode}:${[...inputs].sort().join('+')}`
}
