import { HEAT, coinValue, itemName } from './gameData'
import { craftsPerMachine } from './machineRate'
import { runKey, type Process } from './processes'
import { NO_FLOWS, buildTree, type ByproductRoute, type RowFlows, type TreeNode } from './tree'
import type { Plan } from './types'
import { consumedBy, suppliedBy, type PlanNode, type PlanShape } from './unfold'
import type { Modifiers } from './upgrades'
import type { ItemBalance, PlanResult, ProcessRun, ResolvedTarget } from './solver'
import { ingredients, isSupply, lp, outputOf, rootOf, supplierOf, type PlanLp, type TargetRoles } from './solverModel'

const ZERO = 1e-12
const RELATIVE_NOISE = 1e-7

/**
 * What counts as solver noise in a solution: HiGHS solves to a tolerance, and each priority pass is
 * held with some room (see `solveStaged`). Amounts within it aren't part of the plan.
 */
export class Tolerance {
  /** Items per minute a held pass's room could still move: flows, recovery and overflow at or below it are noise. */
  readonly noise: number
  /** Items per minute of shortfall the shortfall pass's room could still move. */
  readonly shortNoise: number

  constructor(noise: number, shortNoise: number) {
    this.noise = noise
    this.shortNoise = shortNoise
  }

  /** A column's value: every column is at least 0, and below that is the solver's tolerance. */
  static value = (x: number) => (x < ZERO ? 0 : x)

  /** Noise relative to the amounts it's measured against: a ten-millionth of the largest (or of 1). */
  relative = (...amounts: number[]) => RELATIVE_NOISE * Math.max(1, ...amounts)

  /** The larger of that and what the held passes left room for: for amounts the passes could move. */
  held = (...amounts: number[]) => Math.max(this.relative(...amounts), this.noise)

  /** An amount with noise at or below `tol` dropped (by default, noise relative to itself). */
  clean = (x: number, tol = this.relative(x)) => (x > tol ? x : 0)
}

/**
 * Items of overflow targets in a runaway loop. A loop runs through the items overflow targets take:
 * from each to the items the rows of the target taking it make. An item whose overflow its target
 * can't use all of (`unused`) while in such a loop runs away, and so does the rest of its loop.
 */
function runawayItems(
  takerOf: Map<string, number>,
  takers: Map<number, PlanNode[]>,
  inTaker: Set<PlanNode>,
  unused: (item: string) => boolean,
): Set<string> {
  // Per taking target's root row, the items it makes that another overflow target takes.
  const makes = new Map<PlanNode, Set<string>>()
  for (const n of inTaker) {
    if (n.kind !== 'make') continue
    const root = rootOf(n)
    for (const o of n.process!.outputs)
      if (takerOf.has(o.item)) makes.set(root, (makes.get(root) ?? new Set()).add(o.item))
  }
  const roots = new Map<number, PlanNode | undefined>()
  for (const [i, leaves] of takers) roots.set(i, leaves[0] && rootOf(leaves[0]))
  const next = (item: string) => makes.get(roots.get(takerOf.get(item)!)!) ?? new Set<string>()
  const reach = (from: string) => {
    const seen = new Set<string>()
    const todo = [...next(from)]
    while (todo.length) {
      const x = todo.pop()!
      if (seen.has(x)) continue
      seen.add(x)
      todo.push(...next(x))
    }
    return seen
  }
  const found = new Set<string>()
  for (const item of takerOf.keys()) {
    if (found.has(item) || !unused(item)) continue
    const ahead = reach(item)
    if (!ahead.has(item)) continue
    for (const x of ahead) if (reach(x).has(item)) found.add(x)
  }
  return found
}

/**
 * What a row whose machines output something is called where that output goes: its recipe, or the
 * item it makes when it runs a recipe for another of its outputs (Athanors making Crude Silver
 * Powder run the Silver Powder recipe: the Silver Powder they leave over isn't "from Silver Powder").
 */
const sourceLabel = (n: PlanNode) => (n.process!.product === n.item ? n.process!.label : itemName(n.item))

export interface SolutionInput {
  plan: Plan
  mods: Modifiers
  shape: PlanShape
  /** The targets as resolved before the solve; sized ones are filled in. */
  targets: ResolvedTarget[]
  roles: TargetRoles
  model: PlanLp
  values: Map<string, number>
  tolerance: Tolerance
}

/** Reads the plan's solved LP: the targets' sizes, each row's flows (as a tree), the runs and the item balances. */
export function readSolution({ plan, mods, shape, targets, roles, model, values, tolerance }: SolutionInput): PlanResult {
  const { planIndex, takers, inTaker, takerOf, supplyRows, supplyTaker, machineCrafts } = roles
  const { index, supplies, pooled, capped, flows, fedFrom, mixes, altared } = model
  const { noise, shortNoise, clean, relative, held } = tolerance
  const v = (name: string) => Tolerance.value(values.get(name) ?? 0)
  const k = (n: PlanNode) => index.get(n)!

  // What each row uses or delivers itself; a supplying row adds what loops and separate builds take.
  const crafts = (n: PlanNode) => (n.kind === 'make' ? v(lp.crafts(k(n))) : 0)
  // A net-surplus target's row also makes what the plan takes of it in place of the bus.
  for (const [item, a] of pooled) targets[a.target].made += v(lp.netMade(item))
  // An overflow target makes what the overflow it takes comes to.
  const taken = (i: number) => clean((takers.get(i) ?? []).reduce((t, leaf) => t + v(lp.overflowTaken(k(leaf))), 0))
  const unused = (item: string) => {
    const x = v(lp.unusedOverflow(item))
    return clean(x, relative(x + taken(takerOf.get(item)!)))
  }
  const runaway = runawayItems(takerOf, takers, inTaker, (item) => unused(item) > 0)
  for (const [i, leaves] of takers) {
    const item = consumedBy(plan.targets[planIndex[i]])!
    const by = takerOf.get(item)
    targets[i].rate = targets[i].made = clean(v(lp.overflowTarget(i)))
    targets[i].overflow = {
      item,
      uses: leaves.length > 0,
      taken: by === i ? taken(i) : 0,
      unused: by === i ? unused(item) : 0,
      takenBy: by !== undefined && by !== i && leaves.length > 0 ? planIndex[by] : null,
      runaway: by === i && runaway.has(item),
    }
  }
  // A supply target makes what what's left of the bus's supply comes to.
  for (const [i, rows] of supplyRows) {
    const item = suppliedBy(plan.targets[planIndex[i]])!
    const by = supplyTaker.get(item)
    const taken = rows.reduce((t, n) => t + v(lp.import(k(n))), 0)
    const left = v(lp.unusedSupply(item))
    targets[i].rate = targets[i].made = by === i ? v(lp.supplyTarget(i)) : 0
    targets[i].supply = {
      item,
      capped: capped.has(item),
      uses: rows.length > 0,
      taken: by === i ? taken : 0,
      unused: by === i ? clean(left, relative(left + taken)) : 0,
      takenBy: by !== undefined && by !== i && rows.length > 0 ? planIndex[by] : null,
    }
  }
  // What the plan's rows take of each fed-back target's output: no more than the held passes left
  // room for is noise, as on the rows taking it.
  for (const [i, names] of fedFrom) {
    const x = names.reduce((t, name) => t + v(name), 0)
    targets[i].fedIn = clean(x, held(x))
  }
  for (const i of machineCrafts.keys()) targets[i].rate = targets[i].made = clean(v(lp.machineTarget(i)))
  const own = new Map<PlanNode, number>()
  targets.forEach((t, i) => {
    const row = shape.targetRows[i]
    if (row) own.set(row, (own.get(row) ?? 0) + t.made)
  })
  for (const n of shape.nodes)
    if (n.kind === 'make')
      ingredients(n.process!).forEach((s, j) => {
        const c = n.children[j]
        if (c) own.set(c, (own.get(c) ?? 0) + s.count * crafts(n))
      })
  // A mixed crucible row's other inputs: their crafts (heated by its heat row) and what they refine.
  const mixed = (n: PlanNode) => (mixes.get(n) ?? []).map((m) => ({ ...m, crafts: v(m.name) }))
  for (const n of mixes.keys()) {
    const heat = n.children[n.process!.inputs.findIndex((s) => s.item === HEAT)]
    for (const m of mixed(n))
      if (heat) own.set(heat, (own.get(heat) ?? 0) + (m.process.inputs.find((s) => s.item === HEAT)?.count ?? 0) * m.crafts)
  }
  // A recovery row supplies what it recovers to the row above it, which needs that much less.
  const recovered = new Map<PlanNode, number>()
  for (const n of shape.nodes)
    if (n.recovers) {
      const x = v(lp.recovered(k(n)))
      own.set(n, x)
      const into = supplierOf(n.parent!)
      recovered.set(into, (recovered.get(into) ?? 0) + x)
    }
  const demand = new Map<PlanNode, number>()
  for (const n of shape.nodes) {
    const s = supplierOf(n)
    demand.set(s, (demand.get(s) ?? 0) + (own.get(n) ?? 0))
  }
  const drawn = new Map<PlanNode, { from: PlanNode; amount: number; fed?: boolean }[]>()
  const sent = new Map<PlanNode, { to: PlanNode; item: string; amount: number; direct?: boolean }[]>()
  for (const f of flows) {
    const amount = v(f.name)
    if (amount <= 0) continue
    drawn.set(f.to, [...(drawn.get(f.to) ?? []), { from: f.from, amount, fed: f.fed }])
    sent.set(f.from, [...(sent.get(f.from) ?? []), { to: f.to, item: f.to.item, amount }])
  }
  for (const n of mixes.keys())
    for (const m of mixed(n)) {
      const amount = m.process.inputs[0].count * m.crafts
      if (amount > 0) sent.set(m.source, [...(sent.get(m.source) ?? []), { to: n, item: m.item, amount, direct: true }])
    }
  /** Where each side output of a row goes, and what's left of it. */
  const routes = (n: PlanNode, x: number) => {
    const out: Record<string, ByproductRoute> = {}
    for (const o of n.process!.outputs) {
      if (o.item === n.item || o.item.startsWith('@')) continue
      const tol = held(o.count * x)
      const left = v(lp.poolSurplus(k(n), o.item))
      out[o.item] = {
        to: (sent.get(n) ?? [])
          .filter((s) => s.item === o.item && s.amount > tol)
          .sort((a, b) => b.amount - a.amount)
          .map((s) => ({ id: s.to.id, amount: s.amount, ...(s.direct && { direct: true }) })),
        ...(altared.has(lp.poolSurplus(k(n), o.item))
          ? { overflow: 0, toAltar: true, altar: clean(left, tol) }
          : { overflow: clean(left, tol), altar: 0 }),
      }
    }
    return out
  }

  const rowFlows = new Map<PlanNode, RowFlows>()
  for (const n of shape.nodes) {
    if (!isSupply(n)) {
      rowFlows.set(n, { ...NO_FLOWS, rate: own.get(n) ?? 0 })
      continue
    }
    const need = demand.get(n) ?? 0
    const x = crafts(n)
    // An overflow target's rows of its item get the overflow it takes.
    const parts = mixed(n)
    const made =
      n.kind === 'make'
        ? outputOf(n.process!, n.item) * x + parts.reduce((t, m) => t + m.crafts, 0)
        : n.kind === 'overflow'
          ? v(lp.overflowTaken(k(n)))
          : 0
    const tol = relative(need, made)
    const received = (drawn.get(n) ?? []).filter((d) => d.amount > tol * 1e-2)
    // Shown: draws above what the held passes left room for (noise there isn't a real feed).
    const draws = received.filter((d) => d.amount > noise).sort((a, b) => b.amount - a.amount)
    const fromByproduct = draws.reduce((sum, d) => sum + d.amount, 0)
    const fromRecovery = recovered.get(n) ?? 0
    const missing = need - made - received.reduce((sum, d) => sum + d.amount, 0) - fromRecovery
    const short = missing > tol ? missing : 0
    // Rows taking an item from the bus get what it carries; past a capped supply, they fall short.
    const drew = n.kind !== 'bus' || n.unsupplied ? 0 : capped.has(n.item) ? Math.min(short, clean(v(lp.import(k(n))), tol)) : short
    // A row other rows' leftovers cover (as they come or recovered), making only what the held passes
    // left room for, stands idle.
    const idle = !parts.length && (fromByproduct > 0 || fromRecovery > noise) && made <= noise
    rowFlows.set(n, {
      // A recovery row running only on what the held passes left room for is noise: it isn't shown.
      rate: n.recovers && need <= noise ? 0 : need,
      crafts: idle ? 0 : x,
      fromByproduct,
      byproductSources: draws.map((d) => ({ id: d.from.id, label: d.fed ? `the ${itemName(d.from.item)} target, fed back` : sourceLabel(d.from) })),
      fromRecovery: clean(fromRecovery, held(need, made)),
      fromBus: drew,
      // A shortfall no more than the shortfall pass's room could move is noise.
      shortfall: short - drew > tol + shortNoise ? short - drew : 0,
      overflow: clean(v(lp.surplus(k(n))), held(need, made)),
      byproductRoutes: n.kind === 'make' ? routes(n, x) : {},
      ...(parts.length && { mix: [{ process: n.process!, crafts: x }, ...parts.map((m) => ({ process: m.process, crafts: m.crafts }))] }),
    })
  }

  // Machines per process on its machine, summed over the rows.
  const totals = new Map<string, { process: Process; crafts: number }>()
  const count = (p: Process, x: number) => {
    const key = runKey(p)
    const t = totals.get(key) ?? { process: p, crafts: 0 }
    t.crafts += x
    totals.set(key, t)
  }
  // Machines run only for the rows the tree shows, as it shows them: rows it leaves out (recovering
  // only what the held passes left room for, or under a row other rows' leftovers cover) run none.
  const tree = buildTree(shape.roots, rowFlows, mods)
  const shown = new Set<string>()
  const mark = (t: TreeNode) => {
    shown.add(t.id)
    t.children.forEach(mark)
  }
  tree.forEach(mark)
  // A mixed crucible row counts as a group of crucibles per input.
  for (const n of shape.nodes) if (n.kind === 'make' && shown.has(n.id)) count(n.process!, rowFlows.get(n)?.crafts ?? crafts(n))
  for (const n of mixes.keys()) if (shown.has(n.id)) for (const m of mixed(n)) count(m.process, m.crafts)
  const runs: ProcessRun[] = [...totals].map(([key, { process: p, crafts: x }]) => ({
    key,
    process: p,
    craftsPerMinute: x,
    machines: p.seconds > 0 ? x / craftsPerMachine(p, mods) : 0,
    inputs: p.inputs.map((s) => ({ item: s.item, count: s.count * x })),
    outputs: p.outputs.map((s) => ({ item: s.item, count: s.count * x })),
  }))

  // Per item: bus draws and shortfalls from the rows, surplus whatever's left, so every
  // balance is exact (the solver's own slack values are rounded and would leave visible noise on
  // items with huge counts). Draws a net-surplus target covers are made in the plan: what the
  // sources ahead of it supply counts as made (the ledger shows which), and what nothing can cover
  // as a shortfall.
  const balance = new Map<string, ItemBalance>()
  const of = (item: string) => {
    let b = balance.get(item)
    if (!b) {
      b = { item, target: 0, produced: 0, consumed: 0, fromBus: 0, drawn: 0, deficit: 0, surplus: 0, altar: 0 }
      balance.set(item, b)
    }
    return b
  }
  // What the plan's rows take of a fed-back target's output stays in the plan.
  for (const t of targets) of(t.item).target += t.rate - (t.fedIn ?? 0)
  for (const item of pooled.keys()) {
    of(item).produced += v(lp.aheadUsed(item))
    of(item).deficit += v(lp.netDeficit(item))
  }
  for (const r of runs) {
    for (const s of r.outputs) of(s.item).produced += s.count
    for (const s of r.inputs) of(s.item).consumed += s.count
  }
  for (const n of supplies) {
    const f = rowFlows.get(n)!
    const b = of(n.item)
    b.drawn += f.fromBus
    if (!pooled.has(n.item)) b.fromBus += f.fromBus
    b.deficit += f.shortfall
  }
  for (const [name, item] of altared) of(item).altar += clean(v(name))
  for (const b of balance.values()) {
    let net = b.produced - b.consumed + b.fromBus + b.deficit - b.target - b.altar
    // What the held passes left room for is noise too, as on the rows (coins aside: real amounts of
    // them can be that small).
    const room = coinValue(b.item) === null ? noise + shortNoise : 0
    if (Math.abs(net) <= Math.max(relative(b.produced, b.consumed), room)) net = 0
    b.surplus = Math.max(0, net)
  }

  return {
    status: 'ok',
    targets,
    runs,
    balances: [...balance.values()],
    tree,
    noise,
  }
}
