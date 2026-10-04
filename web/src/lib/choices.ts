import { HEAT, NUTRIENTS, realItem } from './gameData'
import { defaultMachine, defaultProducer, type ProcessCatalog } from './processes'
import { separationKey, separationsOf } from './separate'
import type { TreeNode } from './tree'
import type { MyDefault, MyDefaults, Plan } from './types'
import { planProducer, resolveChoice, reusesByproducts, rowItem, unfold } from './unfold'

export interface ProducerPick {
  item: string
  /** Process id, or 'import'. */
  producer: string
  /** Machine to run it on, when it can run on several. */
  machine?: string
  /** Tree row picked on; absent (or `everywhere`) = the plan-wide producer. */
  row?: string
  everywhere?: boolean
  /**
   * Picked from a menu offering by-product reuse: picking a producer there means making all of the
   * item with it (false); picking reuse itself (true) goes back to taking by-products first.
   */
  reuse?: boolean
}

const without = <T>(rows: Record<string, T> | undefined, drop: (id: string) => boolean) =>
  rows && Object.fromEntries(Object.entries(rows).filter(([id]) => !drop(id)))

/**
 * Applies a producer pick. On a row it covers that row's branch: the row and every row of its
 * item below it, replacing picks made further down. A pick matching what the row would inherit
 * anyway isn't stored. Everywhere, it becomes the plan-wide producer and clears the item's
 * branch picks.
 */
export function chooseProducer(plan: Plan, catalog: ProcessCatalog, pick: ProducerPick): Plan {
  const { item, producer, machine, row, reuse } = pick
  if (reuse) return chooseReuse(plan, item, pick.everywhere ? undefined : row)
  if (!row || pick.everywhere)
    return {
      ...plan,
      producers: { ...plan.producers, [item]: producer },
      machines: machine ? { ...plan.machines, [producer]: machine } : plan.machines,
      branches: without(plan.branches, (id) => rowItem(id) === item),
      ...(reuse === false && { noReuse: withItem(plan.noReuse, item, true) }),
    }
  const next = {
    ...plan,
    branches: without(plan.branches, (id) => (id === row || id.startsWith(`${row}/`)) && rowItem(id) === item),
  }
  const inherited = resolveChoice(next, catalog, item, row)
  const chosen = catalog.byId.get(producer)
  const onMachine = machine && chosen?.machineOptions.some((m) => m.key === machine) ? machine : chosen?.machine?.key
  const sameReuse = reuse === undefined || reusesByproducts(next, item, row) === reuse
  if (inherited.producer === producer && inherited.process?.machine?.key === onMachine && sameReuse) return next
  return {
    ...next,
    branches: { ...next.branches, [row]: { producer, ...(machine && { machine }), ...(reuse === false && { reuse }) } },
  }
}

/** A list of items with `item` in it or not. */
function withItem(list: string[] | undefined, item: string, on: boolean): string[] | undefined {
  const rest = (list ?? []).filter((k) => k !== item)
  const next = on ? [...rest, item] : rest
  return next.length ? next : undefined
}

/**
 * Takes other rows' by-products of `item` first: everywhere, dropping the item's branch picks, or
 * on a row's branch, picked, so it also takes them from rows that make their own (whatever producer
 * it inherits makes the rest).
 */
function chooseReuse(plan: Plan, item: string, row: string | undefined): Plan {
  if (!row)
    return {
      ...plan,
      noReuse: withItem(plan.noReuse, item, false),
      branches: without(plan.branches, (id) => rowItem(id) === item),
    }
  const next = {
    ...plan,
    branches: without(plan.branches, (id) => (id === row || id.startsWith(`${row}/`)) && rowItem(id) === item),
  }
  return { ...next, branches: { ...next.branches, [row]: { producer: '', reuse: true } } }
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
    if (legacy[use] && item) feedbackItems = withItem(feedbackItems, realItem(item), true)
  }
  return { ...rest, feedbackItems }
}

/** Whether every source of an item feeds the plan's heat or fertilizer (targets can say otherwise). */
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
 * Makes the plan provide its own heat or fertilizer: a target of `item` at 0 net per minute, fed
 * back, at the end of the list, so it covers whatever the sources ahead of it leave. It's an
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
 * Makes an overflow target an ordinary one, making what it makes now (`rate` per minute; when it
 * makes none, a new target's 10 per minute).
 */
export const convertOverflowTarget = (plan: Plan, index: number, rate: number): Plan => ({
  ...plan,
  targets: plan.targets.map((t, i) => {
    if (i !== index || t.unit !== 'overflow') return t
    const { consumes: _, unit: __, ...rest } = t
    return { ...rest, rate: rate > 0 ? Math.round(rate * 1000) / 1000 : 10 }
  }),
})

/**
 * Puts the targets in a new order (`order` lists old indexes; leaving one out removes it). Tree
 * row ids start with their target's place, so per-row picks, catalysts and build-separately rows
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
  const rows = <T>(record: Record<string, T> | undefined) =>
    record &&
    Object.fromEntries(Object.entries(record).flatMap(([id, v]) => (remap(id) === null ? [] : [[remap(id)!, v]])))
  const separate =
    plan.separate &&
    separationsOf(plan.separate).flatMap((s) => {
      if (!s.at) return [s]
      const at = remap(s.at)
      return at === null ? [] : [{ ...s, at }]
    })
  const roundUp = plan.roundUp?.flatMap((id) => remap(id) ?? [])
  return {
    ...plan,
    targets,
    branches: rows(plan.branches),
    rowCatalysts: rows(plan.rowCatalysts),
    separate,
    roundUp: roundUp?.length ? roundUp : undefined,
    units: rows(plan.units),
  }
}

export const moveTarget = (plan: Plan, from: number, to: number) => {
  const order = plan.targets.map((_, i) => i)
  order.splice(to, 0, ...order.splice(from, 1))
  return reorderTargets(plan, order)
}

export const removeTarget = (plan: Plan, index: number) =>
  reorderTargets(
    plan,
    plan.targets.map((_, i) => i).filter((i) => i !== index),
  )

/**
 * "Use as my default": remembers how a row and everything below it is made (recipe, machine and
 * catalysts per item, the topmost row winning when an item appears more than once), following
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
  }
  return { mine, plan: next }
}

/**
 * Un-saving a default from a row of the plan: the rows following it keep being made that way, as
 * the plan's own picks (recipe, machine, catalysts), so only other plans lose it.
 */
export function keepDefaultInPlan(plan: Plan, tree: TreeNode[], item: string, saved: MyDefault): Plan {
  const branches = { ...plan.branches }
  const rowCatalysts = { ...plan.rowCatalysts }
  for (const n of rowsById(tree).values()) {
    if (n.item !== item || !n.mine) continue
    branches[n.id] = { ...branches[n.id], producer: saved.producer, ...(saved.machine && { machine: saved.machine }) }
    if (saved.catalysts?.length && !rowCatalysts[n.id]) rowCatalysts[n.id] = [...saved.catalysts]
  }
  return { ...plan, branches, rowCatalysts }
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
    if (n.kind === 'separate') {
      const group = n.groupId && rows.get(n.groupId)
      if (group) queue.push(group)
      continue
    }
    const p = n.run?.process
    if (n.producer && !setups.has(n.item))
      setups.set(n.item, {
        node: n,
        setup: {
          producer: n.producer,
          ...(p && p.machineOptions.length > 1 && p.machine && { machine: p.machine.key }),
          ...(p?.catalysts.length && { catalysts: [...p.catalysts] }),
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
    !s.catalysts
  )
}

const sameSetup = (catalog: ProcessCatalog, a: MyDefault, b: MyDefault) =>
  a.producer === b.producer &&
  machineOfSetup(catalog, a) === machineOfSetup(catalog, b) &&
  sameSet(a.catalysts ?? [], b.catalysts ?? [])

/** Drops a row's own pick, so it follows the rows above it (or the plan) again. */
export function clearBranchChoice(plan: Plan, row: string): Plan {
  return { ...plan, branches: without(plan.branches, (id) => id === row) }
}

/**
 * Drops producer, machine, catalyst, branch and build-separately choices for items, processes and
 * rows no longer in the plan, so an item that's removed and added back starts from its default
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
  // Fuel and fertilizer picks stay while they still exist (Steam stopped being a fuel).
  const p = keep(plan.producers, (item) =>
    item === HEAT || item === NUTRIENTS ? catalog.byId.has(plan.producers[item]) : items.has(item),
  )
  const m = keep(plan.machines, (id) => processes.has(id))
  // Catalysts stay with a row only while its machines can take them.
  const loadable = new Set(nodes.flatMap((n) => (n.process?.acceptsCatalysts ? [n.id] : [])))
  const c = keep(plan.rowCatalysts, (id) => loadable.has(id))
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
  const units = keep(plan.units, (id) => running.has(id))
  if (!p.dropped && !m.dropped && !c.dropped && !b.dropped && !s && !r && !f && !u && !units.dropped) return null
  return {
    ...plan,
    producers: p.record!,
    machines: m.record!,
    rowCatalysts: c.record,
    branches: b.record,
    separate,
    noReuse: noReuse?.length ? noReuse : undefined,
    feedbackItems: feedbackItems?.length ? feedbackItems : undefined,
    roundUp: roundUp?.length ? roundUp : undefined,
    units: units.record && Object.keys(units.record).length ? units.record : undefined,
  }
}
