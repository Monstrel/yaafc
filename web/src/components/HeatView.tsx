import { HEAT, STEAM, itemName } from '../lib/gameData'
import { fmt, fmtMachines, wholeMachines } from '../lib/format'
import type { HeatNetwork, HeatUse } from '../lib/heatNetworks'
import type { ItemLedger } from '../lib/ledger'
import { itemsPerSlot, onBelt } from '../lib/machineRate'
import { buildingNameFor, noun } from '../lib/plural'
import { STEAM_HEAT_ID, type ProcessCatalog } from '../lib/processes'
import type { ProducerPick } from '../lib/choices'
import type { TreeNode } from '../lib/tree'
import { BUS } from '../lib/unfold'
import type { Modifiers } from '../lib/upgrades'
import { FoldedPick, SourcePick } from './FuelPick'
import { releaseScrollAnchor } from '../lib/flip'
import { ItemLabel } from './ItemIcon'
import { ProducerSelect } from './ProducerSelect'
import { reuseOption } from './rowPicks'

interface Props {
  networks: HeatNetwork[]
  /** What the plan's rows take of each item from the bus, and what its own output covers. */
  ledger: ItemLedger[]
  catalog: ProcessCatalog
  mods: Modifiers
  onProducer: (pick: ProducerPick) => void
  onResetProducer: (row: string) => void
  onReuse: (item: string, on: boolean, row?: string) => void
  separateByproducts: Map<string, string[]>
  /** Rows per item using a producer of their own. */
  rowsOf: Map<string, number>
  /** Shows a row in the production tree. */
  onShow: (row: string) => void
  /** Picks what every machine on a network burns. */
  onNetworkFuel: (net: HeatNetwork, producer: string, machine?: string) => void
  /** Picks where a network's fuel comes from, for all its machines at once. */
  onNetworkSource: (net: HeatNetwork, producer: string, machine?: string) => void
}

const cardId = (key: string) => `heat-${key}`

/** Machines and building, e.g. "343 Paradox Crucibles". */
function machinesOf(n: TreeNode): string {
  const machine = n.run?.process.machine
  const whole = wholeMachines(n.machines)
  return `${fmtMachines(n.machines)} ${machine ? buildingNameFor(machine.key, whole) : noun(whole, 'machine')}`
}

/** The plan's heat as it gets laid out: by network, each with its source and the machines on it. */
export function HeatView({ networks, ledger, ...picks }: Props) {
  if (!networks.length) return <p className="hint">Nothing in this plan needs heat.</p>
  // Which network heats each row, for a boiler's link to what heats it.
  const heatedBy = new Map(networks.flatMap((net) => net.uses.map((u) => [u.row.id, net] as const)))
  return (
    <div className="heat-view">
      <p className="hint">
        {networks.length} heat {networks.length === 1 ? 'network' : 'networks'}, biggest first: the machines heated by one
        fuel from one place. Changing what one burns, or where its fuel comes from, changes it for all of them.
      </p>
      {networks.map((net) => (
        <Network key={net.key} net={net} ledger={ledger.find((l) => l.item === net.fuel)} heatedBy={heatedBy} {...picks} />
      ))}
    </div>
  )
}

function Network({
  net,
  ledger,
  heatedBy,
  mods,
  onShow,
  onNetworkFuel,
  onNetworkSource,
  ...picks
}: Omit<Props, 'networks' | 'ledger'> & { net: HeatNetwork; ledger?: ItemLedger; heatedBy: Map<string, HeatNetwork> }) {
  const belts = onBelt(net.fuel) ? Math.ceil(net.rate / itemsPerSlot(net.fuel) / mods.beltSpeed - 1e-9) : 0
  const source = net.source
  const above = source.kind === 'row' ? heatedBy.get(source.row.id) : undefined
  const first = net.uses[0]
  return (
    <section className="heat-net" id={cardId(net.key)} data-flip={`net:${net.key}`}>
      <header className="heat-net-head">
        <div>
          <ItemLabel item={net.fuel} size={20} />
          <span className="hint-inline">{net.pads ? 'on Steam Heating Pads' : 'in furnaces'}</span>
        </div>
        <div className="heat-net-totals">
          <span>
            <strong>{fmt(net.rate)}</strong>/min
          </span>
          {belts > 1 && (
            <span>
              {belts} {noun(belts, 'belt')}
            </span>
          )}
          <span>
            <strong>{fmt(net.heat)}</strong> P/s
          </span>
        </div>
      </header>
      <div className="heat-net-source">
        burns{' '}
        <ProducerSelect
          item={HEAT}
          current={{ producer: first.heatRow.producer, process: first.heatRow.run?.process }}
          catalog={picks.catalog}
          onChange={(producer, machine) => onNetworkFuel(net, producer, machine)}
          noImport
          oneLine
          link
          // A boiler heated with Steam would only turn Steam into Steam, slower.
          exclude={net.uses.some((u) => u.row.item === STEAM) ? [STEAM_HEAT_ID] : undefined}
        />
        {(source.kind === 'bus' || source.kind === 'row') && (
          <>
            {' '}
            · {source.kind === 'row' && 'made by '}
            <ProducerSelect
              item={net.fuel}
              current={source.kind === 'bus' ? { producer: BUS } : { producer: source.row.producer, process: source.row.run?.process }}
              catalog={picks.catalog}
              onChange={(producer, machine) => onNetworkSource(net, producer, machine)}
              oneLine
              link
            />
          </>
        )}
      </div>
      <div className="heat-net-source">
        {source.kind === 'bus' ? (
          <>
            {ledger && ledger.covered > 0 && (
              <span className="hint-inline">
                the plan&apos;s own {itemName(net.fuel)} covers {fmt(ledger.covered)} of the {fmt(ledger.need)}/min its rows take
              </span>
            )}
          </>
        ) : source.kind === 'row' ? (
          <>
            {machinesOf(source.row)}{' '}
            <button type="button" className="tree-link" onClick={() => onShow(source.row.id)} title="Show the row in the production tree">
              ↗
            </button>
            {above && (
              <span className="hint-inline">
                {' '}
                · heated by{' '}
                <button
                  type="button"
                  className="tree-link"
                  onClick={() => {
                    releaseScrollAnchor()
                    document.getElementById(cardId(above.key))?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                  }}
                >
                  {itemName(above.fuel)} {above.source.kind === 'bus' ? 'as a plan input' : 'made in the plan'}
                </button>
              </span>
            )}
          </>
        ) : source.kind === 'byproduct' ? (
          'by-products of other rows'
        ) : source.kind === 'loop' ? (
          'made further up the branch (loop)'
        ) : (
          'from the plan’s overflow'
        )}
        {net.shortfall > 0 && <span className="warn-text"> · short by {fmt(net.shortfall)}/min</span>}
      </div>
      <table className="production heat-uses">
        <thead>
          <tr>
            <th>Machines</th>
            <th>Making</th>
            <th className="num">Fuel /min</th>
            <th className="num">Heat</th>
            <th>Burns</th>
            <th className="row-actions" aria-label="Show in the tree" />
          </tr>
        </thead>
        <tbody>
          {net.uses.map((u) => (
            <Use key={u.heatRow.id} flip={`net:${net.key}/${u.heatRow.id}`} use={u} onShow={onShow} {...picks} />
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Use({
  flip,
  use,
  onShow,
  catalog,
  onProducer,
  onResetProducer,
  onReuse,
  separateByproducts,
  rowsOf,
}: Omit<Props, 'networks' | 'ledger' | 'mods' | 'onNetworkFuel' | 'onNetworkSource'> & { flip: string; use: HeatUse }) {
  const { row, heatRow, fuelRow, trail } = use
  const path = trail.map((n) => itemName(n.item))
  const shown = path.length > 3 ? ['…', ...path.slice(-3)] : path
  const pickProps = { catalog, onProducer, onResetProducer }
  return (
    <tr data-flip={flip}>
      <td>{machinesOf(row)}</td>
      <td>
        <ItemLabel item={row.item} size={18} />
        {path.length > 0 && (
          <div className="note-line heat-trail" title={path.join(' › ')}>
            in {shown.join(' › ')}
          </div>
        )}
      </td>
      <td className="num">{fmt(fuelRow.rate)}</td>
      <td className="num">{fmt(use.heat)} P/s</td>
      <td className="heat-picks">
        <FoldedPick row={heatRow} host={row.item} rows={rowsOf.get(HEAT) ?? 1} carrier={false} {...pickProps} />
        {(fuelRow.kind === 'bus' || fuelRow.kind === 'produce') && (
          <div>
            <SourcePick node={fuelRow} reuse={reuseOption(fuelRow, separateByproducts, onReuse)} {...pickProps} />
          </div>
        )}
      </td>
      <td className="row-actions">
        <button type="button" className="tree-action" title="Show the row in the production tree" onClick={() => onShow(row.id)}>
          ↗
        </button>
      </td>
    </tr>
  )
}
