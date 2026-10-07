import { chooseProducer } from './choices'
import { HEAT } from './gameData'
import type { HeatNetwork } from './heatNetworks'
import type { ProcessCatalog } from './processes'
import { setSeparation } from './separateAll'
import type { Plan } from './types'
import { BUS } from './unfold'

/** Picks what every machine on a network burns (each Heat row's own pick). */
export function setNetworkFuel(plan: Plan, catalog: ProcessCatalog, net: HeatNetwork, producer: string, machine?: string): Plan {
  return net.uses.reduce((p, u) => chooseProducer(p, catalog, { item: HEAT, producer, machine, row: u.heatRow.id }), plan)
}

/**
 * Picks where a network's fuel comes from, for all its machines at once. Off the bus, each takes
 * its own; made in the plan, one shared build makes it for all of them (built separately at the
 * top of the plan, so other rows making the fuel join it too).
 */
export function setNetworkSource(plan: Plan, catalog: ProcessCatalog, net: HeatNetwork, producer: string, machine?: string): Plan {
  const rows = net.uses.map((u) => u.fuelRow.id)
  const picked = rows.reduce((p, row) => chooseProducer(p, catalog, { item: net.fuel, producer, machine, row }), plan)
  if (producer === BUS) return picked
  const shared = net.source.kind === 'row' ? net.source.row : undefined
  // A lone row making its own stays as it is; anything more is one shared build.
  if (rows.length === 1 && !shared?.consolidated) return picked
  if (shared?.consolidated) return chooseProducer(picked, catalog, { item: net.fuel, producer, machine, row: shared.id })
  return setSeparation(picked, catalog, { item: net.fuel }, true, rows[0])
}
