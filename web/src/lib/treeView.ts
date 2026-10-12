import type { CSSProperties } from 'react'
import { HEAT, MONEY, NUTRIENTS, itemName, itemsByKey } from './gameData'
import { DEFAULT_BANK_STACK } from './processes'
import type { TreeNode } from './tree'
import type { Separation } from './types'
import { parentId, rowItem } from './unfold'

/*
 * The production tree as the planner shows it: the solved tree laid out into rows and lines (targets
 * in the plan's order, by-product and recovery lines, folded heat and nutrients), with the card edges
 * between them. Pure: no React.
 */

/** What a recovery row takes in from other machines' outputs: "Impure Gold Dust". */
export const recovers = (n: TreeNode) => (n.recovers ?? []).map(itemName).join(' and ')

/** What merging a separated item back undoes. */
export function mergeHint(s: Separation, name: string) {
  if (!s.anchor) return `show ${name} under each branch that uses it again`
  const at = itemsByKey.get(s.anchor)?.name ?? s.anchor
  return s.at ? `stop gathering ${name} with this ${at}` : `stop gathering ${name} with every ${at}`
}

/** One row's piece of a branch's card edge: its rounded top, the side, or its rounded bottom. */
export interface Edge {
  level: number
  piece: 'top' | 'mid' | 'bottom'
  /** The highlighted edge around a "with" group. */
  accent: boolean
}

/** A table line: an item row, or the divider above an anchor's "with" rows. */
export type Line =
  | { kind: 'row'; node: TreeNode; depth: number; card?: number; edges: Edge[]; afterBranch?: boolean }
  | { kind: 'with'; anchor: string; anchorId: string; depth: number; edges: Edge[]; afterBranch?: boolean }

export const PLAN_ROOT = 'plan'

/** The root of an item built at the top of the plan (not a row inside it). */
export const isTopGroupId = (id: string) => /^separate\/[^/]+$/.test(id)

/** A row whose own machines get built in the game: only these can be marked built. */
export const hasMachines = (n: TreeNode) => n.kind === 'produce' && !!n.run?.process.machine

/**
 * A row's place on the build checklist: marked built or not ('mixed': only rows below it are),
 * 'auto' for a row pointing to built machines elsewhere, null for a row with nothing to build.
 */
export type BuiltState = boolean | 'mixed' | 'auto' | null

/** Why a row pointing to machines elsewhere shows as built. */
export function autoBuiltHint(kind: TreeNode['kind']): string {
  if (kind === 'separate') return 'Built: the machines that make it, where it’s built separately, are marked built'
  if (kind === 'loop') return 'Built: the machines further up this branch that make it are marked built'
  return 'Built: the machines whose by-product it is are marked built'
}

/** The row of a target that has none in the tree yet (no item, or not solved yet). */
export const pendingId = (index: number) => `target/${index}`

/**
 * The tree as shown: one row per target, in the plan's order (a bare one for a target the tree
 * has no row for yet). Items built at the top of the plan join the target as a "with" group, or,
 * with several targets, an "All targets" row holding the targets and the group. Also the row each
 * target sits in. Rows partly covered by by-products show them on a line of their own.
 */
export function viewOf(tree: TreeNode[], rootIds: (string | null)[]): { view: TreeNode[]; slotRows: string[] } {
  const roots = new Map(tree.map((n) => [n.id, withReused(n)]))
  // Rows of targets that have since moved or gone wait for the next solve.
  const rows = rootIds.map((id, i) => (id && roots.get(id)) || blankRow(pendingId(i)))
  const slotRows = rows.map((n) => n.id)
  // A target's recovery rows sit beside it, as do an item built separately's, as they do beside any
  // row: they add to what it delivers, they aren't its ingredients (Gold Dust refined from Impure
  // Gold Dust isn't an input of the Gold Dust Athanors).
  const own = new Set(tree.flatMap((n) => n.children.filter((r) => r.recovery).map((r) => r.id)))
  const targets = rows.flatMap((n) => besideRecovery(n, own))
  const groups = tree
    .filter((n) => n.id.startsWith('separate/'))
    .map(withReused)
    .flatMap((n) => besideRecovery(n, own))
  if (!groups.length) return { view: targets, slotRows }
  const made = rows.filter((n) => n.item)
  if (made.length === 1)
    return { view: targets.map((n) => (n.id === made[0].id ? { ...n, children: [...n.children, ...groups] } : n)), slotRows }
  return { view: [blankRow(PLAN_ROOT, [...targets, ...groups])], slotRows }
}

/**
 * A row with the rows recovering into its supply (those in `recovering`) beside it: its own
 * machines' part, then the recovered part, together what it delivers.
 */
export function besideRecovery(n: TreeNode, recovering: Set<string>): TreeNode[] {
  if (!n.children.some((r) => recovering.has(r.id))) return [n]
  return [
    { ...n, rate: n.rate - n.fromRecovery, children: n.children.filter((r) => !recovering.has(r.id)) },
    ...n.children.filter((r) => recovering.has(r.id)),
  ]
}

/** Line id suffix for the by-products covering part of a row. */
export const REUSED_LINE = '#reused'

/** Row id suffix for the row gathering an ingredient's sources. */
export const GATHER_ROW = '#sources'

/** Heat, Nutrients and Money rows: shown as a pick on the row they heat, feed or pay for, not rows of their own. */
export const isFolded = (n: TreeNode) => n.item === HEAT || n.item === NUTRIENTS || n.item === MONEY

/**
 * A fuel, fertilizer or coin taken whole off the bus: nothing to build or follow below it, so it
 * reads on the line picking what the row burns, spreads or pays with rather than as a row.
 */
export const isDraw = (n: TreeNode) => n.kind === 'bus' && !n.children.length && n.fromByproduct <= 1e-9 && !n.consolidated

/** How a folded row reads: on the row it's folded into, and on the fuel, fertilizer or coin row below it. */
export const FOLDED_VERB: Record<string, { glyph: string; does: string; done: string; title: string }> = {
  [HEAT]: { glyph: '🔥', does: 'burns', done: 'burned', title: 'Burned for the heat of the machines above' },
  [NUTRIENTS]: { glyph: '🌱', does: 'spreads', done: 'spread', title: 'Spread on the nurseries above' },
  [MONEY]: { glyph: '🪙', does: 'pays with', done: 'spent', title: 'Paid into the Purchasing Portals above' },
}

/**
 * A row as shown. Its Heat and Nutrients rows fold into it: what it burns or spreads is picked on
 * its own row, the fuel or fertilizer rows sitting with its ingredients. Each ingredient partly
 * covered by other rows' by-products shows as the two feeds its machines get: the by-products, on a
 * line of their own, then what the ingredient's row makes (or buys) itself. A row gathering an
 * item built separately stays whole.
 */
export function withReused(n: TreeNode): TreeNode {
  const partly = (c: TreeNode) =>
    (c.kind === 'produce' || c.kind === 'bus') &&
    !c.consolidated &&
    c.fromByproduct > 1e-9 &&
    c.rate - c.fromByproduct > 1e-9
  const folded = n.children.filter(isFolded)
  // Each child with the by-product line shown above it, if any, and the rows recovering outputs into
  // its supply after it: they stay together. The recovery rows feed what the child feeds alongside
  // it, not the child's machines, so they sit beside it. A row gathering an item built separately
  // feeds its uses, not this row: its recovery sits beside it in its "with" card, not gathered.
  const feeds = n.children.flatMap((c) => (isFolded(c) ? c.children.filter((f) => !isDraw(f)) : [c])).map((child) => {
    const whole = withReused(child)
    // Only the rows recovering into this one: those it shows beside it came from further down.
    const joining = new Set(child.children.filter((r) => r.recovery).map((r) => r.id))
    if (child.consolidated) return besideRecovery(whole, joining)
    if (!joining.size) return gathered(whole, withByproductLine(whole))
    const recovered = whole.children.filter((r) => joining.has(r.id))
    const c = { ...whole, rate: whole.rate - whole.fromRecovery, children: whole.children.filter((r) => !joining.has(r.id)) }
    // A row taking only other rows' outputs (its own machines idle, if it has any), all of which
    // come recovered: just the recovery rows.
    const empty = c.kind === 'byproduct' && c.rate <= 1e-9 && !c.children.length
    return gathered(whole, [...(empty ? [] : withByproductLine(c)), ...recovered])
  })
  // Smallest branches first, so a leaf (a fuel off the bus, say) sits right under the row it feeds
  // rather than below a deep sibling. Rows gathered "with" it stay last, under their divider.
  const key = (f: TreeNode[]) => {
    const c = f.find((r) => !r.reusedBy && !r.recovery) ?? f[f.length - 1]
    return isGroupRow(c, 1) ? Number.MAX_SAFE_INTEGER : f.reduce((t, r) => t + rowCount(r), 0)
  }
  return {
    ...n,
    // Each with what it takes off the bus, if that's all it takes.
    ...(folded.length > 0 && { folded: folded.map((f) => ({ ...f, children: f.children.filter(isDraw) })) }),
    children: feeds
      .map((f) => ({ f, size: key(f) }))
      .sort((a, b) => a.size - b.size)
      .flatMap(({ f }) => f),
  }

  /**
   * An ingredient's feeds: as they are when it has one, else under a row gathering them, so what
   * the row above takes of it in all reads in one place (Silver Powder left over by one row, made
   * by its own Athanors, and refined up from their failed crafts).
   */
  function gathered(whole: TreeNode, feeds: TreeNode[]): TreeNode[] {
    if (feeds.length < 2) return feeds
    return [{ ...blankRow(`${whole.id}${GATHER_ROW}`, feeds), item: whole.item, kind: 'gather', rate: whole.rate }]
  }

  /** A row, after the line for the part of it other rows' by-products cover, if any. */
  function withByproductLine(c: TreeNode): TreeNode[] {
    if (!partly(c)) return [c]
    const line: TreeNode = {
      ...blankRow(`${c.id}${REUSED_LINE}`),
      item: c.item,
      kind: 'byproduct',
      rate: c.fromByproduct,
      fromByproduct: c.fromByproduct,
      byproductSources: c.byproductSources,
      reusedBy: c.id,
    }
    return [line, { ...c, rate: c.rate - c.fromByproduct, reusedApart: true }]
  }
}

/** Rows shown in a branch, its own included. */
export const rowCount = (n: TreeNode): number => 1 + n.children.reduce((sum, c) => sum + rowCount(c), 0)

/** A row standing for something other than an item: all targets, or a target with no item. */
export function blankRow(id: string, children: TreeNode[] = []): TreeNode {
  return {
    id,
    item: '',
    kind: 'produce',
    rate: 0,
    machines: 0,
    heat: 0,
    nutrients: 0,
    overflow: 0,
    byproducts: [],
    fromByproduct: 0,
    byproductSources: [],
    fromBus: 0,
    shortfall: 0,
    fromRecovery: 0,
    producer: '',
    ownChoice: false,
    mine: false,
    defaultCatalysts: [],
    defaultHeight: 0,
    defaultStack: DEFAULT_BANK_STACK,
    defaultMixed: false,
    children,
  }
}

/**
 * What a row of a by-product feeds: the item of the row above it, or, at the top of the plan, the
 * target itself or the separate build gathering it.
 */
export function destinationName(id: string, topName: string): string {
  const name = itemsByKey.get(rowItem(id))?.name ?? rowItem(id)
  const up = parentId(id)
  // A target's own row sits under its place in the targets (`0/Sol`).
  if (up === null || /^\d+$/.test(up)) return `${name} target`
  if (up === 'separate') return `${name} (gathered with ${topName})`
  return itemsByKey.get(rowItem(up))?.name ?? rowItem(up)
}

export function topAnchorName(tree: TreeNode[]) {
  const targets = tree.filter((n) => !n.id.startsWith('separate/'))
  return targets.length === 1 ? (itemsByKey.get(targets[0].item)?.name ?? targets[0].item) : 'all targets'
}

/** A row gathering separated uses: a top-of-plan group, or one under an anchor. */
export const isGroupRow = (node: TreeNode, depth: number) =>
  depth > 0 && (isTopGroupId(node.id) || !!node.separation?.anchor)

/**
 * Lays out the visible lines. Each open branch gets a card edge from its row down to its last
 * descendant, and each anchor's "with" rows get a highlighted one from their divider.
 */
export function layoutLines(tree: TreeNode[], collapsed: Set<string>): Line[] {
  const lines: Line[] = []
  const walk = (nodes: TreeNode[], depth: number, card?: number, parent?: TreeNode) => {
    let divided = false
    for (const node of nodes) {
      const group = isGroupRow(node, depth)
      if (group && !divided && parent) {
        divided = true
        lines.push({ kind: 'with', anchor: parent.item, anchorId: parent.id, depth, edges: [] })
      }
      // A "with" row's recovery, beside it, stays in its card.
      const inCard = group || divided ? depth : card
      lines.push({ kind: 'row', node, depth, card: inCard, edges: [] })
      if (!collapsed.has(node.id)) walk(node.children, depth + 1, inCard, node)
    }
  }
  walk(tree, 0)

  // Edges open at a line and close before the first line at `closeAt` depth or shallower.
  const open: { level: number; closeAt: number; start: number; accent: boolean }[] = []
  const draw = (span: (typeof open)[number], end: number) => {
    for (let k = span.start; k <= end; k++) {
      const piece = k === span.start ? 'top' : k === end ? 'bottom' : 'mid'
      lines[k].edges.push({ level: span.level, piece, accent: span.accent })
    }
  }
  lines.forEach((line, k) => {
    while (open.length && open.at(-1)!.closeAt >= line.depth) draw(open.pop()!, k - 1)
    if (line.kind === 'with') open.push({ level: cardLevel(line.depth), closeAt: line.depth - 1, start: k, accent: true })
    else if (line.node.children.length && !collapsed.has(line.node.id))
      open.push({ level: line.depth, closeAt: line.depth, start: k, accent: false })
  })
  while (open.length) draw(open.pop()!, lines.length - 1)
  // Breathing room after a branch closes, above the line that follows it.
  lines.forEach((line, k) => {
    if (k > 0 && lines[k - 1].edges.some((e) => e.piece === 'bottom')) line.afterBranch = true
  })
  return lines
}

export const edgeX = (level: number) => level * 20 + 4 // just left of that level's fold arrow

/** A "with" card's edge: half a level out, leaving room inside it for its rows' own branch edges. */
export const cardLevel = (depth: number) => depth - 0.5

/** Where a tinted row's tint starts: at its edge, so the margin outside stays clear. */
export const bandStyle = (x: number) => ({ '--band-x': `${x}px` }) as CSSProperties

/** Where a "with" card's tint starts. */
export const cardStyle = (level?: number) => (level === undefined ? undefined : bandStyle(edgeX(cardLevel(level))))

/**
 * Whether a row is the last of its "with" card (its edge rounds off there), with no card around it
 * going on below, whose tint would then be cut short.
 */
export const endsCard = (edges: Edge[], card: number) =>
  edges.some((e) => e.accent && e.piece === 'bottom' && e.level === cardLevel(card)) &&
  !edges.some((e) => e.accent && e.piece !== 'bottom' && e.level < cardLevel(card))

/** A row's share in one of `copies` copies of it: every amount divided among them. */
export function shareOf(n: TreeNode, copies: number): TreeNode {
  const k = 1 / copies
  return {
    ...n,
    rate: n.rate * k,
    machines: n.machines * k,
    heat: n.heat * k,
    nutrients: n.nutrients * k,
    overflow: n.overflow * k,
    fromByproduct: n.fromByproduct * k,
    fromBus: n.fromBus * k,
    shortfall: n.shortfall * k,
    byproducts: n.byproducts.map((b) => ({
      ...b,
      count: b.count * k,
      overflow: b.overflow * k,
      altar: b.altar * k,
      to: b.to.map((t) => ({ ...t, amount: t.amount * k })),
    })),
    mixParts: n.mixParts?.map((m) => ({ ...m, rate: m.rate * k, machines: m.machines * k })),
  }
}

/** A row, with the ids of the branches above it. */
export interface Placed {
  node: TreeNode
  ancestors: string[]
}

/** Every row of the view with the ids of the branches above it, folded or not, in tree order. */
export function placeAll(view: TreeNode[]): Placed[] {
  const out: Placed[] = []
  const visit = (nodes: TreeNode[], ancestors: string[]) => {
    for (const node of nodes) {
      out.push({ node, ancestors })
      visit(node.children, [...ancestors, node.id])
    }
  }
  visit(view, [])
  return out
}

/** The build checklist over the view's rows (see `checklistOf`). */
export interface Checklist {
  /** Per row: rows with machines below it, and how many of them are marked built. */
  below: Map<string, { rows: number; built: number }>
  /** Rows pointing to machines elsewhere that are built. */
  auto: Set<string>
  /** Rows with machines, and how many are marked built. */
  rows: number
  done: number
}

/**
 * The build checklist: only rows with machines are built. Rows pointing to machines elsewhere (a
 * separate build, a loop, a by-product) show as built once those are.
 */
export function checklistOf(view: TreeNode[], byId: Map<string, Placed>, built: Set<string>): Checklist {
  const isBuilt = (n: TreeNode) => hasMachines(n) && built.has(n.id)
  const builtId = (id: string | undefined) => {
    const n = id === undefined ? undefined : byId.get(id)?.node
    return !!n && isBuilt(n)
  }
  const below = new Map<string, { rows: number; built: number }>()
  const auto = new Set<string>()
  let rows = 0
  let done = 0
  const visit = (n: TreeNode): { rows: number; built: number } => {
    const sum = { rows: 0, built: 0 }
    for (const c of n.children) {
      const s = visit(c)
      sum.rows += s.rows + (hasMachines(c) ? 1 : 0)
      sum.built += s.built + (isBuilt(c) ? 1 : 0)
    }
    below.set(n.id, sum)
    if (hasMachines(n)) {
      rows++
      if (isBuilt(n)) done++
    } else if (
      (n.kind === 'separate' && builtId(n.groupId)) ||
      // A loop is made by the nearest row of its item further up the branch.
      (n.kind === 'loop' && builtId(byId.get(n.id)?.ancestors.findLast((a) => byId.get(a)?.node.item === n.item))) ||
      (n.kind === 'byproduct' && n.byproductSources.length > 0 && n.byproductSources.every((s) => builtId(s.id)))
    )
      auto.add(n.id)
    return sum
  }
  view.forEach(visit)
  return { below, auto, rows, done }
}
