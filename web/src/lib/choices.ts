import { HEAT, NUTRIENTS } from './gameData'
import { defaultMachine, defaultProducer, type ProcessCatalog } from './processes'
import { separationKey, separationsOf } from './separate'
import type { TreeNode } from './tree'
import type { MyDefault, MyDefaults, Plan } from './types'
import { resolveChoice, rowItem, unfold } from './unfold'

export interface ProducerPick {
  item: string
  /** Process id, or 'import'. */
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
 * Applies a producer pick. On a row it covers that row's branch: the row and every row of its
 * item below it, replacing picks made further down. A pick matching what the row would inherit
 * anyway isn't stored. Everywhere, it becomes the plan-wide producer and clears the item's
 * branch picks.
 */
export function chooseProducer(plan: Plan, catalog: ProcessCatalog, pick: ProducerPick): Plan {
  const { item, producer, machine, row } = pick
  if (!row || pick.everywhere)
    return {
      ...plan,
      producers: { ...plan.producers, [item]: producer },
      machines: machine ? { ...plan.machines, [producer]: machine } : plan.machines,
      branches: without(plan.branches, (id) => rowItem(id) === item),
    }
  const next = {
    ...plan,
    branches: without(plan.branches, (id) => (id === row || id.startsWith(`${row}/`)) && rowItem(id) === item),
  }
  const inherited = resolveChoice(next, catalog, item, row)
  const chosen = catalog.byId.get(producer)
  const onMachine = machine && chosen?.machineOptions.some((m) => m.key === machine) ? machine : chosen?.machine?.key
  if (inherited.producer === producer && inherited.process?.machine?.key === onMachine) return next
  return { ...next, branches: { ...next.branches, [row]: { producer, ...(machine && { machine }) } } }
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
  const rows = new Map<string, TreeNode>()
  const index = (n: TreeNode) => {
    rows.set(n.id, n)
    n.children.forEach(index)
  }
  tree.forEach(index)

  // Breadth first, so the row nearest the top sets each item.
  const setups = new Map<string, MyDefault>()
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
        producer: n.producer,
        ...(p && p.machineOptions.length > 1 && p.machine && { machine: p.machine.key }),
        ...(p?.catalysts.length && { catalysts: [...p.catalysts] }),
      })
    queue.push(...n.children)
  }

  const machineOf = (s: MyDefault) => {
    const p = catalog.byId.get(s.producer)
    return p && (s.machine ?? defaultMachine(p, catalog.tier))
  }
  const builtIn = (item: string, s: MyDefault) => {
    const p = catalog.byId.get(s.producer)
    return s.producer === defaultProducer(catalog, item) && (!p || machineOf(s) === defaultMachine(p, catalog.tier)) && !s.catalysts
  }
  const mine = { ...catalog.mine }
  for (const [item, s] of setups) {
    if (builtIn(item, s)) delete mine[item]
    else mine[item] = s
  }

  const matches = (item: string, pick: { producer: string; machine?: string }) => {
    const s = setups.get(item)
    return !!s && s.producer === pick.producer && machineOf(s) === machineOf(pick)
  }
  const underRow = (id: string) => covered.has(id)
  const next: Plan = {
    ...plan,
    producers: Object.fromEntries(Object.entries(plan.producers).filter(([item, producer]) => !matches(item, { producer }))),
    branches: without(plan.branches, (id) => underRow(id) && matches(rowItem(id), plan.branches![id])),
    rowCatalysts: without(plan.rowCatalysts, (id) => underRow(id) && sameSet(plan.rowCatalysts![id], setups.get(rowItem(id))?.catalysts ?? [])),
  }
  return { mine, plan: next }
}

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
  const p = keep(plan.producers, (item) => item === HEAT || item === NUTRIENTS || items.has(item))
  const m = keep(plan.machines, (id) => processes.has(id))
  // Catalysts stay with a row only while its machines can take them.
  const loadable = new Set(nodes.flatMap((n) => (n.process?.acceptsCatalysts ? [n.id] : [])))
  const c = keep(plan.rowCatalysts, (id) => loadable.has(id))
  const b = keep(plan.branches, (id) => rows.has(id))
  const separate = plan.separate && separationsOf(plan.separate).filter((s) => gathering.has(separationKey(s)))
  const s = separate?.length !== plan.separate?.length
  if (!p.dropped && !m.dropped && !c.dropped && !b.dropped && !s) return null
  return { ...plan, producers: p.record!, machines: m.record!, rowCatalysts: c.record, branches: b.record, separate }
}
