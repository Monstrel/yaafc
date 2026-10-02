import { HEAT, NUTRIENTS, buyTier, itemsByKey, realItem } from './gameData'
import { defaultProducer, sameRecipe, type Process, type ProcessCatalog } from './processes'
import { separationsOf } from './separate'
import type { MyDefault, Plan, Separation } from './types'

export const IMPORT = 'import'
const MAX_DEPTH = 40

export type PlanNodeKind =
  | 'make' // machines run `process` for this row
  | 'import' // bought, or brought in from outside the plan
  | 'bus' // fuel/fertilizer taken from the factory bus
  | 'loop' // fed by the row `ref` further up this branch (or cut off, too deep, with no `ref`)
  | 'separate' // built separately, by the row `ref`

/**
 * One row of the production tree, as a place in the factory: its machines feed the row above
 * them, and nothing else. Only by-products leave a branch, to any row of their item.
 */
export interface PlanNode {
  /** Path of item keys from the root, e.g. `0/Sol/WorldTreeCore`; gathered rows end in `with:Item`. */
  id: string
  item: string
  kind: PlanNodeKind
  /** Steps from the root of its tree. */
  depth: number
  parent?: PlanNode
  /** The process the row's machines run (on its machine), for `make` rows. */
  process?: Process
  /** The row has a producer picked for it alone (not inherited from above or the plan). */
  ownChoice: boolean
  /** The row follows one of the player's saved defaults. */
  mine: boolean
  /** Catalysts the row loads unless it sets its own (a saved default's). */
  defaultCatalysts: string[]
  /** Row that supplies a `loop` or `separate` row. */
  ref?: PlanNode
  /** For a `separate` row: the item whose row gathers it (none: the top of the plan). */
  groupAnchor?: string
  /** For a row gathering the uses of an item built separately: the choice behind it. */
  separation?: Separation
  /** Ingredient rows of a `make` row (heat and nutrients aside), then the rows it gathers. */
  children: PlanNode[]
}

export interface PlanShape {
  /** One root per target (targets of an item built separately share one), then separate builds. */
  roots: PlanNode[]
  /** The row meeting each target with an item, in order. */
  targetRows: PlanNode[]
  nodes: PlanNode[]
}

export interface ResolvedChoice {
  /** Process id, or 'import'. */
  producer: string
  process?: Process
  /** Picked for this row itself. */
  own: boolean
  /** One of the player's saved defaults. */
  mine: boolean
  /** Catalysts the row loads unless it sets its own. */
  defaultCatalysts: string[]
}

const picked = (c: ResolvedChoice) => ({ ownChoice: c.own, mine: c.mine, defaultCatalysts: c.defaultCatalysts })

/** The row above a row (null for a root). */
export const parentId = (id: string) => {
  const k = id.lastIndexOf('/')
  return k < 0 ? null : id.slice(0, k)
}

/** The item a row id is for. */
export const rowItem = (id: string) => {
  const step = id.slice(id.lastIndexOf('/') + 1)
  return step.startsWith('with:') ? step.slice(5) : step
}

const makes = (p: Process | undefined, item: string) => !!p && (p.product === item || p.secondary.includes(item))

const knownMachine = (p: Process, machine: string | undefined) =>
  machine && p.machineOptions.some((m) => m.key === machine) ? machine : undefined

/**
 * The player's saved default for an item, while it still makes the item and the plan's research
 * tier can run it (its ingredients included).
 */
export function myDefault(catalog: ProcessCatalog, item: string): MyDefault | undefined {
  const mine = catalog.mine[item]
  if (!mine) return undefined
  if (mine.producer === IMPORT) return itemsByKey.get(item)?.buyPrice == null || buyTier(item) <= catalog.tier ? mine : undefined
  const p = catalog.byId.get(mine.producer)
  if (!makes(p, item)) return undefined
  const run = catalog.variant(p!, { machine: knownMachine(p!, mine.machine), catalysts: mine.catalysts ?? [] })
  return catalog.reach(run) <= catalog.tier ? mine : undefined
}

/**
 * The plan-wide producer of an item: the plan's pick if it still makes the item, else the player's
 * saved default (with its machine and catalysts), else the built-in default.
 */
export function planChoice(plan: Plan, catalog: ProcessCatalog, item: string): MyDefault & { mine: boolean } {
  const choice = plan.producers[item]
  if (choice === IMPORT || (choice && makes(catalog.byId.get(choice), item))) return { producer: choice, mine: false }
  const mine = myDefault(catalog, item)
  if (mine) return { ...mine, mine: true }
  return { producer: defaultProducer(catalog, item), mine: false }
}

export const planProducer = (plan: Plan, catalog: ProcessCatalog, item: string) => planChoice(plan, catalog, item).producer

/**
 * What a row of `item` with id `id` uses: the nearest pick on it or a row of the same item above
 * it, else the plan-wide producer. `inherited` skips the row's own pick (what it would fall back to).
 */
export function resolveChoice(
  plan: Plan,
  catalog: ProcessCatalog,
  item: string,
  id: string,
  inherited = false,
): ResolvedChoice {
  for (let at = inherited ? parentId(id) : id; at !== null; at = parentId(at)) {
    const pick = plan.branches?.[at]
    if (!pick || rowItem(at) !== item) continue
    if (pick.producer === IMPORT) return { producer: IMPORT, own: at === id, mine: false, defaultCatalysts: [] }
    const p = catalog.byId.get(pick.producer)
    if (makes(p, item)) return onRow(p!, pick.machine, at === id)
  }
  const choice = planChoice(plan, catalog, item)
  const p = catalog.byId.get(choice.producer)
  if (!p) return { producer: IMPORT, own: false, mine: choice.mine, defaultCatalysts: [] }
  return onRow(p, choice.machine, false, choice.mine, choice.mine ? (choice.catalysts ?? []) : [])

  /** The process on the picked machine, with the row's own catalysts (else the default's). */
  function onRow(p: Process, machine: string | undefined, own: boolean, mine = false, defaults: string[] = []): ResolvedChoice {
    const catalysts = plan.rowCatalysts?.[id] ?? defaults
    const process = catalog.variant(p, { machine: knownMachine(p, machine), catalysts })
    return { producer: p.id, process, own, mine, defaultCatalysts: defaults }
  }
}

/** Separated uses gathered under one anchor row. */
interface Group {
  sep: Separation
  /** The gathering row; null when it wouldn't be made by machines; undefined until first used. */
  node?: PlanNode | null
  expanded: boolean
}

interface Frame {
  node: PlanNode
  groups: Map<string, Group>
}

/**
 * Lays out the plan's rows from its targets, choices and build-separately picks (rates come later,
 * from the solver). Each row's ingredients become rows below it; a row whose item and process
 * already run further up its branch loops back to that row instead; an item built separately gets
 * a row gathering its uses (at the top of the plan, or after the children of its anchor rows) and
 * a `separate` row pointing there wherever it's used.
 */
export function unfold(plan: Plan, catalog: ProcessCatalog): PlanShape {
  const seps = separationsOf(plan.separate)
  const top = new Map(seps.filter((s) => !s.anchor).map((s) => [s.item, s]))
  // Single-row anchors first, so they win over every-row ones for the same item.
  const anchored = seps.filter((s) => s.anchor && s.anchor !== s.item).sort((a, b) => Number(!a.at) - Number(!b.at))

  const nodes: PlanNode[] = []
  const frames: Frame[] = []
  /** Row gathering every use of a top-of-plan item (null: not made by machines). */
  const topRows = new Map<string, PlanNode | null>()
  const pending: PlanNode[] = []

  const create = (item: string, id: string, depth: number, parent: PlanNode | undefined, fields: Partial<PlanNode>) => {
    const n: PlanNode = { id, item, kind: 'import', depth, parent, ownChoice: false, mine: false, defaultCatalysts: [], children: [], ...fields }
    nodes.push(n)
    return n
  }

  /** A row gathering the uses of a separated item, or null when machines wouldn't make it there. */
  const groupRow = (item: string, id: string, depth: number, parent: PlanNode | undefined, separation: Separation) => {
    const choice = resolveChoice(plan, catalog, item, id)
    if (!choice.process) return null
    return create(item, id, depth, parent, { kind: 'make', process: choice.process, ...picked(choice), separation })
  }

  /** Where a separated use goes: the innermost anchor gathering it, else the top of the plan. */
  const gather = (item: string): { ref: PlanNode; anchor?: string } | null => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i]
      const group = frame.groups.get(item)
      if (!group) continue
      if (group.node === undefined)
        group.node = groupRow(item, `${frame.node.id}/with:${item}`, frame.node.depth + 1, frame.node, group.sep)
      if (group.node) return { ref: group.node, anchor: frame.node.item }
    }
    const sep = top.get(item)
    if (!sep) return null
    if (!topRows.has(item)) {
      const n = groupRow(item, `separate/${item}`, 0, undefined, sep)
      topRows.set(item, n)
      if (n) pending.push(n)
    }
    const row = topRows.get(item)
    return row ? { ref: row } : null
  }

  const child = (item: string, parent: PlanNode): PlanNode => {
    const id = `${parent.id}/${item}`
    const depth = parent.depth + 1
    if (realItem(item) !== item) return create(realItem(item), id, depth, parent, { kind: 'bus' })
    const choice = resolveChoice(plan, catalog, item, id)
    if (!choice.process) return create(item, id, depth, parent, { ...picked(choice) })
    for (let a: PlanNode | undefined = parent; a; a = a.parent)
      if (a.item === item && a.kind === 'make' && sameRecipe(a.process!, choice.process))
        return create(item, id, depth, parent, { kind: 'loop', ref: a, ...picked(choice) })
    if (depth >= MAX_DEPTH) return create(item, id, depth, parent, { kind: 'loop', ...picked(choice) })
    const gathered = gather(item)
    if (gathered)
      return create(item, id, depth, parent, { kind: 'separate', ref: gathered.ref, groupAnchor: gathered.anchor, ...picked(choice) })
    const n = create(item, id, depth, parent, { kind: 'make', process: choice.process, ...picked(choice) })
    expand(n)
    return n
  }

  const expand = (n: PlanNode) => {
    const groups = new Map<string, Group>()
    for (const s of anchored)
      if (s.anchor === n.item && (!s.at || s.at === n.id) && !groups.has(s.item)) groups.set(s.item, { sep: s, expanded: false })
    const frame = groups.size ? { node: n, groups } : null
    if (frame) frames.push(frame)
    for (const s of n.process!.inputs) if (s.item !== HEAT && s.item !== NUTRIENTS) n.children.push(child(s.item, n))
    if (!frame) return
    // A gathered row's own ingredients can be gathered here too, adding rows as they go.
    for (;;) {
      const todo = [...groups.values()].filter((g) => g.node && !g.expanded)
      if (!todo.length) break
      for (const g of todo) {
        g.expanded = true
        expand(g.node!)
      }
    }
    frames.pop()
    for (const g of groups.values()) if (g.node) n.children.push(g.node)
  }

  const roots: PlanNode[] = []
  const targetRows: PlanNode[] = []
  plan.targets
    .filter((t) => t.item)
    .forEach((t, i) => {
      const sep = top.get(t.item)
      const shared = sep && topRows.get(t.item)
      if (shared) {
        targetRows.push(shared)
        return
      }
      const id = `${i}/${t.item}`
      const choice = resolveChoice(plan, catalog, t.item, id)
      const n = choice.process
        ? create(t.item, id, 0, undefined, {
            kind: 'make',
            process: choice.process,
            ...picked(choice),
            ...(sep && { separation: sep }),
          })
        : create(t.item, id, 0, undefined, { ...picked(choice) })
      if (sep) topRows.set(t.item, n.kind === 'make' ? n : null)
      roots.push(n)
      targetRows.push(n)
    })
  for (const n of [...roots]) if (n.kind === 'make') expand(n)
  // Expanding a separate build can turn up more of them; `pending` grows as we go.
  for (let i = 0; i < pending.length; i++) {
    expand(pending[i])
    roots.push(pending[i])
  }
  return { roots, targetRows, nodes }
}
