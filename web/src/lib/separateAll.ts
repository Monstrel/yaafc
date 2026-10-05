import { moveRows } from './choices'
import { runKey, type ProcessCatalog } from './processes'
import { separationKey, separationsOf, withSeparation } from './separate'
import type { Plan, Separation } from './types'
import { consumedBy, resolveChoice, unfold, type PlanNode } from './unfold'

/** Rows from the root of its tree down to `n`. */
function chain(n: PlanNode): PlanNode[] {
  const out: PlanNode[] = []
  for (let a: PlanNode | undefined = n; a; a = a.parent) out.unshift(a)
  return out
}

/** The nearest row above all of `rows` that can gather uses of `item`; none: the top of the plan. */
function commonAnchor(rows: PlanNode[], item: string): PlanNode | undefined {
  const chains = rows.map(chain)
  let common: PlanNode | undefined
  for (let i = 0; chains.every((c) => c[i] && c[i] === chains[0][i]); i++) common = chains[0][i]
  while (common && (common.kind !== 'make' || common.item === item)) common = common.parent
  return common
}

/** The part of `id` below `row` ('' for the row itself), or null when it isn't in that branch. */
const under = (id: string, row: string) => (id === row ? '' : id.startsWith(`${row}/`) ? id.slice(row.length) : null)

/** Everything set on a row and the rows below it (picks, catalysts, heights, ...), by place in the branch. */
function branchSettings(plan: Plan, row: string): string {
  const pick = <T>(record: Record<string, T> | undefined) =>
    Object.entries(record ?? {})
      .flatMap(([id, v]) => (under(id, row) === null ? [] : [[under(id, row), v] as const]))
      .sort(([a], [b]) => (a! < b! ? -1 : 1))
  return JSON.stringify([
    pick(plan.branches),
    pick(plan.rowCatalysts),
    pick(plan.rowHeights),
    pick(plan.units),
    (plan.roundUp ?? []).flatMap((id) => under(id, row) ?? []).sort(),
    separationsOf(plan.separate).flatMap((s) => (s.at && under(s.at, row) !== null ? [[s.item, s.anchor, under(s.at, row)]] : [])),
  ])
}

/**
 * Builds separately every item machines make in more than one row, gathering its rows under
 * their nearest common row (the top of the plan when they sit under different targets). Items
 * furthest up go first, since gathering them can leave fewer rows of what they're made from.
 * The gathered row keeps what was set on its rows and the rows below them. Items the plan
 * already builds separately keep their choice, and an item whose rows are set up differently, or
 * that would be made differently where it's gathered, stays as it is. Returns the plan itself
 * when there's nothing to gather.
 */
export function separateShared(plan: Plan, catalog: ProcessCatalog): Plan {
  let p = plan
  for (const next of sharedSeparations(plan, catalog)) p = next
  return p
}

/** Whether `separateShared` would gather anything (without gathering it all). */
export const canSeparateShared = (plan: Plan, catalog: ProcessCatalog) => !sharedSeparations(plan, catalog).next().done

/** The plan after each item `separateShared` gathers, one at a time. */
function* sharedSeparations(plan: Plan, catalog: ProcessCatalog): Generator<Plan> {
  const chosen = new Set(separationsOf(plan.separate).map((s) => s.item))
  const skipped = new Set<string>()
  const added = new Set<string>()
  const filled = plan.targets.filter((t) => t.item)
  let p = plan
  for (;;) {
    const { nodes, targetRows } = unfold(p, catalog)
    // An overflow target's row makes only its overflow: it never gathers other uses.
    const overflowRows = new Set(targetRows.filter((_, i) => consumedBy(filled[i])))
    const byItem = new Map<string, PlanNode[]>()
    for (const n of nodes)
      if (n.kind === 'make' && !n.separation && !overflowRows.has(n) && !chosen.has(n.item) && !skipped.has(n.item))
        byItem.set(n.item, [...(byItem.get(n.item) ?? []), n])
    const shared = [...byItem].filter(([, rows]) => rows.length > 1)
    const items = new Set(shared.map(([item]) => item))
    const below = (n: PlanNode) => {
      for (let a = n.parent; a; a = a.parent) if (a.item !== n.item && items.has(a.item)) return true
      return false
    }
    const upstream = shared.filter(([, rows]) => !rows.some(below))
    let next: Plan | null = null
    for (const [item, rows] of [...upstream, ...shared.filter((x) => !upstream.includes(x))]) {
      next = gathered(p, catalog, item, rows, nodes, targetRows, overflowRows, added)
      if (next) break
      skipped.add(item)
    }
    if (!next) return
    p = next
    yield p
  }
}

/**
 * The plan with an item's rows gathered into one, the settings on them and below them moved to
 * it; null when the rows are set up differently, or the gathered row would be made differently.
 */
function gathered(
  p: Plan,
  catalog: ProcessCatalog,
  item: string,
  rows: PlanNode[],
  nodes: PlanNode[],
  targetRows: PlanNode[],
  overflowRows: Set<PlanNode>,
  added: Set<string>,
): Plan | null {
  const anchor = commonAnchor(rows, item)
  const target = targetRows.find((n) => n.item === item && !overflowRows.has(n))
  const at = anchor ? `${anchor.id}/with:${item}` : (target?.id ?? `separate/${item}`)
  const setup = runKey(rows[0].process!)
  if (rows.some((n) => runKey(n.process!) !== setup)) return null
  const settings = branchSettings(p, rows[0].id)
  if (rows.some((n) => branchSettings(p, n.id) !== settings)) return null
  const s: Separation = !anchor
    ? { item }
    : nodes.filter((n) => n.kind === 'make' && n.item === anchor.item).length > 1
      ? { item, anchor: anchor.item, at: anchor.id }
      : { item, anchor: anchor.item }
  if (added.has(separationKey(s))) return null
  // One copy's settings go to the gathered row (a target's own row keeps its own); the rest go.
  const from = rows.find((n) => n.id === at) ?? rows[0]
  const moved = moveRows(p, (id) => {
    for (const n of rows) {
      const rest = under(id, n.id)
      if (rest !== null) return n === from ? at + rest : null
    }
    return id
  })
  const made = resolveChoice(moved, catalog, item, at).process
  if (!made || runKey(made) !== setup) return null
  added.add(separationKey(s))
  return { ...moved, separate: withSeparation(separationsOf(moved.separate), s) }
}

/**
 * Merges back every item built separately that gathers a single use (a target counts as one),
 * wherever it's gathered. Its rows move to where that use is, keeping their settings. Returns
 * the plan itself when there's nothing to merge.
 */
export function mergeSingleUses(plan: Plan, catalog: ProcessCatalog): Plan {
  const { nodes, targetRows } = unfold(plan, catalog)
  const uses = new Map<PlanNode, PlanNode[]>()
  const addUse = (row: PlanNode, by: PlanNode) => uses.set(row, [...(uses.get(row) ?? []), by])
  for (const n of nodes) if (n.kind === 'separate' && n.ref) addUse(n.ref, n)
  for (const n of targetRows) if (n.separation) addUse(n, n)
  // Most uses gathered by any row of each choice (an anchor can have several rows).
  const most = new Map<string, number>()
  for (const n of nodes) {
    if (!n.separation) continue
    const key = separationKey(n.separation)
    most.set(key, Math.max(most.get(key) ?? 0, uses.get(n)?.length ?? 0))
  }
  // Choices gathering nothing are left to `pruneChoices`.
  const merged = separationsOf(plan.separate).filter((s) => (most.get(separationKey(s)) ?? 2) <= 1)
  return merged.length ? mergeBack(plan, catalog, merged) : plan
}

/**
 * Builds an item separately (`on`) or merges it back, keeping what's set on the rows that move.
 * Gathered rows take their settings from the row the choice was made on (`from`), then the
 * gathering row's own, then the other rows'. Merged-back rows give theirs to every use. Choices
 * the new one replaces, and `replacing` (when moving an item gathered elsewhere), are merged back
 * first.
 */
export function setSeparation(
  plan: Plan,
  catalog: ProcessCatalog,
  s: Separation,
  on: boolean,
  from?: string,
  replacing?: Separation,
): Plan {
  if (!on) return mergeBack(plan, catalog, [s])
  const list = separationsOf(plan.separate)
  const next = withSeparation(
    list.filter((o) => !replacing || separationKey(o) !== separationKey(replacing)),
    s,
  )
  const replaced = list.filter((o) => !next.some((n) => separationKey(n) === separationKey(o)))
  return gatherInto(replaced.length ? mergeBack(plan, catalog, replaced) : plan, catalog, s, from)
}

/** The ids of the rows a gathering row supplies: its `separate` rows, and targets sharing it. */
function usesOf(g: PlanNode, nodes: PlanNode[], targetRows: PlanNode[]): string[] {
  return [
    ...nodes.filter((u) => u.kind === 'separate' && u.ref === g).map((u) => u.id),
    // Merged back, each target sharing the row gets its own (`i/Item`, the first keeping this one).
    ...targetRows.flatMap((t, i) => (t === g ? [`${i}/${g.item}`] : [])),
  ]
}

/** Drops build-separately choices, each gathering row's settings going to every use it had. */
function mergeBack(plan: Plan, catalog: ProcessCatalog, seps: Separation[]): Plan {
  const { nodes, targetRows } = unfold(plan, catalog)
  const keys = new Set(seps.map(separationKey))
  // Gathering rows can sit inside each other: the innermost moves first, then wherever it landed.
  const moves = nodes
    .filter((n) => n.separation && keys.has(separationKey(n.separation)))
    .map((n) => ({ from: n.id, to: usesOf(n, nodes, targetRows) }))
    .sort((a, b) => b.from.length - a.from.length)
  const remap = (id: string, hops = 0): string[] => {
    const move = hops <= moves.length && moves.find((m) => under(id, m.from) !== null)
    if (!move) return [id]
    // A target's own row stays put (nothing gathers targets, so it sits inside no other move).
    return move.to.flatMap((to) => (to === move.from ? [id] : remap(to + under(id, move.from), hops + 1)))
  }
  const kept = separationsOf(plan.separate).filter((s) => !keys.has(separationKey(s)))
  return moveRows({ ...plan, separate: kept }, (id) => remap(id))
}

/** Adds a build-separately choice, the rows it gathers giving their settings to the gathering row. */
function gatherInto(plan: Plan, catalog: ProcessCatalog, s: Separation, from?: string): Plan {
  const before = new Map(unfold(plan, catalog).nodes.map((n) => [n.id, n]))
  const next = { ...plan, separate: withSeparation(separationsOf(plan.separate), s) }
  const { nodes, targetRows } = unfold(next, catalog)
  // Rows of the item that are now uses of a gathering row (or the gathering row itself).
  const sources = nodes
    .filter((g) => g.separation && separationKey(g.separation) === separationKey(s))
    .flatMap((g) => [g.id, ...usesOf(g, nodes, targetRows)].map((id) => ({ id, to: g.id })))
    .filter(({ id }) => before.get(id)?.kind === 'make' && before.get(id)?.item === s.item)
    .sort((a, b) => b.id.length - a.id.length)
  const sourceOf = (id: string) => sources.find((x) => under(id, x.id) !== null)
  const rank = (id: string) => {
    const x = sourceOf(id)
    if (!x) return -1
    return x.id === from ? 0 : x.id === x.to ? 1 : 2
  }
  return moveRows(
    next,
    (id) => {
      const x = sourceOf(id)
      return x ? x.to + under(id, x.id) : id
    },
    rank,
  )
}
