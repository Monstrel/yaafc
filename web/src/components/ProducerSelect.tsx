import { processLabel, type ProcessCatalog } from '../lib/processes'
import { producerFor } from '../lib/solver'
import type { Plan } from '../lib/types'

/** Chooses which process makes an item (game recipe, nursery, saved ★ cauldron recipe, or buy). */
export function ProducerSelect({
  item,
  plan,
  catalog,
  onChange,
  compact,
  noImport,
}: {
  item: string
  plan: Plan
  catalog: ProcessCatalog
  onChange: (item: string, producer: string) => void
  compact?: boolean
  noImport?: boolean
}) {
  const options = catalog.byProduct.get(item) ?? []
  const current = producerFor(plan, catalog, item)
  return (
    <select className={compact ? 'compact' : ''} value={current} onChange={(e) => onChange(item, e.target.value)}>
      {options.map((p) => (
        <option key={p.id} value={p.id}>
          {processLabel(p, item)}
        </option>
      ))}
      {!noImport && <option value="import">Buy / import</option>}
    </select>
  )
}
