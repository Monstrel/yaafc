import { findRecipes, type CauldronMode } from './cauldron'
import { itemName } from './gameData'
import { allowedIngredients, prefOf, setPrefs, type IngredientPrefs } from './itemGroups'

/** The recipe finder's filters. */
export interface FinderQuery {
  target: string
  mode: CauldronMode
  prefs: IngredientPrefs
  mustInclude: string | null
}

/** A one-click change to the filters, with how many recipes it would find. */
export interface Fix {
  label: string
  query: FinderQuery
  count: number
}

export interface Diagnosis {
  reason: string
  fixes: Fix[]
}

const MODE_NAME: Record<CauldronMode, string> = { normal: 'Cauldron', advanced: 'Advanced Cauldron' }

export function countRecipes({ target, mode, prefs, mustInclude }: FinderQuery, limit = 20000): number {
  const list = findRecipes(target, mode, allowedIngredients(prefs), limit)
  return mustInclude ? list.filter((r) => r.inputs.includes(mustInclude)).length : list.length
}

/**
 * Explain an empty search: name the conflicting filters and offer fixes that would find something.
 * Fixes that still find nothing are dropped.
 */
export function diagnoseNoResults(q: FinderQuery): Diagnosis {
  const target = itemName(q.target)
  const must = q.mustInclude
  const mustName = must ? itemName(must) : ''
  const { prefs } = q

  const clearMust: Omit<Fix, 'count'> = { label: 'Clear "Must include"', query: { ...q, mustInclude: null } }
  const allowAll: Omit<Fix, 'count'> = { label: 'Turn off "Only use preferred"', query: { ...q, prefs: { ...prefs, onlyPreferred: false } } }
  const clearAvoided: Omit<Fix, 'count'> = { label: 'Clear avoided ingredients', query: { ...q, prefs: { ...prefs, avoid: [] } } }
  const otherMode: CauldronMode = q.mode === 'normal' ? 'advanced' : 'normal'
  const switchMode: Omit<Fix, 'count'> = { label: `Try the ${MODE_NAME[otherMode]}`, query: { ...q, mode: otherMode } }

  let reason: string
  let candidates: Omit<Fix, 'count'>[]
  if (must === q.target) {
    reason = `${target} is the target, and a recipe can't use its own product as an ingredient.`
    candidates = [clearMust]
  } else if (must && prefOf(prefs, must) === 'avoid') {
    reason = `"Must include" asks for ${mustName}, but ${mustName} is avoided in your ingredient preferences.`
    candidates = [{ label: `Make ${mustName} neutral`, query: { ...q, prefs: setPrefs(prefs, [must], null) } }, clearMust]
  } else if (must && prefs.onlyPreferred && prefOf(prefs, must) !== 'prefer') {
    reason = `"Only use preferred ingredients" is on, and ${mustName} isn't preferred.`
    candidates = [{ label: `Prefer ${mustName}`, query: { ...q, prefs: setPrefs(prefs, [must], 'prefer') } }, allowAll, clearMust]
  } else if (prefs.onlyPreferred && prefs.prefer.length === 0) {
    reason = '"Only use preferred ingredients" is on, but no ingredients are preferred.'
    candidates = [allowAll]
  } else {
    const unfiltered = countRecipes({ ...q, prefs: { prefer: [], avoid: [], onlyPreferred: false }, mustInclude: null })
    reason =
      unfiltered === 0
        ? `No combination of ingredients makes ${target} in the ${MODE_NAME[q.mode]}.`
        : `${target} has ${unfiltered.toLocaleString()} recipes, but none of them fit all of your filters at once.`
    candidates = [
      ...(prefs.onlyPreferred ? [allowAll] : []),
      ...(prefs.avoid.length > 0 ? [clearAvoided] : []),
      ...(must ? [clearMust] : []),
      switchMode,
    ]
  }

  const fixes = candidates.map((f) => ({ ...f, count: countRecipes(f.query) })).filter((f) => f.count > 0)
  return { reason, fixes }
}
