import { HEAT, STEAM } from '../lib/gameData'
import { fmt } from '../lib/format'
import { STEAM_HEAT_ID, type ProcessCatalog } from '../lib/processes'
import type { ProducerPick } from '../lib/choices'
import type { TreeNode } from '../lib/tree'
import { ProducerSelect, type ReuseOption } from './ProducerSelect'
import { choosable } from './rowPicks'

interface Picks {
  catalog: ProcessCatalog
  onProducer: (pick: ProducerPick) => void
  onResetProducer: (row: string) => void
}

/**
 * What a Heat, Nutrients or Money row burns, spreads or pays with, picked for its branch (a row of
 * `host`, the item it heats, feeds or pays for); for heat, also what carries it to the machines
 * (`carrier`), unless that's already said.
 */
export function FoldedPick({
  row,
  host,
  rows,
  carrier = true,
  catalog,
  onProducer,
  onResetProducer,
}: Picks & { row: TreeNode; host: string; rows: number; carrier?: boolean }) {
  return (
    <>
      <ProducerSelect
        item={row.item}
        current={{ producer: row.producer, process: row.run?.process }}
        catalog={catalog}
        onChange={(producer, machine, everywhere) => onProducer({ item: row.item, producer, machine, row: row.id, everywhere })}
        // A boiler's fuel is its own: the plan-wide pick for heat is about Steam (see the bus panel).
        branch={{ rows: host === STEAM ? 1 : rows, own: row.ownChoice, mine: false, onReset: () => onResetProducer(row.id) }}
        noImport
        oneLine
        link
        // A boiler heated with Steam would only turn Steam into Steam, slower.
        exclude={host === STEAM ? [STEAM_HEAT_ID] : undefined}
      />
      {carrier && row.item === HEAT && (
        <span className="hint-inline" title="Furnaces and heating pads pass the heat on without loss, however many machines share one">
          {row.run?.process.id === STEAM_HEAT_ID ? 'on Steam Heating Pads' : 'in furnaces'}
        </span>
      )}
    </>
  )
}

/** Where a fuel, fertilizer or coin row gets its item: the bus, or a way to make it in the plan. */
export function SourcePick({ node, reuse, catalog, onProducer, onResetProducer }: Picks & { node: TreeNode; reuse: ReuseOption | undefined }) {
  return choosable(node, catalog, reuse) ? (
    <ProducerSelect
      item={node.item}
      current={{ producer: node.producer, process: node.run?.process }}
      catalog={catalog}
      onChange={(producer, machine, everywhere) => onProducer({ item: node.item, producer, machine, row: node.id, everywhere })}
      // What a row burns or spreads follows its branch only: plan-wide picks are for ingredients.
      branch={{ rows: 1, own: node.ownChoice, mine: node.mine, onReset: () => onResetProducer(node.id) }}
      reuse={reuse}
      oneLine
      link
    />
  ) : (
    <span className="hint-inline">plan input</span>
  )
}

/**
 * A fuel, fertilizer or coin taken off the bus, on the line where its row picks it: how much, and
 * the pick to make it in the plan instead (it gets a row of its own then).
 */
export function BusDraw(props: Picks & { node: TreeNode; reuse: ReuseOption | undefined }) {
  const { node } = props
  return (
    <span className="bus-draw" data-node-id={node.id}>
      <span className="num">{fmt(node.rate)}/min</span>
      <SourcePick {...props} />
      {node.shortfall > 0 && <span className="warn-text">short by {fmt(node.shortfall)}/min</span>}
    </span>
  )
}
