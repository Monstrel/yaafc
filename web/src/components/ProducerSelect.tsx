import { fmtSeconds } from '../lib/format'
import { HEAT, itemsByKey, type Item } from '../lib/gameData'
import { DEFAULT_PARADOX_INPUT, PARADOX_CRUCIBLE, processLabel, type Process, type ProcessCatalog } from '../lib/processes'
import { producerFor } from '../lib/solver'
import type { Plan } from '../lib/types'
import { ItemPicker } from './ItemPicker'

const CRUCIBLE = 'crucible'

/** The item a single-input process consumes (heat aside). */
const inputOf = (p: Process) => p.inputs.find((s) => s.item !== HEAT)?.item ?? ''

/**
 * Chooses which process makes an item (game recipe, nursery, saved ★ cauldron recipe, or buy).
 * Everything the Paradox Crucible makes — refining any item, or the fixed Oblivion ↔ Vitality
 * recipes — collapses into a single entry plus an input picker.
 */
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
  const all = catalog.byProduct.get(item) ?? []
  const isCrucible = (p: Process) => p.machine?.key === PARADOX_CRUCIBLE && p.product === item
  const options = all.filter((p) => !isCrucible(p))
  const crucible = new Map(all.filter(isCrucible).map((p) => [inputOf(p), p]))
  const current = producerFor(plan, catalog, item)
  const currentProcess = catalog.byId.get(current)
  const onCrucible = !!currentProcess && isCrucible(currentProcess)
  const crucibleDefault = (crucible.get(DEFAULT_PARADOX_INPUT) ?? [...crucible.values()][0])?.id
  const inputs = [...crucible.keys()].map((k) => itemsByKey.get(k)).filter((i): i is Item => !!i)

  return (
    <span className="producer-select">
      <select
        className={compact ? 'compact' : ''}
        value={onCrucible ? CRUCIBLE : current}
        onChange={(e) => onChange(item, e.target.value === CRUCIBLE ? crucibleDefault! : e.target.value)}
      >
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {processLabel(p, item)}
          </option>
        ))}
        {crucible.size > 0 && <option value={CRUCIBLE}>Paradox Crucible</option>}
        {!noImport && <option value="import">Buy / import</option>}
      </select>
      {onCrucible && (
        <ItemPicker
          value={inputOf(currentProcess)}
          options={inputs}
          onChange={(key) => key && crucible.has(key) && onChange(item, crucible.get(key)!.id)}
          placeholder="Crucible input…"
          detail={(i) => fmtSeconds(crucible.get(i.key)?.seconds ?? 0)}
        />
      )}
    </span>
  )
}
