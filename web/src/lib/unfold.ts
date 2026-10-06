import { HEAT, MONEY, NUTRIENTS, STEAM } from './gameData'
import { COIN_STACK } from './machineRate'
import { DEFAULT_BANK_STACK, STEAM_HEAT_ID, buyId, defaultProducer, sameRecipe, type Process, type ProcessCatalog } from './processes'
import { separationsOf } from './separate'
import type { MyDefault, Plan, PlanTarget, Separation } from './types'

/** Bought, in plans saved before buying was the Purchasing Portal's recipe: read as that recipe. */
export const IMPORT = 'import'
/** Taken from the factory bus: made somewhere outside the plan. */
export const BUS = 'bus'
const MAX_DEPTH = 40

export type PlanNodeKind =
  | 'make' // machines run `process` for this row
  | 'bus' // taken from the factory bus
  | 'loop' // fed by the row `ref` further up this branch (or cut off, too deep, with no `ref`)
  | 'separate' // built separately, by the row `ref`
  | 'overflow' // the plan's overflow of the item, taken by an overflow target's rows

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
  /** Height the row's machines are built at unless it sets its own (a saved default's, else 0). */
  defaultHeight: number
  /** Coins its Bank Portals output per entry unless it sets its own (a saved default's, else 50). */
  defaultStack: number
  /** The row takes other rows' by-products of its item first (else it makes all of it). */
  reuse: boolean
  /**
   * Reuse was picked for the row (or a row of its item above it): it also takes by-products from
   * rows that make their own, which share them with no one else.
   */
  reuseChosen: boolean
  /** Row that supplies a `loop` or `separate` row. */
  ref?: PlanNode
  /** For a `separate` row: the item whose row gathers it (none: the top of the plan). */
  groupAnchor?: string
  /** For a row gathering the uses of an item built separately: the choice behind it. */
  separation?: Separation
  /** Rows of a `make` row's ingredients (heat and nutrients too), then the rows it gathers. */
  children: PlanNode[]
}

export interface PlanShape {
  /** One root per target (targets of an item built separately share one), then separate builds. */
  roots: PlanNode[]
  /** The row meeting each target with an item, in order. */
  targetRows: PlanNode[]
  nodes: PlanNode[]
}

/** The item an overflow target takes the overflow of, or null for any other target. */
export const consumedBy = (t: PlanTarget) => (t.unit === 'overflow' && t.consumes ? t.consumes : null)

/** The item a supply target takes what's left of the bus's supply of, or null for any other target. */
export const suppliedBy = (t: PlanTarget) => (t.unit === 'supply' && t.consumes ? t.consumes : null)

export interface ResolvedChoice {
  /** Process id, 'import' or 'bus'. */
  producer: string
  process?: Process
  /** Picked for this row itself. */
  own: boolean
  /** One of the player's saved defaults. */
  mine: boolean
  /** Catalysts the row loads unless it sets its own. */
  defaultCatalysts: string[]
  /** Height the row's machines are built at unless it sets its own. */
  defaultHeight: number
  /** Coins its Bank Portals output per entry unless it sets its own. */
  defaultStack: number
}

const picked = (c: ResolvedChoice) => ({
  ownChoice: c.own,
  mine: c.mine,
  defaultCatalysts: c.defaultCatalysts,
  defaultHeight: c.defaultHeight,
  defaultStack: c.defaultStack,
})

/** The row above a row (null for a root). */
export const parentId = (id: string) => {
  const k = id.lastIndexOf('/')
  return k < 0 ? null : id.slice(0, k)
}

/**
 * Whether a row of `item` takes other rows' by-products of it first: the nearest branch pick of the
 * item that says (on the row or above it), else the plan-wide setting. Reusing is the default.
 */
export function reusesByproducts(plan: Plan, item: string, id: string): boolean {
  return reuseChosen(plan, item, id) ?? !plan.noReuse?.includes(item)
}

/** The reuse setting of the nearest branch pick of `item` that has one, on the row or above it. */
export function reuseChosen(plan: Plan, item: string, id: string): boolean | undefined {
  for (let at: string | null = id; at !== null; at = parentId(at)) {
    const pick = plan.branches?.[at]
    if (pick?.reuse !== undefined && rowItem(at) === item) return pick.reuse
  }
  return undefined
}

/** Whether a row id is a target's own row (`0/Sol`), not an ingredient or a separate build. */
export const isTargetRow = (id: string) => /^\d+\/[^/]+$/.test(id)

/** The item a row id is for. */
export const rowItem = (id: string) => {
  const step = id.slice(id.lastIndexOf('/') + 1)
  return step.startsWith('with:') ? step.slice(5) : step
}

const makes = (p: Process | undefined, item: string) =>
  !!p && (p.product === item || p.secondary.includes(item) || p.outputs.some((o) => o.item === item))

/** Heat, nutrients and money aren't items: they can't be taken from the bus, only made by burning, spreading or paying one. */
const isPseudo = (item: string) => item.startsWith('@')

/**
 * A producer pick as it reads now: plans saved before buying was a recipe picked 'import', which is
 * the Purchasing Portal's recipe where portals sell the item, else the bus.
 */
const current = (catalog: ProcessCatalog, item: string, producer: string) =>
  producer !== IMPORT ? producer : catalog.byId.has(buyId(item)) ? buyId(item) : BUS

/**
 * Whether a row is a fuel burned for its parent's heat or a fertilizer spread for its nurseries:
 * those come off the bus unless their branch picks otherwise (plan-wide picks are for making the
 * item as an ingredient, and older plans have many), and so do the coins a row pays with. Steam
 * too: the plan makes it with boilers only when asked (a net-surplus target of it, or a branch
 * pick).
 */
const isBurned = (id: string) => {
  const above = parentId(id)
  return above !== null && [HEAT, NUTRIENTS, MONEY].includes(rowItem(above))
}

/**
 * What the plan's boilers burn when it heats with Steam by default (a producer pick, kept with the
 * plan's other defaults): a solid fuel.
 */
export const BOILER_HEAT = '@heat:boilers'

/** A boiler's own heat can't come from Steam: it would only turn Steam into Steam, slower. */
const underBoiler = (item: string, id: string) => {
  const above = parentId(id)
  return item === HEAT && above !== null && rowItem(above) === STEAM
}

/** What a row loads, how high it's built and the coins it outputs per entry when it follows no saved default. */
const NO_SETUP = { defaultCatalysts: [] as string[], defaultHeight: 0, defaultStack: DEFAULT_BANK_STACK }

const knownMachine = (p: Process, machine: string | undefined) =>
  machine && p.machineOptions.some((m) => m.key === machine) ? machine : undefined

/**
 * The player's saved default for an item, while it still makes the item and the plan's research
 * tier can run it (its ingredients included).
 */
export function myDefault(catalog: ProcessCatalog, item: string): MyDefault | undefined {
  const saved = catalog.mine[item]
  if (!saved) return undefined
  const mine = { ...saved, producer: current(catalog, item, saved.producer) }
  if (mine.producer === BUS) return isPseudo(item) ? undefined : mine
  const p = catalog.byId.get(mine.producer)
  if (!makes(p, item)) return undefined
  const run = catalog.variant(p!, {
    machine: knownMachine(p!, mine.machine),
    catalysts: mine.catalysts ?? [],
    height: mine.height ?? 0,
    stack: mine.stack,
  })
  return catalog.reach(run) <= catalog.tier ? mine : undefined
}

/**
 * The plan-wide producer of an item: the plan's pick if it still makes the item, else the player's
 * saved default (with its machine, catalysts, height and coin stack), else the built-in default (for a target's row when
 * `asTarget`: coins are minted there, and taken in everywhere else).
 */
export function planChoice(plan: Plan, catalog: ProcessCatalog, item: string, asTarget = false): MyDefault & { mine: boolean } {
  const choice = plan.producers[item] && current(catalog, item, plan.producers[item])
  if ((choice === BUS && !isPseudo(item)) || (choice && makes(catalog.byId.get(choice), item)))
    return { producer: choice, mine: false }
  const mine = myDefault(catalog, item)
  if (mine) return { ...mine, mine: true }
  return { producer: defaultProducer(catalog, item, asTarget), mine: false }
}

export const planProducer = (plan: Plan, catalog: ProcessCatalog, item: string) => planChoice(plan, catalog, item).producer

/**
 * What a row of `item` with id `id` uses: the nearest pick on it or a row of the same item above
 * it, else the plan-wide producer. A fuel or fertilizer row comes off the bus unless its branch
 * picks otherwise, and a boiler's heat never comes from Steam (when the plan heats with Steam, its
 * boilers burn the plan's pick for them, else the best solid fuel). `inherited` skips the row's own pick
 * (what it would fall back to).
 */
export function resolveChoice(
  plan: Plan,
  catalog: ProcessCatalog,
  item: string,
  id: string,
  inherited = false,
): ResolvedChoice {
  const allowed = (producer: string) => !(underBoiler(item, id) && producer === STEAM_HEAT_ID)
  for (let at = inherited ? parentId(id) : id; at !== null; at = parentId(at)) {
    const pick = plan.branches?.[at]
    if (!pick || rowItem(at) !== item || !allowed(pick.producer)) continue
    const producer = current(catalog, item, pick.producer)
    if (producer === BUS) {
      if (isPseudo(item)) continue
      return { producer: BUS, own: at === id, mine: false, ...NO_SETUP }
    }
    const p = catalog.byId.get(producer)
    if (makes(p, item)) return onRow(p!, pick.machine, at === id)
  }
  if (isBurned(id)) return { producer: BUS, own: false, mine: false, ...NO_SETUP }
  let choice = planChoice(plan, catalog, item, isTargetRow(id))
  if (!allowed(choice.producer)) {
    const boilers = plan.producers[BOILER_HEAT]
    const burns = boilers && catalog.byId.has(boilers) && allowed(boilers) ? boilers : defaultProducer(catalog, item)
    choice = { producer: burns, mine: false }
  }
  const p = catalog.byId.get(choice.producer)
  if (!p) return { producer: BUS, own: false, mine: choice.mine, ...NO_SETUP }
  const defaults = choice.mine
    ? {
        defaultCatalysts: choice.catalysts ?? [],
        defaultHeight: choice.height ?? 0,
        defaultStack: choice.stack ?? DEFAULT_BANK_STACK,
      }
    : NO_SETUP
  return onRow(p, choice.machine, false, choice.mine, defaults)

  /**
   * The process on the picked machine, with the row's own catalysts, height and stack (else the
   * default's); for a Nursery the fertilizer its row spreads, which sets its speed, and for a
   * Purchasing Portal the coin its row pays with, which sets its pace.
   */
  function onRow(p: Process, machine: string | undefined, own: boolean, mine = false, defaults = NO_SETUP): ResolvedChoice {
    const catalysts = plan.rowCatalysts?.[id] ?? defaults.defaultCatalysts
    const height = plan.rowHeights?.[id] ?? defaults.defaultHeight
    const stack = plan.rowStacks?.[id] ?? defaults.defaultStack
    const fertilizer = p.seed ? resolveChoice(plan, catalog, NUTRIENTS, `${id}/${NUTRIENTS}`).process?.inputs[0]?.item : undefined
    const coin = p.kind === 'buy' ? resolveChoice(plan, catalog, MONEY, `${id}/${MONEY}`).process?.inputs[0]?.item : undefined
    const process = catalog.variant(p, { machine: knownMachine(p, machine), catalysts, height, stack, fertilizer, coin })
    return { producer: p.id, process, own, mine, ...defaults }
  }
}

/**
 * Coins per belt entry a row's ingredients arrive in, where a Bank Portal row below it (or the
 * separate build or loop it points to) outputs smaller stacks than 50; null when none does.
 */
function fedStacks(ingredients: PlanNode[]): Record<string, number> | null {
  const stacks: Record<string, number> = {}
  for (const c of ingredients) {
    const source = c.kind === 'make' ? c : c.kind === 'separate' || c.kind === 'loop' ? c.ref : undefined
    const stack = source?.process?.stack
    if (stack !== undefined && stack < COIN_STACK && source!.process!.product === c.item) stacks[c.item] = stack
  }
  return Object.keys(stacks).length ? stacks : null
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
  /** The item whose overflow the target being laid out takes, when it's an overflow target. */
  let linked: string | null = null
  /** The item the target being laid out takes from the bus's supply, when it's a supply target. */
  let linkedBus: string | null = null

  const create = (item: string, id: string, depth: number, parent: PlanNode | undefined, fields: Partial<PlanNode>) => {
    const n: PlanNode = {
      id,
      item,
      kind: 'bus',
      depth,
      parent,
      ownChoice: false,
      mine: false,
      ...NO_SETUP,
      reuse: reusesByproducts(plan, item, id),
      reuseChosen: reuseChosen(plan, item, id) === true,
      children: [],
      ...fields,
    }
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

  /** A row taken from the bus. */
  const leaf = (item: string, id: string, depth: number, parent: PlanNode | undefined, choice: ResolvedChoice) =>
    create(item, id, depth, parent, { kind: 'bus', ...picked(choice) })

  const child = (item: string, parent: PlanNode): PlanNode => {
    const id = `${parent.id}/${item}`
    const depth = parent.depth + 1
    if (item === linked) return create(item, id, depth, parent, { kind: 'overflow', reuse: false, reuseChosen: false })
    if (item === linkedBus) return create(item, id, depth, parent, { kind: 'bus', reuse: false, reuseChosen: false })
    const choice = resolveChoice(plan, catalog, item, id)
    if (!choice.process) return leaf(item, id, depth, parent, choice)
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
    for (const s of n.process!.inputs) n.children.push(child(s.item, n))
    const fed = fedStacks(n.children)
    if (fed) n.process = catalog.variant(n.process!, { inputStacks: fed })
    // A Purchasing Portal paid with coins a Bank Portal row below outputs in smaller stacks runs slower.
    if (n.process!.kind === 'buy') {
      const paid = n.children.find((c) => c.item === MONEY)?.children ?? []
      const stack = fedStacks(paid)?.[n.process!.coin!]
      if (stack) n.process = catalog.variant(n.process!, { coinStack: stack })
    }
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
  const consumes = new Map<PlanNode, string>()
  const supplied = new Map<PlanNode, string>()
  plan.targets
    .filter((t) => t.item)
    .forEach((t, i) => {
      const from = consumedBy(t)
      const fromBus = suppliedBy(t)
      // An overflow or supply target makes only what its overflow or supply comes to, so it never
      // gathers other uses of its item: those go to a row of their own.
      const sep = from || fromBus ? undefined : top.get(t.item)
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
        : leaf(t.item, id, 0, undefined, choice)
      if (sep) topRows.set(t.item, n.kind === 'make' ? n : null)
      if (from) consumes.set(n, from)
      if (fromBus) supplied.set(n, fromBus)
      roots.push(n)
      targetRows.push(n)
    })
  for (const n of [...roots]) {
    linked = consumes.get(n) ?? null
    linkedBus = supplied.get(n) ?? null
    if (n.kind === 'make') expand(n)
  }
  linked = null
  linkedBus = null
  // Expanding a separate build can turn up more of them; `pending` grows as we go.
  for (let i = 0; i < pending.length; i++) {
    expand(pending[i])
    roots.push(pending[i])
  }
  return { roots, targetRows, nodes }
}
