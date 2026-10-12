import {
  addOverflowTarget,
  chooseProducer,
  clearBranchChoice,
  keepDefaultInPlan,
  rememberSetup,
  setAltar,
  setBuilt,
  setLoopSource,
  setMixedFeed,
  setOutputAltar,
  setRoundUp,
  setRowCatalysts,
  setRowHeight,
  setRowStack,
  type LoopSourceChoice,
  type ProducerPick,
} from '../../lib/choices'
import { itemName } from '../../lib/gameData'
import { setNetworkFuel, setNetworkSource } from '../../lib/heatChoices'
import type { HeatNetwork } from '../../lib/heatNetworks'
import type { ProcessCatalog } from '../../lib/processes'
import { mergeSingleUses, separateShared, setSeparation } from '../../lib/separateAll'
import type { TreeNode } from '../../lib/tree'
import type { MyDefaults, Plan, Separation, Unitizing } from '../../lib/types'
import { rowItem } from '../../lib/unfold'
import { setUnits } from '../../lib/units'
import { useStable } from '../../lib/useStable'

/** A tree row's name in undo's list. */
export const rowName = (row: string) => itemName(rowItem(row))

export interface PlanActionsInput {
  plan: Plan
  catalog: ProcessCatalog
  /** The plan's solved tree. */
  tree: TreeNode[]
  myDefaults: MyDefaults
  /** Each change says what it does, for undo. */
  onUpdatePlan: (label: string | null, update: (p: Plan) => Plan) => void
  onMyDefaults: (label: string, defaults: MyDefaults) => void
  /** Shows a target's row (by index), as one is added. */
  showTarget: (index: number) => void
}

/**
 * What the production tree's rows change in the plan (and the player's defaults), each with the
 * label undo lists it by. They keep their identity across renders (calling the latest plan's), so
 * rows whose own props didn't change aren't drawn again.
 */
export function usePlanActions({ plan, catalog, tree, myDefaults, onUpdatePlan, onMyDefaults, showTarget }: PlanActionsInput) {
  const forget = (item: string, label = `Forget default for ${itemName(item)}`) =>
    onMyDefaults(label, Object.fromEntries(Object.entries(myDefaults).filter(([k]) => k !== item)))
  return {
    setProducer: useStable((pick: ProducerPick) =>
      onUpdatePlan(`Change how ${itemName(pick.item)} is made`, (p) => chooseProducer(p, catalog, pick)),
    ),
    setNetworkBurn: useStable((net: HeatNetwork, producer: string, machine?: string) =>
      onUpdatePlan(`Change what a ${itemName(net.fuel)} heat network burns`, (p) => setNetworkFuel(p, catalog, net, producer, machine)),
    ),
    setNetworkSupply: useStable((net: HeatNetwork, producer: string, machine?: string) =>
      onUpdatePlan(`Change where a ${itemName(net.fuel)} heat network gets its fuel`, (p) =>
        setNetworkSource(p, catalog, net, producer, machine),
      ),
    ),
    resetProducer: useStable((row: string) => onUpdatePlan(`Reset the pick for ${rowName(row)}`, (p) => clearBranchChoice(p, row))),
    outputAltar: useStable((row: string, item: string, on: boolean) =>
      onUpdatePlan(
        `${on ? 'Send' : 'Stop sending'} ${rowName(row)}'s ${itemName(item)} ${on ? 'to' : 'from'} Knowledge Altars`,
        (p) => setOutputAltar(p, row, item, on),
      ),
    ),
    loopSource: useStable((row: TreeNode, source: LoopSourceChoice) =>
      onUpdatePlan(
        source === 'fed' ? `Feed back the ${itemName(row.item)} target` : `Take ${itemName(row.item)} in as a plan input`,
        (p) => setLoopSource(p, catalog, row, source, tree),
      ),
    ),
    setCatalysts: useStable((row: string, catalysts: string[], inherited: string[]) =>
      onUpdatePlan(`Change catalysts for ${rowName(row)}`, (p) => setRowCatalysts(p, row, catalysts, inherited)),
    ),
    setHeight: useStable((row: string, height: number, inherited: number) =>
      onUpdatePlan(`Change height for ${rowName(row)}`, (p) => setRowHeight(p, row, height, inherited)),
    ),
    setStack: useStable((row: string, stack: number, inherited: number) =>
      onUpdatePlan(`Change stacking for ${rowName(row)}`, (p) => setRowStack(p, row, stack, inherited)),
    ),
    remember: useStable((row: TreeNode) => {
      const next = rememberSetup(plan, catalog, tree, row)
      const label = `Save default for ${itemName(row.item)}`
      onMyDefaults(label, next.mine)
      onUpdatePlan(label, () => next.plan)
    }),
    forget: useStable(forget),
    /** Un-saves a default from a row: this plan stays made that way; only other plans lose it. */
    unsave: useStable((item: string) => {
      const saved = myDefaults[item]
      const label = `Unsave default for ${itemName(item)}`
      if (saved) onUpdatePlan(label, (p) => keepDefaultInPlan(p, tree, item, saved))
      forget(item, label)
    }),
    // Choosing by hand where an item is built turns auto organize off, so it doesn't undo the choice.
    setSeparate: useStable((s: Separation, on: boolean, from?: string, replacing?: Separation) =>
      onUpdatePlan(
        `${on ? 'Build' : 'Stop building'} ${itemName(s.item)} separately${plan.autoOrganize ? ' (auto organize off)' : ''}`,
        (p) => ({ ...setSeparation(p, catalog, s, on, from, replacing), autoOrganize: undefined }),
      ),
    ),
    setAutoOrganize: useStable((on: boolean) =>
      onUpdatePlan(`Turn ${on ? 'on' : 'off'} auto organize`, (p) => ({ ...p, autoOrganize: on || undefined })),
    ),
    separateShared: useStable(() => onUpdatePlan('Build shared items separately', (p) => separateShared(p, catalog))),
    mergeSingles: useStable(() => onUpdatePlan('Merge single-use builds', (p) => mergeSingleUses(p, catalog))),
    takeOverflow: useStable((item: string, consumes: string) => {
      onUpdatePlan(`Use overflow of ${itemName(item)}`, (p) => addOverflowTarget(p, item, consumes))
      showTarget(plan.targets.length)
    }),
    altarOverflow: useStable((item: string, on: boolean) =>
      onUpdatePlan(`${on ? 'Break down' : 'Stop breaking down'} ${itemName(item)} overflow at Knowledge Altars`, (p) =>
        setAltar(p, item, on),
      ),
    ),
    roundUp: useStable((row: string, on: boolean) =>
      onUpdatePlan(`${on ? 'Round up' : 'Stop rounding up'} ${rowName(row)}`, (p) => setRoundUp(p, row, on)),
    ),
    mixedFeed: useStable((row: string, on: boolean, inherited: boolean) =>
      onUpdatePlan(`${on ? 'Mix by-products into' : 'Stop mixing by-products into'} ${rowName(row)}`, (p) =>
        setMixedFeed(p, row, on, inherited),
      ),
    ),
    units: useStable((row: string, unit: Unitizing | null) =>
      onUpdatePlan(`Build ${rowName(row)} ${unit ? 'in units' : 'as one line'}`, (p) => setUnits(p, row, unit)),
    ),
    built: useStable((rows: string[], on: boolean) =>
      onUpdatePlan(`${on ? 'Check off' : 'Uncheck'} ${rows.length === 1 ? rowName(rows[0]) : `${rows.length} rows`}`, (p) =>
        setBuilt(p, rows, on),
      ),
    ),
  }
}
