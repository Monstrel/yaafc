import { startTransition, useOptimistic } from 'react'
import { ItemLabel } from '../ItemIcon'
import { BookmarkIcon } from '../tree/icons'
import { MAX_TIER, iconUrl, itemName, machineTier, machinesByKey, tierIcon, tierName } from '../../lib/gameData'
import { fmt, fmtMachines, wholeMachines } from '../../lib/format'
import { type LogisticsCheck } from '../../lib/logistics'
import { processTitle, type ProcessCatalog } from '../../lib/processes'
import { machineNameFor, noun } from '../../lib/plural'
import { BUS, IMPORT } from '../../lib/unfold'
import { type MyDefaults } from '../../lib/types'

export function LogisticsLine({ check, label }: { check: LogisticsCheck; label: string }) {
  const fed = check.utilization > 0
  let reason: string
  const belts = (n: number) => `${n} input ${noun(n, 'belt')}`
  if (!fed) reason = `needs ${check.inputs.length} different ingredients but has only ${belts(check.beltIn)}`
  else reason = `needs ${belts(check.inputBeltsNeeded)}, has ${check.beltIn}`
  return (
    <li>
      <div>
        <strong>{label}</strong> · {check.machineName}: {reason}
        {fed && (
          <>
            {' '}
            → runs at {Math.round(check.utilization * 100)}% ·{' '}
            <span className="belt-limited">
              {fmtMachines(check.machinesNeeded)} {machineNameFor(check.machineName, wholeMachines(check.machinesNeeded))}{' '}
              instead of {fmtMachines(check.machines)}
            </span>
          </>
        )}
      </div>
      <div className="belt-breakdown">
        {check.inputs.map((f) => (
          <span key={f.item} className={f.belts > 1 ? 'multi' : ''}>
            <ItemLabel item={f.item} size={16} /> {fmt(f.perMachine)}/min ×{f.belts}
          </span>
        ))}
        {check.inputs.length > 0 && (
          <span>
            {check.inputBeltsNeeded} of {check.beltIn} {noun(check.beltIn, 'input')} at full speed
          </span>
        )}
      </div>
    </li>
  )
}

/** The research tier the plan assumes, with the tier's icon and the machines it unlocks. */
export function ResearchTier({ tier: planTier, onChange }: { tier: number; onChange: (tier: number) => void }) {
  // The slider moves at once; the plan re-renders in a transition React can interrupt mid-drag.
  const [tier, setTier] = useOptimistic(planTier)
  const icon = iconUrl(tierIcon(tier))
  const unlocks = [...machinesByKey.values()]
    .filter((m) => machineTier(m.key) === tier && !m.key.endsWith('_Sym'))
    .map((m) => m.name)
  return (
    <label className="upgrade-row research-tier">
      {icon && <img className="upgrade-icon" src={icon} width={32} height={32} alt="" />}
      <span className="upgrade-name">
        Research tier {tierName(tier)}
        <span className="upgrade-effect">{unlocks.length ? `unlocks ${unlocks.join(', ')}` : 'defaults use what it unlocks'}</span>
      </span>
      <input
        type="range"
        min={1}
        max={MAX_TIER}
        step={1}
        value={tier}
        onChange={(e) => {
          const next = Number(e.target.value)
          startTransition(() => {
            setTier(next)
            onChange(next)
          })
        }}
      />
    </label>
  )
}

/** A window with its left column drawn, filled while that column shows. */
export function SidebarIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
      style={{ verticalAlign: '-3px' }}
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M6 2.75v10.5" />
      {open && <rect x="1.75" y="2.75" width="4.25" height="10.5" rx="1.5" fill="currentColor" stroke="none" />}
    </svg>
  )
}

/** The player's saved defaults: how they like each item made, in every plan. */
export function MyDefaultsPanel({
  defaults,
  catalog,
  onForget,
}: {
  defaults: MyDefaults
  catalog: ProcessCatalog
  onForget: (item: string) => void
}) {
  const entries = Object.entries(defaults).sort(([a], [b]) => itemName(a).localeCompare(itemName(b)))
  return (
    <section className="panel">
      <h2>My defaults</h2>
      {entries.length === 0 ? (
        <p className="hint">
          Set up a row the way you like to build it, then use <BookmarkIcon /> on it to remember how it and everything
          below it is made. Every plan will start from it, and rows made your saved way show{' '}
          <span className="saved-default-icon">
            <BookmarkIcon filled />
          </span>
          .
        </p>
      ) : (
        <>
          <p className="hint">How you like these made, in every plan (a plan's own picks still come first).</p>
          <ul className="my-defaults">
            {entries.map(([item, d]) => {
              const p = catalog.byId.get(d.producer)
              const machine = d.machine ? machinesByKey.get(d.machine)?.name : p?.machine?.name
              const how =
                d.producer === IMPORT
                  ? 'bought'
                  : d.producer === BUS
                    ? 'plan input'
                    : !p
                    ? 'recipe no longer available'
                    : [
                        p.kind === 'cauldron' ? processTitle(p) : p.kind === 'bank' ? `${machine} from ${itemName(p.inputs[0].item)}` : (machine ?? p.label),
                        p.alternate ? 'alt' : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')
              return (
                <li key={item}>
                  <ItemLabel item={item} />
                  <span className="hint-inline">
                    {how}
                    {d.catalysts?.length ? ` + ${d.catalysts.map(itemName).join(', ')}` : ''}
                    {d.height ? ` · height ${d.height}` : ''}
                    {d.stack ? ` · stacks of ${d.stack}` : ''}
                    {d.mixed ? ' · with the by-products below' : ''}
                  </span>
                  <button className="icon-button" title={`Forget how you make ${itemName(item)}`} onClick={() => onForget(item)}>
                    ×
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
