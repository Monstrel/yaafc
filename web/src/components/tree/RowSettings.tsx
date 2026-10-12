import { CATALYSTS, heightMultiplier, itemName, itemsByKey } from '../../lib/gameData'
import { fmt, fmtMachines, wholeMachines } from '../../lib/format'
import { buildingNameFor } from '../../lib/plural'
import { MAX_BANK_STACK, clampBankStack, type Process } from '../../lib/processes'
import { type TreeNode } from '../../lib/tree'
import type { Modifiers } from '../../lib/upgrades'
import { ItemIcon, ItemLabel } from '../ItemIcon'
import { NumberInput } from '../NumberInput'

/** A row's own settings: the catalysts its machines load, the height they're built at, a Bank Portal's conversion amount, and a crucible's mixed feed (with how its crucibles split up). */
export function RowSettings({
  node,
  p,
  mods,
  onCatalysts,
  onHeight,
  onStack,
  onMixedFeed,
}: {
  node: TreeNode
  /** The process the row runs. */
  p: Process
  mods: Modifiers
  onCatalysts: (row: string, catalysts: string[], inherited: string[]) => void
  onHeight: (row: string, height: number, inherited: number) => void
  onStack: (row: string, stack: number, inherited: number) => void
  onMixedFeed: (row: string, on: boolean, inherited: boolean) => void
}) {
  return (
    <>
      {/* A recovery row runs its recipe as it is: it has none of these settings. */}
      {p?.acceptsCatalysts && node.kind === 'produce' && !node.recovery && (
        <div className="catalysts" role="group" aria-label="Catalysts">
          {CATALYSTS.map((c) => {
            const on = p.catalysts.includes(c.key)
            return (
              <button
                type="button"
                key={c.key}
                className={on ? 'catalyst on' : 'catalyst'}
                aria-pressed={on}
                title={`${itemsByKey.get(c.key)?.name}: ${c.description} (${c.charges.toLocaleString()} charges)`}
                onClick={() =>
                  onCatalysts(
                    node.id,
                    on ? p.catalysts.filter((k) => k !== c.key) : [...p.catalysts, c.key],
                    node.defaultCatalysts,
                  )
                }
              >
                <ItemIcon item={c.key} size={16} />
                {c.effect[0].toUpperCase() + c.effect.slice(1)}
              </button>
            )
          })}
        </div>
      )}
      {p?.acceptsHeight && node.kind === 'produce' && !node.recovery && (
        <label
          className="build-height"
          title={`The Height its inspect panel shows. The higher up it's built, the greater its output.`}
        >
          Height
          <NumberInput
            min={0}
            step={1}
            value={p.height}
            onValue={(text) => onHeight(node.id, Math.max(0, Math.round(Number(text) || 0)), node.defaultHeight)}
            aria-label={`Height the ${p.machine?.name ?? 'machines'} are built at`}
          />
          <span className="hint-inline">
            ×{heightMultiplier(p.height).toLocaleString(undefined, { maximumFractionDigits: 3 })} output
          </span>
        </label>
      )}
      {p?.stack !== undefined && node.kind === 'produce' && !node.recovery && (
        <label
          className="bank-stack"
          title={`The Conversion Amount its panel shows: coins in each stack it puts on the belt (1–${MAX_BANK_STACK}). Bigger stacks move more coins per belt.`}
        >
          Conversion amount
          <NumberInput
            min={1}
            max={MAX_BANK_STACK}
            step={1}
            value={p.stack}
            onValue={(text) => onStack(node.id, clampBankStack(Number(text)), node.defaultStack)}
            aria-label={`Coins the ${p.machine?.name ?? 'machines'} output per belt entry`}
          />
          <span className="hint-inline">
            up to {fmt(p.stack * mods.beltSpeed)}/min per portal
          </span>
        </label>
      )}
      {node.mixable && node.kind === 'produce' && (
        <div className="catalysts" role="group" aria-label="Crucible feed">
          <button
            type="button"
            className={node.mixed ? 'catalyst on' : 'catalyst'}
            aria-pressed={!!node.mixed}
            title={`The ${node.mixable.map(itemName).join(' and ')} made below come up the same belt: the crucibles refine them too, each at its own speed, and the machines below run only for what's left`}
            onClick={() => onMixedFeed(node.id, !node.mixed, node.defaultMixed)}
          >
            {node.mixable.map((i) => (
              <ItemIcon key={i} item={i} size={16} />
            ))}
            Also refine {node.mixable.map(itemName).join(' and ')}
          </button>
        </div>
      )}
      {node.mixParts && node.mixParts.filter((m) => m.rate > 0).length > 1 && (
        <div className="note-line" title="How the crucibles split up, if each item gets crucibles of its own">
          {node.mixParts.map((m, i) => (
            <span key={m.item}>
              {i > 0 && ' · '}
              <ItemLabel item={m.item} count={m.rate} size={16} /> in {fmtMachines(m.machines)}{' '}
              {buildingNameFor(p!.machine!.key, wholeMachines(m.machines))}
            </span>
          ))}
        </div>
      )}
    </>
  )
}
