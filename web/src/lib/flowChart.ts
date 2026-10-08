import { fmt } from './format'
import { HEAT, MONEY, NUTRIENTS } from './gameData'
import { STEAM_HEAT_ID } from './processes'
import type { TreeNode } from './tree'
import { parentId } from './unfold'

/**
 * A flow chart of one branch of the production tree: its rows as boxes in columns by depth (inputs
 * on the left, the branch's own row on the right), with the feeds that cross branches (by-products,
 * loops back up the tree, items built separately) drawn as lines of their own.
 */

/**
 * What a box stands for: a row's machines, an item taken from the bus, or something coming from
 * outside the chart (a loop or by-product from rows not in it, an item built elsewhere, overflow).
 */
export type FlowBoxKind = 'machines' | 'bus' | 'outside'

/**
 * What a heated row's machines sit on, drawn under its box: furnaces burning a solid fuel, or Steam
 * Heating Pads taking Steam. Fuel off the bus shows only here; fuel made in the plan feeds it.
 */
export interface FlowHeat {
  /** The fuel, and how much of it they burn per minute (none if the Heat row has no fuel row). */
  item?: string
  rate: number
  /** Heat used, P/s. */
  heat: number
  pads: boolean
}

export interface FlowBox {
  /** The tree row it shows (a made-up id for bus and outside boxes). */
  id: string
  /** The tree row a click shows, if any. */
  row?: string
  kind: FlowBoxKind
  item: string
  /** Items per minute it supplies to the box it feeds. */
  rate: number
  /** The row it's drawn from ('machines' boxes). */
  node?: TreeNode
  /** For an 'outside' box: where it comes from, and the tree row making it, if it's a row. */
  note?: string
  source?: string
  /** Levels below the chart's own row. */
  depth: number
  /** Rows below it left out by the level limit. */
  more: number
  /** An item built separately, gathering its uses: it feeds each of them. */
  group?: boolean
  /** For a separate build: what it sends to uses outside the chart, per minute, and how many. */
  elsewhere?: { rate: number; uses: number }
  /** The loop it takes part in (index into `FlowChart.loops`), if any. */
  loop?: number
  /** The furnaces or heating pads its machines sit on ('machines' boxes using heat). */
  heat?: FlowHeat
  children: FlowBox[]
  /** Layout: left edge, center line, size. */
  x: number
  y: number
  w: number
  h: number
}

/**
 * 'feed': to the row above in the tree. 'byproduct': a side output taken by a row of another
 * branch. 'loop': back up the tree to a row using what it makes further up. 'separate': from where
 * an item is built separately.
 */
export type FlowEdgeKind = 'feed' | 'byproduct' | 'loop' | 'separate'

/**
 * Which of its machine's outputs a line's item leaves by, as the game colours them: 'main' the
 * product (the gold output arrow), 'side' anything else, as an Athanor's failed products (the blue
 * ones); 'none' for what doesn't come off a machine (the bus).
 */
export type FlowPort = 'main' | 'side' | 'none'

interface Link {
  id: string
  from: string
  to: string
  item: string
  rate: number
  kind: FlowEdgeKind
  port?: FlowPort
  /** Fuel: it goes into the furnaces or heating pads under the box, not its machines. */
  fuel?: boolean
}

export interface FlowEdge extends Link {
  /** SVG path. */
  path: string
  /** Where its label sits (lines across branches only). */
  label?: { x: number; y: number }
}

/** Boxes feeding each other round in a cycle, with what goes into it and comes out. */
export interface FlowLoop {
  boxes: string[]
  /** Per item, per minute: what the boxes take from outside the loop. */
  inputs: { item: string; rate: number }[]
  /** Per item, per minute: what they pass on out of it, or overflow. */
  outputs: { item: string; rate: number }[]
}

export interface FlowChart {
  root: FlowBox
  boxes: Map<string, FlowBox>
  edges: FlowEdge[]
  loops: FlowLoop[]
  /** Levels below the root in the whole branch (the most the level limit can show). */
  depth: number
  width: number
  height: number
  /** Top of the drawing: lanes for lines going back up the tree sit above the boxes, at negative y. */
  top: number
}

export const BOX_W = 210
export const BOX_H = 74
export const SMALL_H = 50
/** Height of the furnaces or heating pads drawn under a heated box. */
export const HEAT_H = 30
const V_GAP = 14
const MIN_GAP = 72
const LANE_STEP = 18
const LANE_X_STEP = 10
const CORNER = 8
const EPS = 1e-9
/** Clear space either side of a line's label, so its arrowhead and the boxes stay in view. */
const LABEL_MARGIN = 22
/** Space between lines leaving or entering the same side of a box. */
const PORT_STEP = 14
/** A line's label's height, with a little room. */
const LABEL_H = 22

/** About how wide a line's label is drawn ("♻ [icon] 14.1/min" in 11px type), in pixels. */
export const labelWidth = (rate: number) => 46 + `${fmt(rate)}/min`.length * 6.5

/** Heat, Nutrients and Money rows that are just what the row above burns, spreads or pays with. */
const isTransparent = (n: TreeNode) =>
  (n.item === HEAT || n.item === NUTRIENTS || n.item === MONEY) && !n.run?.process.machine

/** Fuel rows taken whole off the bus: the furnaces or pads they go into say so, they get no box. */
const fromBusOnly = (n: TreeNode) => n.kind === 'bus'

/** Which output of a row's machines `item` leaves by. */
const portOf = (n: TreeNode | undefined, item: string): FlowPort =>
  !n?.run || n.kind === 'bus' ? 'none' : n.run.process.product === item ? 'main' : 'side'

/** What a row's own machines make of its item, per minute (what's recovered into it comes beside it). */
const made = (n: TreeNode) => Math.max(0, n.rate - n.fromByproduct - n.fromBus - n.shortfall - n.fromRecovery)

/**
 * The chart of the branch under `rootId`, showing `levels` levels below it (all of them when
 * absent). `tree` is the whole solved tree, so feeds from rows outside the chart can be named.
 */
export function buildFlowChart(tree: TreeNode[], rootId: string, levels?: number): FlowChart | null {
  const rows = new Map<string, TreeNode>()
  const index = (n: TreeNode) => {
    rows.set(n.id, n)
    n.children.forEach(index)
  }
  tree.forEach(index)
  const start = rows.get(rootId)
  if (!start) return null

  const boxes = new Map<string, FlowBox>()
  const links: Link[] = []
  /** Per tree row in the chart: the box its item goes into. */
  const consumerOf = new Map<string, string>()
  /** Loops and separate builds, joined up once every box is made. */
  // `hidden`: a row below the level limit, whose feed only shows as a line from a box in the chart.
  const pending: { from?: string; row: TreeNode; depth: number; kind: FlowEdgeKind; note: string; hidden?: boolean }[] =
    []
  /** Rows partly or wholly covered by other rows' by-products. */
  const takers: { row: TreeNode; depth: number; hidden?: boolean }[] = []
  let outside = 0
  const limit = levels ?? Infinity

  /** Heat a box takes from furnaces fed further up the tree: lines from their fuel, once every box is made. */
  const heatLoops: { from: string; to: string; item: string; rate: number }[] = []
  /** What a row's machines sit on: its Heat row's fuel, or the fuel of the furnaces it shares further up. */
  const heatOf = (id: string, n: TreeNode): FlowHeat | undefined => {
    const h = n.children.find((c) => c.item === HEAT && isTransparent(c))
    if (!h) return undefined
    const up = h.kind === 'loop' ? loopSource(h) : undefined
    const source = up ? rows.get(up)! : h
    const fuel = source.children.find((c) => !c.recovery)
    // Of what the furnaces up the tree burn, the part for these machines' heat.
    const rate = !fuel ? 0 : up ? (fuel.rate * h.rate) / (source.rate || 1) : fuel.rate
    // Fuel built separately comes from where it's gathered.
    const from = fuel?.kind === 'separate' && fuel.groupId ? fuel.groupId : fuel?.id
    if (up && fuel && from && !fromBusOnly(fuel)) heatLoops.push({ from, to: id, item: fuel.item, rate })
    return { item: fuel?.item, rate, heat: n.heat, pads: source.producer === STEAM_HEAT_ID }
  }

  const box = (b: Omit<FlowBox, 'x' | 'y' | 'w' | 'h' | 'children' | 'more' | 'heat'>): FlowBox => {
    const heat = b.kind === 'machines' && b.node ? heatOf(b.id, b.node) : undefined
    const made: FlowBox = {
      ...b,
      heat,
      more: 0,
      children: [],
      x: 0,
      y: 0,
      w: BOX_W,
      h: b.kind === 'machines' ? BOX_H + (heat ? HEAT_H : 0) : SMALL_H,
    }
    boxes.set(made.id, made)
    return made
  }
  /** Tree rows whose item is fuel for the furnaces or pads under the box they feed. */
  const fuelRows = new Set<string>()
  /** Adds `b` as a feed of the box `to`. */
  const attach = (to: string, b: FlowBox, fuel = false) => {
    boxes.get(to)!.children.push(b)
    links.push({ id: `${b.id}>${to}`, from: b.id, to, item: b.item, rate: b.rate, kind: 'feed', fuel })
  }
  /** A line from a box making `row`'s item, into the furnaces or pads under `to` when it's fuel. */
  const link = (l: Omit<Link, 'fuel'>, row: string) => links.push({ ...l, fuel: fuelRows.has(row) })
  /** The fuel rows under a Heat row that get boxes: all but those taken whole off the bus. */
  const fuelFeeds = (h: TreeNode) =>
    h.children.filter((f) => {
      if (fromBusOnly(f)) return false
      fuelRows.add(f.id)
      return true
    })
  /** A box for what comes from outside the chart; `source` is the row making it, shown on a click. */
  const outsideBox = (item: string, rate: number, note: string, depth: number, source?: string) =>
    box({ id: `outside:${outside++}`, kind: 'outside', item, rate, note, depth, row: source, source })

  /**
   * Rows of a branch that get a box (Heat, Nutrients and Money rows don't, their rows do, but for
   * fuel off the bus).
   */
  const countRows = (n: TreeNode): number =>
    n.children.reduce((t, c) => {
      if (c.consolidated || (n.item === HEAT && fromBusOnly(c))) return t
      return t + (isTransparent(c) ? countRows(c) : 1 + countRows(c))
    }, 0)
  /** Levels below a row, following its uses of items built separately into where they're built. */
  const followed = new Set([start.id])
  const deepest = (n: TreeNode, d: number): number =>
    n.children.reduce((m, c) => {
      if (c.consolidated || (n.item === HEAT && fromBusOnly(c))) return m
      // A recovery row sits beside the row it recovers into.
      if (isTransparent(c) || c.recovery) return Math.max(m, deepest(c, d))
      const group = c.kind === 'separate' && c.groupId ? rows.get(c.groupId) : undefined
      if (group && !followed.has(group.id)) {
        followed.add(group.id)
        return Math.max(m, deepest(group, d + 1))
      }
      return Math.max(m, deepest(c, d + 1))
    }, d)
  /** Uses of each item built separately, anywhere in the plan. */
  const usesOf = new Map<string, number>()
  for (const n of rows.values())
    if (n.kind === 'separate' && n.groupId) usesOf.set(n.groupId, (usesOf.get(n.groupId) ?? 0) + 1)

  /** Adds the boxes of the rows under `n`, feeding `parent`. */
  const addChildren = (n: TreeNode, parent: FlowBox, depth: number) => {
    for (const c of n.children) {
      // Items built separately here feed their uses, not this row: they come in with the first of
      // them. Rows recovering into this one's supply join its output: they come in beside it.
      if (c.consolidated || c.recovery) continue
      if (c.item === HEAT && isTransparent(c)) {
        for (const f of fuelFeeds(c)) {
          consumerOf.set(f.id, parent.id)
          addRow(f, parent, depth)
        }
        continue
      }
      if (isTransparent(c)) {
        addChildren(c, parent, depth)
        continue
      }
      consumerOf.set(c.id, parent.id)
      addRow(c, parent, depth)
    }
  }

  /** The boxes a row puts in the chart: its machines, the part from the bus, what comes from elsewhere. */
  const addRow = (c: TreeNode, parent: FlowBox, depth: number) => {
    const fuel = fuelRows.has(c.id)
    switch (c.kind) {
      case 'produce': {
        const b = box({ id: c.id, row: c.id, kind: 'machines', item: c.item, rate: made(c), node: c, depth })
        attach(parent.id, b, fuel)
        if (depth >= limit) {
          b.more = countRows(c)
          addHidden(c, b, depth + 1)
        } else addChildren(c, b, depth + 1)
        break
      }
      case 'loop':
        pending.push({ from: loopSource(c), row: c, depth, kind: 'loop', note: 'loop: made further up the tree' })
        break
      case 'separate':
        pending.push({ from: c.groupId, row: c, depth, kind: 'separate', note: 'built separately' })
        break
      case 'overflow':
        attach(parent.id, outsideBox(c.item, c.rate, 'overflow of the plan', depth), fuel)
        break
    }
    if (c.kind === 'produce' || c.kind === 'bus' || c.kind === 'byproduct') {
      // Fuel's part off the bus shows on the furnaces or pads it goes into.
      if (c.fromBus > EPS && !fuel)
        attach(parent.id, box({ id: `${c.id}#bus`, row: c.id, kind: 'bus', item: c.item, rate: c.fromBus, depth }))
      if (c.fromByproduct > EPS) takers.push({ row: c, depth })
      if (c.kind !== 'produce' && c.shortfall > EPS) {
        // Nothing makes it: a click shows the row that's short.
        const short = outsideBox(c.item, c.shortfall, 'short: nothing supplies it', depth)
        short.row = c.id
        attach(parent.id, short, fuel)
      }
      joinRecoveries(c, parent, depth)
    }
  }

  /**
   * The rows below a box the level limit leaves out: no boxes of their own, but what they take from
   * boxes in the chart (by-products, loops back up, separate builds) still comes into it.
   */
  const addHidden = (n: TreeNode, into: FlowBox, depth: number) => {
    for (const c of n.children) {
      if (c.consolidated || c.recovery) continue
      if (c.item === HEAT && isTransparent(c)) fuelFeeds(c).forEach((f) => hide(f, into, depth))
      else if (isTransparent(c)) addHidden(c, into, depth)
      else hide(c, into, depth)
    }
  }
  /** A row below the level limit: its feeds from boxes in the chart come into `into`. */
  const hide = (c: TreeNode, into: FlowBox, depth: number) => {
    consumerOf.set(c.id, into.id)
    if (c.fromByproduct > EPS) takers.push({ row: c, depth, hidden: true })
    if (c.kind === 'loop') pending.push({ from: loopSource(c), row: c, depth, kind: 'loop', note: '', hidden: true })
    if (c.kind === 'separate') pending.push({ from: c.groupId, row: c, depth, kind: 'separate', note: '', hidden: true })
  }

  /** The row a loop row's item is made by: the nearest row of it further up the tree. */
  const loopSource = (c: TreeNode) => {
    let up = parentId(c.id)
    while (up !== null && !(rows.get(up)?.item === c.item && rows.get(up)?.kind === 'produce')) up = parentId(up)
    return up ?? undefined
  }

  /** Rows recovering outputs into a row's supply: beside it, feeding what it feeds. */
  const joinRecoveries = (n: TreeNode, into: FlowBox, depth: number) => {
    for (const r of n.children)
      if (r.recovery) {
        if (fuelRows.has(n.id)) fuelRows.add(r.id)
        consumerOf.set(r.id, into.id)
        addRow(r, into, depth)
      }
  }

  /**
   * A box gathering what a row supplies: its machines' output, the part from the bus and other
   * rows' by-products. Used for the chart's own row and items built separately, which supply
   * every use from one place.
   */
  const hub = (n: TreeNode, depth: number): FlowBox => {
    const b = box({
      id: n.id,
      row: n.id,
      kind: 'machines',
      item: n.item,
      rate: n.rate,
      node: n,
      depth,
      group: !!n.consolidated,
    })
    consumerOf.set(n.id, b.id)
    if (n.fromBus > EPS)
      attach(b.id, box({ id: `${n.id}#bus`, row: n.id, kind: 'bus', item: n.item, rate: n.fromBus, depth: depth + 1 }))
    if (n.fromByproduct > EPS) takers.push({ row: n, depth: depth + 1 })
    if (depth >= limit) {
      b.more = countRows(n)
      addHidden(n, b, depth + 1)
    } else addChildren(n, b, depth + 1)
    // With nothing above it in the chart, what's recovered into its supply comes into it.
    joinRecoveries(n, b, depth + 1)
    return b
  }

  const root = hub(start, 0)

  // Loops and separate builds: from the box making it, else from outside the chart. An item built
  // separately elsewhere in the plan comes into the chart, by its first use here.
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i]
    if (p.hidden) continue
    const to = consumerOf.get(p.row.id)!
    const group = p.kind === 'separate' && p.from ? rows.get(p.from) : undefined
    if (group && !boxes.has(group.id)) boxes.get(to)!.children.push(hub(group, p.depth))
    if (p.from && boxes.has(p.from))
      link({ id: `${p.kind}:${p.row.id}`, from: p.from, to, item: p.row.item, rate: p.row.rate, kind: p.kind }, p.row.id)
    else attach(to, outsideBox(p.row.item, p.row.rate, p.note, p.depth, p.from), fuelRows.has(p.row.id))
  }
  // Rows below the level limit: only from boxes the chart has, once it has them all.
  for (const p of pending)
    if (p.hidden && p.from && boxes.has(p.from)) {
      const to = consumerOf.get(p.row.id)!
      link({ id: `${p.kind}:${p.row.id}`, from: p.from, to, item: p.row.item, rate: p.row.rate, kind: p.kind }, p.row.id)
    }
  for (const l of heatLoops)
    if (boxes.has(l.from)) links.push({ ...l, id: `heat:${l.to}`, kind: 'loop', fuel: true })
  // What items built separately send to uses the chart doesn't show.
  for (const b of boxes.values()) {
    if (!b.group) continue
    const here = links.filter((e) => e.from === b.id && e.kind === 'separate')
    const rate = b.rate - here.reduce((t, e) => t + e.rate, 0)
    const uses = (usesOf.get(b.id) ?? 0) - here.length
    if (uses > 0 && rate > 1e-6) b.elsewhere = { rate, uses }
  }
  // By-products: into each taking row's box, from the rows whose side output covers it.
  for (const { row, depth, hidden } of takers) {
    const to = consumerOf.get(row.id)!
    let covered = 0
    for (const s of row.byproductSources) {
      const amount =
        rows
          .get(s.id)
          ?.byproducts.find((b) => b.item === row.item)
          ?.to.find((t) => t.id === row.id)?.amount ?? 0
      if (amount <= EPS) continue
      covered += amount
      if (boxes.has(s.id))
        link({ id: `bp:${s.id}>${row.id}`, from: s.id, to, item: row.item, rate: amount, kind: 'byproduct' }, row.id)
      else if (!hidden)
        attach(to, outsideBox(row.item, amount, `by-product of ${s.label}`, depth, s.id), fuelRows.has(row.id))
    }
    if (!hidden && row.fromByproduct - covered > 1e-6)
      attach(to, outsideBox(row.item, row.fromByproduct - covered, 'by-products', depth), fuelRows.has(row.id))
  }
  // A crucible refining the by-products of the row below it takes them straight off that row.
  for (const b of boxes.values())
    for (const out of b.node?.byproducts ?? [])
      for (const t of out.to)
        if (t.direct && boxes.has(t.id) && t.amount > EPS)
          links.push({
            id: `mix:${b.id}>${t.id}`,
            from: b.id,
            to: t.id,
            item: out.item,
            rate: t.amount,
            kind: 'byproduct',
          })

  // The output each line leaves its machine by.
  const madeBy = (id: string) => {
    const b = boxes.get(id)!
    return b.kind === 'machines' ? b.node : b.source ? rows.get(b.source) : undefined
  }
  for (const e of links) e.port = portOf(madeBy(e.from), e.item)

  const loops = findLoops(boxes, links, root)
  const laid = layout(root, boxes, links)
  return { root, boxes, edges: laid.edges, loops, depth: deepest(start, 0), ...laid.size }
}

/** The most levels a chart opens with. */
export const MAX_DEFAULT_LEVELS = 6
/** The most boxes in one column a chart opens with, past its first level. */
export const MAX_DEFAULT_BREADTH = 8

/**
 * How many levels to open the chart under `rootId` with: as many as keep every column to
 * `MAX_DEFAULT_BREADTH` boxes, up to `MAX_DEFAULT_LEVELS`, and always at least one. A wide recipe
 * opens at its own inputs, a long thin chain further down.
 */
export function defaultLevels(tree: TreeNode[], rootId: string): number {
  let levels = 1
  for (let next = 2; next <= MAX_DEFAULT_LEVELS; next++) {
    const chart = buildFlowChart(tree, rootId, next)
    if (!chart || next > chart.depth) break
    const breadth = new Map<number, number>()
    for (const b of chart.boxes.values()) breadth.set(b.depth, (breadth.get(b.depth) ?? 0) + 1)
    if (Math.max(...breadth.values()) > MAX_DEFAULT_BREADTH) break
    levels = next
  }
  return levels
}

/** Boxes feeding each other round in a cycle (strongly connected, by Tarjan's), each with its net flows. */
function findLoops(boxes: Map<string, FlowBox>, links: Link[], root: FlowBox): FlowLoop[] {
  const next = new Map<string, string[]>()
  for (const e of links) next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const groups: string[][] = []
  let counter = 0
  const visit = (v: string) => {
    index.set(v, counter)
    low.set(v, counter++)
    stack.push(v)
    onStack.add(v)
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        group.push(w)
      } while (w !== v)
      if (group.length > 1 || (next.get(v) ?? []).includes(v)) groups.push(group)
    }
  }
  for (const id of boxes.keys()) if (!index.has(id)) visit(id)

  return groups.map((ids, i) => {
    const members = new Set(ids)
    const inputs = new Map<string, number>()
    const outputs = new Map<string, number>()
    const add = (m: Map<string, number>, item: string, rate: number) => {
      if (rate > EPS) m.set(item, (m.get(item) ?? 0) + rate)
    }
    for (const e of links) {
      if (members.has(e.to) && !members.has(e.from)) add(inputs, e.item, e.rate)
      if (members.has(e.from) && !members.has(e.to)) add(outputs, e.item, e.rate)
    }
    for (const id of ids) {
      const b = boxes.get(id)!
      b.loop = i
      // The chart's own row passes on what it makes, less what it sends back round.
      if (b === root) {
        const back = links.filter((e) => e.from === root.id && e.item === root.item).reduce((t, e) => t + e.rate, 0)
        add(outputs, root.item, (root.node?.rate ?? 0) - back)
      }
      // What's made and nothing uses leaves the loop too.
      if (b.node) {
        add(outputs, b.item, b.node.overflow)
        for (const out of b.node.byproducts) add(outputs, out.item, out.overflow)
      }
    }
    const list = (m: Map<string, number>) =>
      [...m].map(([item, rate]) => ({ item, rate })).sort((a, b) => b.rate - a.rate)
    // Nearest the chart's root first.
    const order = [...boxes.keys()]
    return {
      boxes: ids.sort((a, b) => order.indexOf(a) - order.indexOf(b)),
      inputs: list(inputs),
      outputs: list(outputs),
    }
  })
}

/**
 * Places the boxes as a tree on its side: the root on the right, each box centered on what feeds
 * it. Feeds between neighbouring columns are curves; any other line runs in a lane outside the
 * boxes (lines going back up the tree above them, others below), down the gaps between columns, so
 * it never passes behind a box.
 */
function layout(root: FlowBox, boxes: Map<string, FlowBox>, links: Link[]) {
  const sizeOf = (b: FlowBox): number => 1 + b.children.reduce((t, c) => t + sizeOf(c), 0)
  const sorted = (b: FlowBox) => {
    // Smallest branches first, as in the tree.
    b.children = b.children
      .map((c) => ({ c, n: sizeOf(c) }))
      .sort((p, q) => p.n - q.n)
      .map((p) => p.c)
    b.children.forEach(sorted)
  }
  sorted(root)

  const shift = (b: FlowBox, dy: number) => {
    b.y += dy
    b.children.forEach((c) => shift(c, dy))
  }
  /** Places a branch from `top` down; returns where it ends. */
  const place = (b: FlowBox, top: number): number => {
    if (!b.children.length) {
      b.y = top + b.h / 2
      return top + b.h
    }
    let cursor = top
    for (const c of b.children) cursor = place(c, cursor) + V_GAP
    const bottom = cursor - V_GAP
    b.y = (b.children[0].y + b.children[b.children.length - 1].y) / 2
    if (b.y - b.h / 2 < top) {
      const dy = top - (b.y - b.h / 2)
      shift(b, dy)
      return bottom + dy
    }
    return Math.max(bottom, b.y + b.h / 2)
  }
  const height = place(root, 0)

  const maxDepth = Math.max(...[...boxes.values()].map((b) => b.depth))
  const col = (b: FlowBox) => maxDepth - b.depth
  const byId = (id: string) => boxes.get(id)!
  /** A box's card, above the furnaces or pads under it, and the middle of those. */
  const cardH = (b: FlowBox) => b.h - (b.heat ? HEAT_H : 0)
  const cardY = (b: FlowBox) => b.y - b.h / 2 + cardH(b) / 2
  const heatY = (b: FlowBox) => b.y + b.h / 2 - HEAT_H / 2

  // Lines needing a lane: all but those to the neighbouring column on the right.
  const laned = links.filter((e) => col(byId(e.to)) - col(byId(e.from)) !== 1)
  // Verticals down each gap (gap k sits right of column k; gap -1 left of the first): a slot each.
  const gapSlots = new Map<number, number>()
  const slot = (gap: number) => {
    const n = gapSlots.get(gap) ?? 0
    gapSlots.set(gap, n + 1)
    return n
  }
  const routes = laned.map((e) => {
    const from = byId(e.from)
    const to = byId(e.to)
    return { e, backward: col(to) <= col(from), out: slot(col(from)), into: slot(col(to) - 1) }
  })
  // Labelled lines to the next column (by-products, separate builds) need their gap to fit the label.
  const labelRoom = new Map<number, number>()
  for (const e of links)
    if (e.kind !== 'feed' && col(byId(e.to)) - col(byId(e.from)) === 1) {
      const k = col(byId(e.from))
      labelRoom.set(k, Math.max(labelRoom.get(k) ?? 0, labelWidth(e.rate) + 2 * LABEL_MARGIN))
    }
  const gapW = (k: number) => Math.max(MIN_GAP + (gapSlots.get(k) ?? 0) * LANE_X_STEP, labelRoom.get(k) ?? 0)
  // Room left of the first column for lines entering it.
  let x = gapSlots.has(-1) ? 24 + gapSlots.get(-1)! * LANE_X_STEP : 0
  const colX: number[] = []
  for (let k = 0; k <= maxDepth; k++) {
    colX[k] = x
    x += BOX_W + gapW(k)
  }
  for (const b of boxes.values()) b.x = colX[col(b)]
  // Room right of the last column only for lines leaving it.
  const width = x - (gapSlots.has(maxDepth) ? 0 : gapW(maxDepth))

  // Lanes: shortest spans nearest the boxes, sharing a lane where they don't overlap.
  const lanes = (rs: typeof routes) => {
    const taken: [number, number][][] = []
    const spans = rs.map((r) => {
      const a = byId(r.e.from).x
      const b = byId(r.e.to).x
      return { r, lo: Math.min(a, b) - 40, hi: Math.max(a, b) + BOX_W + 40 }
    })
    spans.sort((p, q) => p.hi - p.lo - (q.hi - q.lo))
    return new Map(
      spans.map(({ r, lo, hi }) => {
        let k = taken.findIndex((lane) => lane.every(([l, h]) => hi < l || lo > h))
        if (k < 0) k = taken.push([]) - 1
        taken[k].push([lo, hi])
        return [r, k] as const
      }),
    )
  }
  const above = lanes(routes.filter((r) => r.backward))
  const below = lanes(routes.filter((r) => !r.backward))
  const laneCount = (m: Map<unknown, number>) => (m.size ? Math.max(...m.values()) + 1 : 0)
  const top = above.size ? -(laneCount(above) * LANE_STEP + 16) : 0
  const bottom = height + (below.size ? laneCount(below) * LANE_STEP + 16 : 0)

  const routeOf = new Map(routes.map((r) => [r.e, r]))
  // Lines to the next column leave and enter their boxes spread down the side, in the order of the
  // boxes at their other end, so two lines between the same boxes never lie on top of each other.
  const curves = links.filter((e) => !routeOf.has(e))
  const port = new Map<Link, { out: number; in: number }>()
  const spread = (side: 'out' | 'in') => {
    const bySide = new Map<string, Link[]>()
    for (const e of curves) {
      // Fuel goes into the furnaces or pads under its box, apart from the box's own feeds.
      const at = side === 'out' ? e.from : `${e.to}${e.fuel ? '#heat' : ''}`
      bySide.set(at, [...(bySide.get(at) ?? []), e])
    }
    for (const [at, es] of bySide) {
      const fuel = at.endsWith('#heat')
      const b = byId(fuel ? at.slice(0, -5) : at)
      const [mid, h] = fuel ? [heatY(b), HEAT_H + 8] : [cardY(b), cardH(b)]
      const other = (e: Link) => byId(side === 'out' ? e.to : e.from).y
      es.sort((p, q) => other(p) - other(q) || (p.id < q.id ? -1 : 1))
      const step = Math.min(PORT_STEP, (h - 16) / Math.max(1, es.length - 1))
      es.forEach((e, i) => {
        const y = mid + (i - (es.length - 1) / 2) * step
        port.set(e, { ...(port.get(e) ?? { out: 0, in: 0 }), [side]: y })
      })
    }
  }
  spread('out')
  spread('in')
  const curve = (a: FlowBox, b: FlowBox, y1: number, y2: number) => {
    const x1 = a.x + a.w
    const x2 = b.x
    const mx = (x1 + x2) / 2
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
  }
  const edges: FlowEdge[] = links.map((e) => {
    const a = byId(e.from)
    const b = byId(e.to)
    const r = routeOf.get(e)
    if (!r) {
      const { out, in: into } = port.get(e)!
      const label = e.kind === 'feed' ? undefined : { x: (a.x + a.w + b.x) / 2, y: (out + into) / 2 }
      return { ...e, path: curve(a, b, out, into), label }
    }
    const outX = a.x + a.w + 12 + r.out * LANE_X_STEP
    const inX = b.x - 12 - r.into * LANE_X_STEP
    const laneY = r.backward ? -16 - above.get(r)! * LANE_STEP : height + 16 + below.get(r)! * LANE_STEP
    // Leave and enter the boxes a little off their middle, clear of their tree feeds.
    const outY = cardY(a) + (r.backward ? -cardH(a) / 4 : cardH(a) / 4)
    const inY = e.fuel ? heatY(b) : cardY(b) + (r.backward ? -cardH(b) / 4 : cardH(b) / 4)
    const path = elbow([
      [a.x + a.w, outY],
      [outX, outY],
      [outX, laneY],
      [inX, laneY],
      [inX, inY],
      [b.x, inY],
    ])
    return { ...e, path, label: { x: (outX + inX) / 2, y: laneY } }
  })

  // Labels sharing a gap (or a lane) move apart rather than cover each other.
  const placed: FlowEdge[] = []
  for (const e of [...edges].filter((e) => e.label).sort((p, q) => p.label!.y - q.label!.y)) {
    const w = labelWidth(e.rate)
    for (const o of placed) {
      const overlapX = Math.abs(o.label!.x - e.label!.x) < (w + labelWidth(o.rate)) / 2 + 4
      if (overlapX && Math.abs(o.label!.y - e.label!.y) < LABEL_H) {
        // In a lane, along it; in a gap, down it.
        if (e.label!.y < 0 || e.label!.y > height) e.label!.x = o.label!.x + (w + labelWidth(o.rate)) / 2 + 8
        else e.label!.y = o.label!.y + LABEL_H
      }
    }
    placed.push(e)
  }

  return { edges, size: { width, height: bottom - top, top } }
}

/** A path through the given points, at right angles, its corners rounded. */
function elbow(pts: [number, number][]): string {
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]
    const [cx, cy] = pts[i]
    const [nx, ny] = pts[i + 1]
    const r1 = Math.min(CORNER, Math.hypot(cx - px, cy - py) / 2)
    const r2 = Math.min(CORNER, Math.hypot(nx - cx, ny - cy) / 2)
    const ax = cx - Math.sign(cx - px) * r1
    const ay = cy - Math.sign(cy - py) * r1
    const bx = cx + Math.sign(nx - cx) * r2
    const by = cy + Math.sign(ny - cy) * r2
    d += ` L${ax},${ay} Q${cx},${cy} ${bx},${by}`
  }
  const [lx, ly] = pts[pts.length - 1]
  return `${d} L${lx},${ly}`
}
