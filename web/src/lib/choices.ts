import { HEAT, NUTRIENTS } from './gameData'
import { DEFAULT_BANK_STACK, defaultMachine, defaultProducer, type ProcessCatalog } from './processes'
import { separationKey, separationsOf } from './separate'
import type { TreeNode } from './tree'
import { blankTarget, type MyDefault, type MyDefaults, type Plan } from './types'
import { parentId, planProducer, resolveChoice, reusesByproducts, rowItem, unfold } from './unfold'

export interface ProducerPick {
  item: string
  /** Process id, 'import' (bought) or 'bus'. */
  producer: string
  /** Machine to run it on, when it can run on several. */
  machine?: string
  /** Tree row picked on; absent (or `everywhere`) = the plan-wide producer. */
  row?: string
  everywhere?: boolean
}

const without = <T>(rows: Record<string, T> | undefined, drop: (id: string) => boolean) =>
  rows && Object.fromEntries(Object.entries(rows).filter(([id]) => !drop(id)))

/**
 * Rows' picks with their producer and machine dropped where `drop` says, keeping any reuse setting:
 * taking by-products first is chosen apart from the producer that makes the rest.
 */
function withoutProducer(branches: Plan['branches'], drop: (id: string) => boolean): Plan['branches'] {
  return (
    branches &&
    Object.fromEntries(
      Object.entries(branches).flatMap(([id, pick]) =>
        !drop(id) ? [[id, pick]] : pick.reuse === undefined ? [] : [[id, { producer: '', reuse: pick.reuse }]],
      ),
    )
  )
}

/** Rows' picks with their reuse setting dropped where `drop` says, keeping the producer. */
function withoutReuse(branches: Plan['branches'], drop: (id: string) => boolean): Plan['branches'] {
  return (
    branches &&
    Object.fromEntries(
      Object.entries(branches).flatMap(([id, pick]) => {
        if (!drop(id)) return [[id, pick]]
        const { reuse: _, ...rest } = pick
        return rest.producer ? [[id, rest]] : []
      }),
    )
  )
}

/**
 * Applies a producer pick. On a row it covers that row's branch: the row and every row of its
 * item below it, replacing picks made further down. A pick matching what the row would inherit
 * anyway isn't stored. Everywhere, it becomes the plan-wide producer and clears the item's
 * branch picks. Whether rows take by-products first stays as it was: the producer makes the rest.
 */
export function chooseProducer(plan: Plan, catalog: ProcessCatalog, pick: ProducerPick): Plan {
  const { item, producer, machine, row } = pick
  if (!row || pick.everywhere)
    return {
      ...plan,
      producers: { ...plan.producers, [item]: producer },
      machines: machine ? { ...plan.machines, [producer]: machine } : plan.machines,
      branches: withoutProducer(plan.branches, (id) => rowItem(id) === item),
    }
  const next = {
    ...plan,
    branches: withoutProducer(plan.branches, (id) => (id === row || id.startsWith(`${row}/`)) && rowItem(id) === item),
  }
  const inherited = resolveChoice(next, catalog, item, row)
  const chosen = catalog.byId.get(producer)
  const onMachine = machine && chosen?.machineOptions.some((m) => m.key === machine) ? machine : chosen?.machine?.key
  if (inherited.producer === producer && inherited.process?.machine?.key === onMachine) return next
  return {
    ...next,
    branches: { ...next.branches, [row]: { ...next.branches?.[row], producer, ...(machine && { machine }) } },
  }
}

/**
 * Sets the fuel or fertilizer (`item`: heat or nutrients) the plan's rows burn or spread by
 * default. Rows that pick their own keep it (see `followDefault`).
 */
export const setPlanDefault = (plan: Plan, item: string, producer: string): Plan => ({
  ...plan,
  producers: { ...plan.producers, [item]: producer },
})

/** Rows of `item` picking a producer other than the plan's, by row id. */
export function ownPicks(plan: Plan, catalog: ProcessCatalog, item: string): string[] {
  const planWide = planProducer(plan, catalog, item)
  return Object.entries(plan.branches ?? {})
    .filter(([id, pick]) => pick.producer && pick.producer !== planWide && rowItem(id) === item)
    .map(([id]) => id)
}

/** Drops every row's own pick of `item`'s producer, so they all follow the plan's (reuse settings stay). */
export const followDefault = (plan: Plan, item: string): Plan => ({
  ...plan,
  branches: withoutProducer(plan.branches, (id) => rowItem(id) === item),
})

/** A list of items with `item` in it or not. */
function withItem(list: string[] | undefined, item: string, on: boolean): string[] | undefined {
  const rest = (list ?? []).filter((k) => k !== item)
  const next = on ? [...rest, item] : rest
  return next.length ? next : undefined
}

/**
 * Whether rows of `item` take other rows' by-products of it first, their producer making the rest
 * (off: it makes all of it, keeping to itself). Everywhere, it's the plan-wide setting and clears
 * the item's branch settings; on a row it covers the row's branch, and on, it also takes them from
 * rows that make their own. Producers stay as they were.
 */
export function chooseReuse(plan: Plan, item: string, on: boolean, row?: string): Plan {
  if (!row)
    return {
      ...plan,
      noReuse: withItem(plan.noReuse, item, !on),
      branches: withoutReuse(plan.branches, (id) => rowItem(id) === item),
    }
  const next = {
    ...plan,
    branches: withoutReuse(plan.branches, (id) => (id === row || id.startsWith(`${row}/`)) && rowItem(id) === item),
  }
  // Off where it's off anyway: nothing to store.
  if (!on && !reusesByproducts(next, item, row)) return next
  return { ...next, branches: { ...next.branches, [row]: { producer: '', ...next.branches?.[row], reuse: on } } }
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((k) => b.includes(k))

/**
 * Loads catalysts into one row's machines. The row keeps its own list only when it differs from
 * what it loads anyway (`inherited`: a saved default's), so it can also turn those off.
 */
export function setRowCatalysts(plan: Plan, row: string, catalysts: string[], inherited: string[] = []): Plan {
  const rest = without(plan.rowCatalysts, (id) => id === row) ?? {}
  return { ...plan, rowCatalysts: sameSet(catalysts, inherited) ? rest : { ...rest, [row]: catalysts } }
}

/**
 * Builds one row's Thermal Extractors at a height (the in-game "Height"). The row keeps its own
 * height only when it differs from the one it has anyway (`inherited`: a saved default's, else 0).
 */
export function setRowHeight(plan: Plan, row: string, height: number, inherited = 0): Plan {
  const rest = without(plan.rowHeights, (id) => id === row) ?? {}
  const rowHeights = height === inherited ? rest : { ...rest, [row]: height }
  return { ...plan, rowHeights: Object.keys(rowHeights).length ? rowHeights : undefined }
}

/**
 * Sets the coins one row's Bank Portals output per belt entry (the in-game "Conversion Amount"). The
 * row keeps its own stack only when it differs from the one it has anyway (`inherited`: a saved
 * default's, else 50).
 */
export function setRowStack(plan: Plan, row: string, stack: number, inherited = DEFAULT_BANK_STACK): Plan {
  const rest = without(plan.rowStacks, (id) => id === row) ?? {}
  const rowStacks = stack === inherited ? rest : { ...rest, [row]: stack }
  return { ...plan, rowStacks: Object.keys(rowStacks).length ? rowStacks : undefined }
}

/**
 * Plans saved before catalysts were per row kept them per recipe: loads them into every row running
 * that recipe where they apply. Returns null when there's nothing to move.
 */
export function migrateCatalysts(plan: Plan, catalog: ProcessCatalog): Plan | null {
  const legacy = plan.catalysts
  if (!legacy) return null
  const { catalysts: _, ...rest } = plan
  const rowCatalysts = { ...plan.rowCatalysts }
  for (const n of unfold(rest, catalog).nodes) {
    const list = n.process?.acceptsCatalysts ? legacy[n.process.id] : undefined
    if (list?.length && !rowCatalysts[n.id]) rowCatalysts[n.id] = list
  }
  return { ...rest, rowCatalysts }
}

/**
 * Plans saved before feedback was per item fed back the preferred fuel and fertilizer: feeds back
 * those items. Returns null when there's nothing to move.
 */
export function migrateFeedback(plan: Plan, catalog: ProcessCatalog): Plan | null {
  const legacy = plan.feedback
  if (!legacy) return null
  const { feedback: _, ...rest } = plan
  let feedbackItems = plan.feedbackItems
  for (const [use, key] of [['fuel', HEAT], ['fertilizer', NUTRIENTS]] as const) {
    const item = catalog.byId.get(planProducer(plan, catalog, key))?.inputs[0]?.item
    if (legacy[use] && item) feedbackItems = withItem(feedbackItems, item, true)
  }
  return { ...rest, feedbackItems }
}

/** Whether every source of an item covers what the plan takes of it from the bus (targets can say otherwise). */
export const setItemFeedback = (plan: Plan, item: string, on: boolean): Plan => ({
  ...plan,
  feedbackItems: withItem(plan.feedbackItems, item, on),
})

/** Feeds one target back or not; matching its item's setting drops the target's own. */
export function setTargetFeedback(plan: Plan, index: number, on: boolean): Plan {
  return {
    ...plan,
    targets: plan.targets.map((t, i) => {
      if (i !== index) return t
      const { feedback: _, ...rest } = t
      return on === !!plan.feedbackItems?.includes(t.item) ? rest : { ...rest, feedback: on }
    }),
  }
}

/** Runs a row on a whole number of machines (rounded up), or on just what it needs. */
export function setRoundUp(plan: Plan, row: string, on: boolean): Plan {
  const rest = (plan.roundUp ?? []).filter((id) => id !== row)
  const roundUp = on ? [...rest, row] : rest
  return { ...plan, roundUp: roundUp.length ? roundUp : undefined }
}

/**
 * Has a Paradox Crucible row also refine the by-products of the row below it, or only its input.
 * The row keeps its own setting only when it differs from the one it has anyway (`inherited`: a
 * saved default's, else off).
 */
export function setMixedFeed(plan: Plan, row: string, on: boolean, inherited = false): Plan {
  const rest = without(plan.mixedFeed, (id) => id === row) ?? {}
  const mixedFeed = on === inherited ? rest : { ...rest, [row]: on }
  return { ...plan, mixedFeed: Object.keys(mixedFeed).length ? mixedFeed : undefined }
}

/** Marks rows built in the player's game, or not: a checklist, it changes nothing the plan makes. */
export function setBuilt(plan: Plan, rows: string[], on: boolean): Plan {
  const built = new Set(plan.built)
  for (const id of rows) {
    if (on) built.add(id)
    else built.delete(id)
  }
  return { ...plan, built: built.size ? [...built] : undefined }
}

/**
 * Makes the plan provide its own `item` instead of taking it from the bus: a target of it at 0 net
 * per minute, fed back, at the end of the list, so it covers whatever the sources ahead of it leave. It's an
 * ordinary target from then on; removing it puts the plan back as it was.
 */
export const addProvider = (plan: Plan, item: string): Plan => ({
  ...plan,
  targets: [
    ...plan.targets,
    { item, rate: 0, unit: 'net', ...(!plan.feedbackItems?.includes(item) && { feedback: true }) },
  ],
})

/**
 * Caps what the bus carries of an item (items per minute; undefined lifts the cap): the plan's
 * rows taking it from the bus share that, falling short past it.
 */
export function setBusSupply(plan: Plan, item: string, cap: number | undefined): Plan {
  const { [item]: _, ...rest } = plan.busSupply ?? {}
  const busSupply = cap === undefined || !(cap >= 0) ? rest : { ...rest, [item]: cap }
  return { ...plan, busSupply: Object.keys(busSupply).length ? busSupply : undefined }
}

/**
 * Adds a target of `item` that uses what the plan's other rows leave of the bus's capped supply of
 * `consumes`, at the end of the list: the planner makes as many as that comes to. Removing it puts
 * the plan back as it was.
 */
export const addSupplyTarget = (plan: Plan, item: string, consumes: string): Plan => ({
  ...plan,
  targets: [...plan.targets, { item, rate: 0, unit: 'supply', consumes }],
})

/**
 * Adds a target of `item` that uses the plan's overflow of `consumes`, at the end of the list: the
 * planner makes as many as that overflow comes to. Removing it puts the plan back as it was.
 */
export const addOverflowTarget = (plan: Plan, item: string, consumes: string): Plan => ({
  ...plan,
  targets: [...plan.targets, { item, rate: 0, unit: 'overflow', consumes }],
})

/**
 * Makes a target an overflow target, using the plan's overflow of `consumes`: the planner sizes it
 * from then on. Making it a standard target again keeps what it makes then.
 */
export const linkToOverflow = (plan: Plan, index: number, consumes: string): Plan => ({
  ...plan,
  targets: plan.targets.map((t, i) => (i === index ? { ...t, unit: 'overflow', consumes } : t)),
})

/**
 * Makes a target a supply target, using what the plan's other rows leave of the bus's capped supply
 * of `consumes`: the planner sizes it from then on. Making it a standard target again keeps what it
 * makes then.
 */
export const linkToSupply = (plan: Plan, index: number, consumes: string): Plan => ({
  ...plan,
  targets: plan.targets.map((t, i) => (i === index ? { ...t, unit: 'supply', consumes } : t)),
})

/**
 * Makes an overflow or supply target an ordinary one, making what it makes now (`rate` per minute;
 * when it makes none, a new target's 10 per minute).
 */
export const convertOverflowTarget = (plan: Plan, index: number, rate: number): Plan => ({
  ...plan,
  targets: plan.targets.map((t, i) => {
    if (i !== index || (t.unit !== 'overflow' && t.unit !== 'supply')) return t
    const { consumes: _, unit: __, ...rest } = t
    return { ...rest, rate: rate > 0 ? Math.round(rate * 1000) / 1000 : 10 }
  }),
})

/**
 * Puts the targets in a new order (`order` lists old indexes; leaving one out removes it). Tree
 * row ids start with their target's place, so per-row picks, catalysts, heights, coin stacks and build-separately rows
 * move with their target, and a removed target's go with it.
 */
export function reorderTargets(plan: Plan, order: number[]): Plan {
  // Row ids number only the targets with an item.
  const places = (targets: Plan['targets']) => {
    let k = 0
    return targets.map((t) => (t.item ? k++ : -1))
  }
  const before = places(plan.targets)
  const targets = order.map((i) => plan.targets[i])
  const after = places(targets)
  const moved = new Map<string, string>()
  order.forEach((old, j) => before[old] >= 0 && moved.set(String(before[old]), String(after[j])))
  /** The row id after the move; null when its target is gone. Rows not under a target stay. */
  const remap = (id: string): string | null => {
    const k = id.indexOf('/')
    const head = k < 0 ? id : id.slice(0, k)
    if (!/^\d+$/.test(head)) return id
    const to = moved.get(head)
    return to === undefined ? null : to + id.slice(head.length)
  }
  return { ...moveRows(plan, remap), targets }
}

/**
 * Moves per-row picks, catalysts, heights, coin stacks, build-separately rows, rounding, units and built marks to
 * the rows' new ids. `remap` gives null for a row that's gone (dropping its settings), or several ids for a
 * row copied to several places. Where rows land on the same id, the one with the lowest `rank` wins.
 */
export function moveRows(
  plan: Plan,
  remap: (id: string) => string | string[] | null,
  rank: (id: string) => number = () => 0,
): Plan {
  const to = (id: string) => [remap(id) ?? []].flat()
  const rows = <T>(record: Record<string, T> | undefined) => {
    if (!record) return record
    const out = new Map<string, { v: T; rank: number }>()
    for (const [id, v] of Object.entries(record))
      for (const k of to(id)) if (!out.has(k) || rank(id) < out.get(k)!.rank) out.set(k, { v, rank: rank(id) })
    return Object.fromEntries([...out].map(([k, x]) => [k, x.v]))
  }
  const separate =
    plan.separate &&
    separationsOf(plan.separate)
      .flatMap((s) => (s.at ? to(s.at).map((at) => ({ ...s, at })) : [s]))
      .filter((s, i, all) => all.findIndex((o) => separationKey(o) === separationKey(s)) === i)
  const roundUp = plan.roundUp && [...new Set(plan.roundUp.flatMap(to))]
  const built = plan.built && [...new Set(plan.built.flatMap(to))]
  return {
    ...plan,
    branches: rows(plan.branches),
    rowCatalysts: rows(plan.rowCatalysts),
    rowHeights: rows(plan.rowHeights),
    rowStacks: rows(plan.rowStacks),
    separate,
    roundUp: roundUp?.length ? roundUp : undefined,
    mixedFeed: rows(plan.mixedFeed),
    units: rows(plan.units),
    built: built?.length ? built : undefined,
  }
}

export const moveTarget = (plan: Plan, from: number, to: number) => {
  const order = plan.targets.map((_, i) => i)
  order.splice(to, 0, ...order.splice(from, 1))
  return reorderTargets(plan, order)
}

/** Removes a target, its rows' settings with it. The only target is cleared instead: a plan always has one. */
export function removeTarget(plan: Plan, index: number): Plan {
  const rest = reorderTargets(
    plan,
    plan.targets.map((_, i) => i).filter((i) => i !== index),
  )
  return rest.targets.length ? rest : { ...rest, targets: [blankTarget()] }
}

/**
 * "Use as my default": remembers how a row and everything below it is made (recipe, machine,
 * catalysts, height, coin stack and mixed feed per item, the topmost row winning when an item appears more than once), following
 * separate builds to the rows that make them. An item made the built-in way drops any saved
 * default instead. The plan's own picks in that part of the tree that now match the saved
 * defaults are dropped, so those rows follow the defaults.
 */
export function rememberSetup(
  plan: Plan,
  catalog: ProcessCatalog,
  tree: TreeNode[],
  row: TreeNode,
): { mine: MyDefaults; plan: Plan } {
  const { setups, covered } = setupsBelow(rowsById(tree), row)
  const machineOf = (s: MyDefault) => machineOfSetup(catalog, s)
  const builtIn = (item: string, s: MyDefault) => isBuiltIn(catalog, item, s)
  const mine = { ...catalog.mine }
  for (const [item, { setup: s }] of setups) {
    if (builtIn(item, s)) delete mine[item]
    else mine[item] = s
  }

  const matches = (item: string, pick: { producer: string; machine?: string }) => {
    const s = setups.get(item)?.setup
    return !!s && s.producer === pick.producer && machineOf(s) === machineOf(pick)
  }
  const underRow = (id: string) => covered.has(id)
  const next: Plan = {
    ...plan,
    producers: Object.fromEntries(Object.entries(plan.producers).filter(([item, producer]) => !matches(item, { producer }))),
    branches: without(plan.branches, (id) => underRow(id) && matches(rowItem(id), plan.branches![id])),
    rowCatalysts: without(
      plan.rowCatalysts,
      (id) => underRow(id) && sameSet(plan.rowCatalysts![id], setups.get(rowItem(id))?.setup.catalysts ?? []),
    ),
    rowHeights: without(
      plan.rowHeights,
      (id) => underRow(id) && plan.rowHeights![id] === (setups.get(rowItem(id))?.setup.height ?? 0),
    ),
    rowStacks: without(
      plan.rowStacks,
      (id) => underRow(id) && plan.rowStacks![id] === (setups.get(rowItem(id))?.setup.stack ?? DEFAULT_BANK_STACK),
    ),
    mixedFeed: without(plan.mixedFeed, (id) => underRow(id) && plan.mixedFeed![id] === !!setups.get(rowItem(id))?.setup.mixed),
  }
  return { mine, plan: next }
}

/**
 * Un-saving a default from a row of the plan: the rows following it keep being made that way, as
 * the plan's own picks (recipe, machine, catalysts, height, coin stack, mixed feed), so only other plans lose it.
 */
export function keepDefaultInPlan(plan: Plan, tree: TreeNode[], item: string, saved: MyDefault): Plan {
  const branches = { ...plan.branches }
  const rowCatalysts = { ...plan.rowCatalysts }
  const rowHeights = { ...plan.rowHeights }
  const rowStacks = { ...plan.rowStacks }
  const mixedFeed = { ...plan.mixedFeed }
  for (const n of rowsById(tree).values()) {
    if (n.item !== item || !n.mine) continue
    branches[n.id] = { ...branches[n.id], producer: saved.producer, ...(saved.machine && { machine: saved.machine }) }
    if (saved.catalysts?.length && !rowCatalysts[n.id]) rowCatalysts[n.id] = [...saved.catalysts]
    if (saved.height && rowHeights[n.id] === undefined) rowHeights[n.id] = saved.height
    if (saved.stack && rowStacks[n.id] === undefined) rowStacks[n.id] = saved.stack
    if (saved.mixed && n.mixable && mixedFeed[n.id] === undefined) mixedFeed[n.id] = true
  }
  return {
    ...plan,
    branches,
    rowCatalysts,
    rowHeights: Object.keys(rowHeights).length ? rowHeights : undefined,
    rowStacks: Object.keys(rowStacks).length ? rowStacks : undefined,
    mixedFeed: Object.keys(mixedFeed).length ? mixedFeed : undefined,
  }
}

/**
 * Whether "Use as my default" on a row would change anything: an item below it made differently
 * from its saved default (or saved but now made the built-in way), or a row not yet following the
 * default it matches. When nothing would change, the row is made the saved or built-in way.
 */
export function rememberChanges(catalog: ProcessCatalog, rows: Map<string, TreeNode>, row: TreeNode): boolean {
  for (const [item, { setup, node }] of setupsBelow(rows, row).setups) {
    const saved = catalog.mine[item]
    if (isBuiltIn(catalog, item, setup)) {
      if (saved) return true
    } else if (!node.mine || !saved || !sameSetup(catalog, saved, setup)) return true
  }
  return false
}

/** Every row of the tree by id. */
export function rowsById(tree: TreeNode[]): Map<string, TreeNode> {
  const rows = new Map<string, TreeNode>()
  const index = (n: TreeNode) => {
    rows.set(n.id, n)
    n.children.forEach(index)
  }
  tree.forEach(index)
  return rows
}

/**
 * How a row and everything below it is made, per item: the row nearest the top sets each item
 * (breadth first), following separate builds to the rows that make them.
 */
function setupsBelow(rows: Map<string, TreeNode>, row: TreeNode) {
  const setups = new Map<string, { setup: MyDefault; node: TreeNode }>()
  const covered = new Set<string>()
  const queue = [row]
  while (queue.length) {
    const n = queue.shift()!
    if (covered.has(n.id)) continue
    covered.add(n.id)
    // Recovering other machines' outputs isn't how the item is made: never a default.
    if (n.recovery) continue
    if (n.kind === 'separate') {
      const group = n.groupId && rows.get(n.groupId)
      if (group) queue.push(group)
      continue
    }
    const p = n.run?.process
    // What a row burns or spreads is the plan's choice, not how its item is made.
    const above = parentId(n.id)
    const fuel = n.item.startsWith('@') || (above !== null && rowItem(above).startsWith('@'))
    if (n.producer && !fuel && !setups.has(n.item))
      setups.set(n.item, {
        node: n,
        setup: {
          producer: n.producer,
          ...(p && p.machineOptions.length > 1 && p.machine && { machine: p.machine.key }),
          ...(p?.catalysts.length && { catalysts: [...p.catalysts] }),
          ...(p?.acceptsHeight && p.height && { height: p.height }),
          ...(p?.stack !== undefined && p.stack !== DEFAULT_BANK_STACK && { stack: p.stack }),
          ...(n.mixed && { mixed: true }),
        },
      })
    queue.push(...n.children)
  }
  return { setups, covered }
}

const machineOfSetup = (catalog: ProcessCatalog, s: MyDefault) => {
  const p = catalog.byId.get(s.producer)
  return p && (s.machine ?? defaultMachine(p, catalog.tier))
}

/** The item made the way the planner would without any picks. */
function isBuiltIn(catalog: ProcessCatalog, item: string, s: MyDefault): boolean {
  const p = catalog.byId.get(s.producer)
  return (
    s.producer === defaultProducer(catalog, item) &&
    (!p || machineOfSetup(catalog, s) === defaultMachine(p, catalog.tier)) &&
    !s.catalysts &&
    !s.height &&
    !s.stack &&
    !s.mixed
  )
}

const sameSetup = (catalog: ProcessCatalog, a: MyDefault, b: MyDefault) =>
  a.producer === b.producer &&
  machineOfSetup(catalog, a) === machineOfSetup(catalog, b) &&
  sameSet(a.catalysts ?? [], b.catalysts ?? []) &&
  (a.height ?? 0) === (b.height ?? 0) &&
  (a.stack ?? DEFAULT_BANK_STACK) === (b.stack ?? DEFAULT_BANK_STACK) &&
  !!a.mixed === !!b.mixed

/** Drops a row's own producer pick, so it follows the rows above it (or the plan) again; reuse stays as set. */
export function clearBranchChoice(plan: Plan, row: string): Plan {
  return { ...plan, branches: withoutProducer(plan.branches, (id) => id === row) }
}

/**
 * Drops producer, machine, catalyst, height, coin stack, branch and build-separately choices (and built marks) for
 * items, processes and rows no longer in the plan, so an item that's removed and added back starts from its default
 * recipe instead of whatever was last picked for it. A build-separately choice that gathers
 * nothing (its anchor no longer sits above the item, say) goes too. Fuel and fertilizer choices
 * are plan-wide settings and always kept. Returns null when there's nothing to drop.
 */
export function pruneChoices(plan: Plan, catalog: ProcessCatalog): Plan | null {
  const { nodes } = unfold(plan, catalog)
  const rows = new Set(nodes.map((n) => n.id))
  const items = new Set(nodes.map((n) => n.item))
  const processes = new Set(nodes.flatMap((n) => (n.process ? [n.process.id] : [])))
  const gathering = new Set(nodes.flatMap((n) => (n.separation ? [separationKey(n.separation)] : [])))
  const keep = <T>(record: Record<string, T> | undefined, test: (key: string) => boolean) => {
    if (!record) return { record, dropped: false }
    const kept = Object.fromEntries(Object.entries(record).filter(([k]) => test(k)))
    return { record: kept, dropped: Object.keys(kept).length !== Object.keys(record).length }
  }
  // The plan's defaults for what it burns, spreads and pays with stay while they still exist.
  const p = keep(plan.producers, (item) => (item.startsWith('@') ? catalog.byId.has(plan.producers[item]) : items.has(item)))
  const m = keep(plan.machines, (id) => processes.has(id))
  // Catalysts stay with a row only while its machines can take them.
  const loadable = new Set(nodes.flatMap((n) => (n.process?.acceptsCatalysts ? [n.id] : [])))
  const c = keep(plan.rowCatalysts, (id) => loadable.has(id))
  // Heights stay with a row only while its machines' output depends on it.
  const raised = new Set(nodes.flatMap((n) => (n.process?.acceptsHeight ? [n.id] : [])))
  const h = keep(plan.rowHeights, (id) => raised.has(id))
  // Coin stacks stay with a row only while it converts coins.
  const converting = new Set(nodes.flatMap((n) => (n.process?.stack !== undefined ? [n.id] : [])))
  const k = keep(plan.rowStacks, (id) => converting.has(id))
  const b = keep(plan.branches, (id) => rows.has(id))
  const separate = plan.separate && separationsOf(plan.separate).filter((s) => gathering.has(separationKey(s)))
  const s = separate?.length !== plan.separate?.length
  const noReuse = plan.noReuse?.filter((item) => items.has(item))
  const r = noReuse?.length !== plan.noReuse?.length
  // Fed-back items stay while the plan still makes them (as a row's item or a side output).
  const made = new Set([...items, ...nodes.flatMap((n) => n.process?.outputs.map((o) => o.item) ?? [])])
  const feedbackItems = plan.feedbackItems?.filter((item) => made.has(item))
  const f = feedbackItems?.length !== plan.feedbackItems?.length
  // Rounding and units stay with rows its machines still run on.
  const running = new Set(nodes.flatMap((n) => (n.kind === 'make' ? [n.id] : [])))
  const roundUp = plan.roundUp?.filter((id) => running.has(id))
  const u = roundUp?.length !== plan.roundUp?.length
  // A mixed feed stays with a crucible row while the row below it makes something it can refine.
  const mixable = new Set(nodes.flatMap((n) => (n.mixable?.length ? [n.id] : [])))
  const x = keep(plan.mixedFeed, (id) => mixable.has(id))
  const units = keep(plan.units, (id) => running.has(id))
  // Only machines get built: marks stay with rows that run some.
  const built = plan.built?.filter((id) => running.has(id))
  const d = built?.length !== plan.built?.length
  // Caps on the bus's supply stay while the plan takes the item from the bus.
  const drawn = new Set(nodes.flatMap((n) => (n.kind === 'bus' ? [n.item] : [])))
  const caps = keep(plan.busSupply, (item) => drawn.has(item))
  const dropped = [p, m, c, h, k, b, x, units, caps].some((y) => y.dropped) || s || r || f || u || d
  if (!dropped) return null
  return {
    ...plan,
    producers: p.record!,
    machines: m.record!,
    rowCatalysts: c.record,
    rowHeights: h.record && Object.keys(h.record).length ? h.record : undefined,
    rowStacks: k.record && Object.keys(k.record).length ? k.record : undefined,
    branches: b.record,
    separate,
    noReuse: noReuse?.length ? noReuse : undefined,
    feedbackItems: feedbackItems?.length ? feedbackItems : undefined,
    roundUp: roundUp?.length ? roundUp : undefined,
    mixedFeed: x.record && Object.keys(x.record).length ? x.record : undefined,
    units: units.record && Object.keys(units.record).length ? units.record : undefined,
    built: built?.length ? built : undefined,
    busSupply: caps.record && Object.keys(caps.record).length ? caps.record : undefined,
  }
}
