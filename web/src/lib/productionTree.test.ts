import { describe, expect, it } from 'vitest'
import { MONEY } from './gameData'
import { buildCatalog, defaultProducer } from './processes'
import { ledgers } from './ledger'
import { fedOverflow, moneyLedger } from './money'
import { solvePlan, type PlanResult } from './solver'
import { type TreeNode } from './tree'
import { chooseProducer, setOutputAltar, clearBranchChoice, pruneChoices, rowsById } from './choices'
import { separationsOf, withSeparation } from './separate'
import { canSeparateShared, mergeSingleUses, organize, separateShared, setSeparation } from './separateAll'
import type { Plan, SavedRecipe, Separation } from './types'
import { modifiers } from './upgrades'
import { plan, expectBalanced } from './engineTestUtils'

describe('production tree', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)]
  /** Every machine in the plan shows up in exactly one row. */
  const expectMachinesOnce = (r: PlanResult) => {
    const nodes = r.tree.flatMap(all)
    for (const run of r.runs.filter((x) => x.machines > 0 && x.process.machine)) {
      const shown = nodes.filter((n) => n.run?.key === run.key).reduce((sum, n) => sum + n.machines, 0)
      expect(shown, run.process.label).toBeCloseTo(run.machines)
    }
  }

  it('splits machines by branch and ends in purchases, paid with coins off the bus', () => {
    const targets = [{ item: 'WoodBoard', rate: 60 }]
    const [root] = solvePlan(plan({ targets }), catalog, mods).tree
    expect(root.kind).toBe('produce')
    expect(root.machines).toBeCloseTo(2)
    const wood = root.children.find((c) => c.item === 'Wood')!
    expect(wood).toMatchObject({ kind: 'produce', producer: 'buy:Wood' })
    expect(wood.rate).toBeCloseTo(0.3)
    expect(wood.machines).toBeCloseTo(0.3 / 60) // a Log per belt slot
    const [money] = wood.children
    expect(money).toMatchObject({ item: MONEY, producer: 'spend:GoldCoin' }) // every tier: gold buys it all at full speed
    expect(money.children[0]).toMatchObject({ item: 'GoldCoin', kind: 'bus' })
    expect(money.children[0].fromBus).toBeCloseTo((0.3 * 200) / 100_000) // 200 copper a Log
  })

  it('stops at cycles instead of recursing forever', () => {
    // Vitality Essence ← Oblivion Essence ← Vitality Essence (both Paradox Crucible recipes).
    const targets = [{ item: 'Vitae', rate: 10 }]
    const result = solvePlan(plan({ targets, producers: { Mors: 'recipe:Mors_Alt' } }), catalog, mods)
    const find = (nodes: TreeNode[]): TreeNode | undefined =>
      nodes.map((n) => (n.kind === 'loop' ? n : find(n.children))).find(Boolean)
    expect(find(result.tree)?.item).toBe('Vitae')
  })

  it('says at the source where by-products go and what overflows', () => {
    // Nectar only comes with Gentian. Each row runs for the row it feeds: the Gentian row's Nectar
    // goes to the Nectar row, whose own nurseries make the rest and overflow their Gentian.
    const [gentian, nectar] = solvePlan(
      plan({ targets: [{ item: 'Gentian', rate: 1 }, { item: 'GentianNectar', rate: 100 }] }),
      catalog,
      mods,
    ).tree
    const side = gentian.byproducts.find((b) => b.item === 'GentianNectar')!
    expect(side.to).toEqual([{ id: nectar.id, amount: expect.closeTo(side.count) }])
    expect(side.overflow).toBe(0)
    expect(gentian.rate).toBeCloseTo(1)
    expect(gentian.overflow).toBe(0)
    expect(nectar.fromByproduct).toBeCloseTo(side.count)
    expect(nectar.byproducts.find((b) => b.item === 'Gentian')!.overflow).toBeCloseTo(100 - side.count)

    // Steel's failed Iron Ingots all go back into its own Iron Ingot supply: nothing overflows.
    const [steel] = solvePlan(plan({ targets: [{ item: 'SteelIngot', rate: 10 }] }), catalog, mods).tree
    const failed = steel.byproducts.find((b) => b.item === 'IronIngot')!
    expect(failed.to.map((t) => t.id)).toEqual([steel.children.find((c) => c.item === 'IronIngot')!.id])
    expect(failed.overflow).toBe(0)
    expect(steel.overflow).toBe(0)
  })

  it('sends an output to Knowledge Altars at its source, so rows using it make their own, and back', () => {
    const base = plan({ targets: [{ item: 'CopperIngot', rate: 37.5 }, { item: 'BronzeIngot', rate: 50 }] })
    const solve = (p: Plan) => {
      const r = solvePlan(p, catalog, mods)
      expectBalanced(r)
      return r
    }
    const impureRow = (r: PlanResult) => r.tree[1].children.find((c) => c.item === 'CopperPowder')!
    const copperRow = (r: PlanResult) => r.tree[0].children.find((c) => c.item === 'CopperPowder2')!
    // Impure Copper Powder only comes from Athanors failing at Copper Powder: the Bronze's row runs
    // them for it, and the Copper Ingots take the Copper Powder they make.
    expect(defaultProducer(catalog, 'CopperPowder')).toBe('recipe:CopperPowder2')
    const before = solve(base)
    const impure = impureRow(before)
    expect(impure).toMatchObject({ kind: 'produce', producer: 'recipe:CopperPowder2', rate: expect.closeTo(50) })
    expect(copperRow(before).fromByproduct).toBeCloseTo(37.5)
    expect(copperRow(before).byproductSources.map((s) => s.id)).toEqual([impure.id])

    // Sent to the altars: the Copper Ingots' own Athanors run, refining their failed crafts back up.
    const sent = setOutputAltar(base, impure.id, 'CopperPowder2', true)
    expect(sent.altarOutputs).toEqual({ [impure.id]: ['CopperPowder2'] })
    const after = solve(sent)
    const made = copperRow(after)
    expect(made).toMatchObject({ kind: 'produce', fromByproduct: 0, rate: expect.closeTo(37.5) })
    expect(made.byproducts.find((b) => b.item === 'CopperPowder')!.overflow).toBe(0)
    const pure = impureRow(after).byproducts.find((b) => b.item === 'CopperPowder2')!
    expect(pure).toMatchObject({ to: [], overflow: 0, toAltar: true, altar: expect.closeTo(50) })
    // Broken down, not overflow: nothing feeds back or overflows of it.
    const copper = after.balances.find((b) => b.item === 'CopperPowder2')!
    expect(copper.altar).toBeCloseTo(50)
    expect(copper.surplus).toBe(0)
    const money = moneyLedger(sent, after, ledgers(sent, after))
    const out = money.outputs.find((o) => o.item === 'CopperPowder2')!
    expect(out).toMatchObject({ altar: expect.closeTo(50), toBus: 0 })
    expect(out.sources[0]).toMatchObject({ target: null, atSource: expect.closeTo(50) })
    expect(fedOverflow(money).get('CopperPowder2')).toMatchObject({ share: expect.closeTo(1), altar: true })

    // And back: the setting goes, and the Copper Ingots take it again.
    const back = setOutputAltar(sent, impure.id, 'CopperPowder2', false)
    expect(back.altarOutputs).toBeUndefined()
    expect(copperRow(solve(back)).fromByproduct).toBeCloseTo(37.5)
  })

  it('picks what makes the rest apart from taking by-products first', () => {
    // Growth Potion (from Reddit): crushing Rock Salt for the Salt makes Sand on the side, which goes
    // into the Clay; Stone ground on Enhanced Grinders makes the rest.
    const base = plan({ targets: [{ item: 'GrowthPotion', rate: 2 }], producers: { Salt: 'recipe:Salt_Alt' } })
    const row = '0/GrowthPotion/ClayPowder/Clay/Sand'
    const sand = (p: Plan) => {
      const r = solvePlan(p, catalog, mods)
      expectBalanced(r)
      return rowsById(r.tree).get(row)!
    }
    const reused = sand(base).fromByproduct
    expect(reused).toBeGreaterThan(0)

    const enhanced = chooseProducer(base, catalog, { item: 'Sand', producer: 'recipe:Sand', machine: 'EnhancedGrinder', row })
    const rest = sand(enhanced)
    expect(rest.fromByproduct).toBeCloseTo(reused)
    expect(rest.run!.process.machine!.key).toBe('EnhancedGrinder')
    expect(rest.run!.outputs[0].count).toBeCloseTo(rest.rate - reused)

    // The crushers' Sand sent to Knowledge Altars instead: all of it on Enhanced Grinders.
    const [crushers] = rest.byproductSources
    const off = setOutputAltar(enhanced, crushers.id, 'Sand', true)
    expect(sand(off).fromByproduct).toBe(0)
    expect(sand(off).run!.process.machine!.key).toBe('EnhancedGrinder')
    expect(sand(off).run!.outputs[0].count).toBeCloseTo(rest.rate)
    // Clearing the producer pick leaves where the Sand goes as set.
    expect(clearBranchChoice(off, row).branches).toEqual({})
    expect(clearBranchChoice(off, row).altarOutputs).toEqual(off.altarOutputs)
  })

  it('never runs a source harder for more of its by-products', () => {
    // Mars: the Copper Bearings' Athanors fail into Impure Copper Powder, which they refine back up
    // into their own Copper Powder first. The Bronze Rivets' costly cauldron recipe makes theirs;
    // growing the Athanors would be cheaper, but would overflow Copper Powder.
    const saved: SavedRecipe = { id: 'imp', mode: 'normal', inputs: ['Charcoal', 'Jupiter', 'VitalityPotion'], output: 'CopperPowder', createdAt: 0 }
    const c = buildCatalog({ saved: [saved], machines: {}, mods, fertilizer: null })
    const r = solvePlan(plan({ targets: [{ item: 'Mars', rate: 1 }], producers: { CopperPowder: 'cauldron:imp' } }), c, mods)
    expectBalanced(r)
    const rows = rowsById(r.tree)
    const powder = rows.get('0/Mars/CopperBearing/CopperIngot/CopperPowder2')!
    const failed = powder.byproducts.find((b) => b.item === 'CopperPowder')!
    expect(powder.overflow).toBe(0)
    expect(failed.overflow).toBe(0)
    const impure = rows.get('0/Mars/BronzeRivet/BronzeIngot/CopperPowder')!
    expect(failed.to.every((t) => t.id.startsWith(powder.id))).toBe(true)
    expect(impure.kind).toBe('produce')
    expect(impure.fromByproduct).toBe(0)
    expect(impure.run!.outputs[0].count).toBeCloseTo(impure.rate)
  })

  it('feeds a by-product to the row that uses it nearest its source', () => {
    // Steel fails into Iron Ingots, which go straight back into the Steel's own Iron Ingot supply.
    const [steel] = solvePlan(plan({ targets: [{ item: 'SteelIngot', rate: 10 }] }), catalog, mods).tree
    const iron = steel.children.find((c) => c.item === 'IronIngot')!
    const failed = steel.byproducts.find((b) => b.item === 'IronIngot')!.count
    expect(failed).toBeGreaterThan(0)
    expect(iron.byproductSources.map((s) => s.id)).toEqual([steel.id])
    expect(iron.fromByproduct).toBeCloseTo(failed)
  })

  it('shows every machine in exactly one row', () => {
    expectMachinesOnce(solvePlan(plan({ targets: [{ item: 'Sol', rate: 0.25 }] }), catalog, mods))
  })

  describe('building an item separately', () => {
    const targets = [{ item: 'Sol', rate: 0.25 }]
    const solve = (separate: Separation[] = []) => solvePlan(plan({ targets, separate }), catalog, mods)
    const keptSeparations = (separate: Separation[]) =>
      pruneChoices(plan({ targets, separate }), catalog)?.separate ?? separate
    const result = solve()

    it('gathers every use under one root, keeping each machine counted once', () => {
      const r = solve([{ item: 'WorldTreeLeaf' }])
      const nodes = r.tree.flatMap(all)
      const leafRoots = r.tree.filter((n) => n.item === 'WorldTreeLeaf')
      expect(leafRoots).toHaveLength(1)
      expect(leafRoots[0].consolidated).toBe(true)
      const balance = r.balances.find((b) => b.item === 'WorldTreeLeaf')!
      expect(leafRoots[0].rate).toBeCloseTo(balance.consumed + balance.target)

      const uses = nodes.filter((n) => n.item === 'WorldTreeLeaf' && !n.consolidated)
      expect(uses.length).toBeGreaterThan(1)
      expect(uses.every((n) => n.kind === 'separate' && n.children.length === 0 && n.machines === 0)).toBe(true)
      expectMachinesOnce(r)
    })

    it('ignores items no machine makes for the plan', () => {
      const bought = result.tree.flatMap(all).find((n) => n.kind === 'bus')!
      const nodes = solve([{ item: bought.item }]).tree.flatMap(all)
      expect(nodes.some((n) => n.consolidated)).toBe(false)
      expect(nodes.some((n) => n.item === bought.item && n.kind === 'bus')).toBe(true)
      expect(keptSeparations([{ item: bought.item }])).toEqual([])
    })

    it('uses the target row itself as the root when the target is separated', () => {
      const roots = solve([{ item: 'Sol' }]).tree
      expect(roots).toHaveLength(1)
      expect(roots[0].consolidated).toBe(true)
    })

    it('is forgotten once the item leaves the plan', () => {
      const p = plan({
        targets: [{ item: 'WoodBoard', rate: 1 }],
        separate: [{ item: 'WoodBoard' }, { item: 'WorldTreeLeaf' }, { item: 'WoodBoard', anchor: 'Sol' }],
      })
      expect(pruneChoices(p, catalog)?.separate).toEqual([{ item: 'WoodBoard' }])
    })

    it('reads plans saved before anchors as the top of the plan', () => {
      expect(separationsOf(['Plank'] as never)).toEqual([{ item: 'Plank' }])
    })

    describe('with an item above it', () => {
      // Fairy Dust is made in two branches of Sol, each grinding its own Chamomile.
      const dusts = result.tree.flatMap(all).filter((n) => n.item === 'FairyDust' && n.kind === 'produce')
      const chamomileUnder = (n: TreeNode) => all(n).filter((c) => c.item === 'Chamomile' && c !== n)

      it('finds the example it needs', () => {
        expect(dusts.length).toBeGreaterThan(1)
        expect(dusts.every((d) => chamomileUnder(d).length > 0)).toBe(true)
      })

      it('gathers the uses below every anchor row into a "with" row after its children', () => {
        const sep = { item: 'Chamomile', anchor: 'FairyDust' }
        const r = solve([sep])
        const nodes = r.tree.flatMap(all)
        const anchors = nodes.filter((n) => n.item === 'FairyDust' && n.kind === 'produce')
        for (const dust of anchors) {
          const group = dust.children.at(-1)!
          expect(group.item).toBe('Chamomile')
          expect(group.separation).toEqual(sep)
          const uses = chamomileUnder(dust).filter((n) => n.kind === 'separate')
          expect(uses.length).toBeGreaterThan(0)
          expect(uses.every((n) => n.groupId === group.id && n.groupAnchor === 'FairyDust')).toBe(true)
          expect(group.rate).toBeCloseTo(uses.reduce((sum, n) => sum + n.rate, 0))
        }
        expect(keptSeparations([sep])).toEqual([sep])
        expectMachinesOnce(r)
      })

      it('can gather under just one anchor row', () => {
        const sep = { item: 'Chamomile', anchor: 'FairyDust', at: dusts[0].id }
        const r = solve([sep])
        const nodes = r.tree.flatMap(all)
        const groups = nodes.filter((n) => n.separation)
        expect(groups).toHaveLength(1)
        expect(groups[0].id).toBe(`${dusts[0].id}/with:Chamomile`)
        const other = nodes.find((n) => n.id === dusts[1].id)!
        expect(chamomileUnder(other).some((n) => n.kind === 'produce')).toBe(true)
        expectMachinesOnce(r)
      })

      it('counts machines once when one gathered row feeds another, in either order', () => {
        const powder = { item: 'ChamomilePowder', anchor: 'FairyDust' }
        const herb = { item: 'Chamomile', anchor: 'FairyDust' }
        // Jupiter uses Planks directly and through its Pulleys.
        const plank = { item: 'WoodBoard', anchor: 'Jupiter' }
        const pulley = { item: 'WoodPulley', anchor: 'Jupiter' }
        for (const seps of [
          [powder, herb],
          [herb, powder],
          [plank, pulley],
          [pulley, plank],
        ]) {
          expect(keptSeparations(seps)).toEqual(seps)
          expectMachinesOnce(solve(seps))
        }
        const jupiter = solve([plank, pulley])
          .tree.flatMap(all)
          .find((n) => n.item === 'Jupiter')!
        const planks = jupiter.children.find((c) => c.item === 'WoodBoard' && c.consolidated)!
        const uses = all(jupiter).filter((n) => n.item === 'WoodBoard' && n.kind === 'separate')
        expect(uses.length).toBeGreaterThan(1)
        expect(planks.rate).toBeCloseTo(uses.reduce((sum, n) => sum + n.rate, 0))
      })

      it('forgets a choice whose anchor sits above none of its uses', () => {
        expect(keptSeparations([{ item: 'Chamomile', anchor: 'WorldTreeLeaf' }])).toEqual([])
      })
    })
  })

  describe('building every shared item separately', () => {
    const sol = plan({ targets: [{ item: 'Sol', rate: 0.25 }] })
    // Rows recovering outputs, and the rows supplying them, are never gathered.
    const outsideRecovery = (n: TreeNode): TreeNode[] => (n.recovery ? [] : [n, ...n.children.flatMap(outsideRecovery)])
    const madeIn = (p: Plan) => {
      const counts = new Map<string, number>()
      for (const n of solvePlan(p, catalog, mods).tree.flatMap(outsideRecovery))
        if (n.run && !n.consolidated && !n.item.startsWith('@')) counts.set(n.item, (counts.get(n.item) ?? 0) + 1)
      return counts
    }

    it('gathers each item made in several rows into one, under the nearest row above them all', () => {
      expect([...madeIn(sol).values()].some((c) => c > 1)).toBe(true)
      const p = separateShared(sol, catalog)
      const seps = separationsOf(p.separate)
      expect(seps.length).toBeGreaterThan(0)
      // Every row of Sol sits under its one target, so nothing goes to the top of the plan.
      expect(seps.every((s) => s.anchor)).toBe(true)
      expect([...madeIn(p).values()].every((c) => c <= 1)).toBe(true)
      expect(pruneChoices(p, catalog)).toBeNull()
      const r = solvePlan(p, catalog, mods)
      expectBalanced(r)
      expectMachinesOnce(r)
      expect(canSeparateShared(sol, catalog)).toBe(true)
      expect(canSeparateShared(p, catalog)).toBe(false)
      expect(separateShared(p, catalog)).toBe(p)
    })

    it('gathers rows under different targets at the top of the plan', () => {
      const p = plan({ targets: [{ item: 'WorldTreeLeaf', rate: 1 }, { item: 'Sol', rate: 0.25 }] })
      expect(separationsOf(separateShared(p, catalog).separate)).toContainEqual({ item: 'WorldTreeLeaf' })
    })

    it("keeps the plan's own choices", () => {
      const p = plan({ targets: sol.targets, separate: [{ item: 'FairyDust' }] })
      expect(separationsOf(separateShared(p, catalog).separate)).toContainEqual({ item: 'FairyDust' })
    })

    it('merges back items built separately for a single use, and only those', () => {
      const shared = separateShared(sol, catalog)
      expect(mergeSingleUses(shared, catalog)).toBe(shared)
      const single = { item: 'Sol' }
      const p = { ...shared, separate: [...separationsOf(shared.separate), single] }
      expect(mergeSingleUses(p, catalog).separate).toEqual(shared.separate)
    })

    it('organizes: gathers shared items and merges single uses until neither changes anything', () => {
      const p = { ...sol, separate: [{ item: 'Sol' }] }
      const o = organize(p, catalog)
      expect(separationsOf(o.separate)).not.toContainEqual({ item: 'Sol' })
      expect([...madeIn(o).values()].every((c) => c <= 1)).toBe(true)
      expect(canSeparateShared(o, catalog)).toBe(false)
      expect(mergeSingleUses(o, catalog)).toBe(o)
      expect(organize(o, catalog)).toBe(o)
      expectBalanced(solvePlan(o, catalog, mods))
    })

    it('keeps the settings of rows it merges back, even inside other rows it merges', () => {
      const athanor = buildCatalog({ saved: [], machines: { 'recipe:Coke': 'AdvancedAthanor' }, mods, fertilizer: null })
      const p = plan({
        targets: [{ item: 'Brandy', rate: 10 }],
        machines: { 'recipe:Coke': 'AdvancedAthanor' },
        separate: [{ item: 'CokePowder' }, { item: 'Coke' }],
        rowCatalysts: { 'separate/Coke': ['Catalyst2'] },
      })
      const merged = mergeSingleUses(p, athanor)
      expect(merged.separate).toEqual([])
      expect(merged.rowCatalysts).toEqual({ '0/Brandy/CokePowder/Coke': ['Catalyst2'] })
      const machines = (x: Plan) => solvePlan(x, athanor, mods).runs.reduce((sum, r) => sum + r.machines, 0)
      expect(machines(merged)).toBeCloseTo(machines(p))
      // Gathering leaves copies set up differently apart, and carries the settings of alike ones.
      const twice = plan({ ...merged, targets: [...merged.targets, { item: 'CokePowder', rate: 5 }] })
      expect(separationsOf(separateShared(twice, athanor).separate)).not.toContainEqual({ item: 'CokePowder' })
      const alike = { ...twice, rowCatalysts: { ...twice.rowCatalysts, '1/CokePowder/Coke': ['Catalyst2'] } }
      const shared = separateShared(alike, athanor)
      expect(separationsOf(shared.separate)).toContainEqual({ item: 'CokePowder' })
      expect(shared.rowCatalysts).toEqual({ '1/CokePowder/Coke': ['Catalyst2'] })
    })
  })

  describe('keeping row settings when building separately or merging back', () => {
    const athanor = buildCatalog({ saved: [], machines: { 'recipe:Coke': 'AdvancedAthanor' }, mods, fertilizer: null })
    const coke = (targets: Plan['targets'], rowCatalysts: Plan['rowCatalysts']) =>
      plan({ targets, machines: { 'recipe:Coke': 'AdvancedAthanor' }, rowCatalysts })
    const brandy = { item: 'Brandy', rate: 10 }

    it('round-trips', () => {
      const p = coke([brandy], { '0/Brandy/CokePowder/Coke': ['Catalyst2'] })
      const apart = setSeparation(p, athanor, { item: 'CokePowder' }, true, '0/Brandy/CokePowder')
      expect(apart.rowCatalysts).toEqual({ 'separate/CokePowder/Coke': ['Catalyst2'] })
      const back = setSeparation(apart, athanor, { item: 'CokePowder' }, false)
      expect(back.separate).toEqual([])
      expect(back.rowCatalysts).toEqual(p.rowCatalysts)
    })

    it('gives a merged row’s settings to every use', () => {
      const p = setSeparation(coke([brandy, { item: 'CokePowder', rate: 5 }], { '1/CokePowder/Coke': ['Catalyst2'] }), athanor, { item: 'CokePowder' }, true)
      expect(p.rowCatalysts).toEqual({ '1/CokePowder/Coke': ['Catalyst2'] })
      expect(setSeparation(p, athanor, { item: 'CokePowder' }, false).rowCatalysts).toEqual({
        '1/CokePowder/Coke': ['Catalyst2'],
        '0/Brandy/CokePowder/Coke': ['Catalyst2'],
      })
    })

    it('moves an item built separately to another place, with its settings', () => {
      const top = { item: 'CokePowder' }
      const p = setSeparation(coke([brandy], { '0/Brandy/CokePowder/Coke': ['Catalyst2'] }), athanor, top, true)
      const withBrandy = { item: 'CokePowder', anchor: 'Brandy' }
      const moved = setSeparation(p, athanor, withBrandy, true, 'separate/CokePowder', top)
      expect(moved.separate).toEqual([withBrandy])
      expect(moved.rowCatalysts).toEqual({ '0/Brandy/with:CokePowder/Coke': ['Catalyst2'] })
      // And back to the top.
      const back = setSeparation(moved, athanor, top, true, '0/Brandy/with:CokePowder', withBrandy)
      expect(back.separate).toEqual([top])
      expect(back.rowCatalysts).toEqual(p.rowCatalysts)
    })

    it('replaces the anchor it moves from, even one on another item', () => {
      const sol = plan({ targets: [{ item: 'Sol', rate: 0.25 }], separate: [{ item: 'Chamomile', anchor: 'Sol' }] })
      const every = { item: 'Chamomile', anchor: 'FairyDust' }
      expect(setSeparation(sol, catalog, every, true).separate).toHaveLength(2)
      const moved = setSeparation(sol, catalog, every, true, undefined, { item: 'Chamomile', anchor: 'Sol' })
      expect(moved.separate).toEqual([every])
      expectBalanced(solvePlan(moved, catalog, mods))
    })

    it('gathers the settings of the row it was chosen on first', () => {
      const p = coke([brandy, brandy], { '0/Brandy/CokePowder/Coke': ['Catalyst2'], '1/Brandy/CokePowder/Coke': ['Catalyst3'] })
      for (const at of ['0', '1'])
        expect(setSeparation(p, athanor, { item: 'CokePowder' }, true, `${at}/Brandy/CokePowder`).rowCatalysts).toEqual({
          'separate/CokePowder/Coke': p.rowCatalysts![`${at}/Brandy/CokePowder/Coke`],
        })
    })
  })

  describe('choosing where to build separately', () => {
    const top = { item: 'Plank' }
    const every = { item: 'Plank', anchor: 'Jupiter' }
    const one = { item: 'Plank', anchor: 'Jupiter', at: 'a' }
    const other = { item: 'Plank', anchor: 'Jupiter', at: 'b' }

    it('keeps the top of the plan and anchors apart for an item', () => {
      expect(withSeparation([every, { item: 'Logs' }], top)).toEqual([{ item: 'Logs' }, top])
      expect(withSeparation([top], every)).toEqual([every])
    })

    it('lets single anchor rows add up, and "every" replace them', () => {
      expect(withSeparation([one], other)).toEqual([one, other])
      expect(withSeparation([one, other], every)).toEqual([every])
      expect(withSeparation([every], one)).toEqual([one])
    })

    it('keeps anchors on different items', () => {
      const saturn = { item: 'Plank', anchor: 'Saturn' }
      expect(withSeparation([saturn], every)).toEqual([saturn, every])
    })
  })
})
