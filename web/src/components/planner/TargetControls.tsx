import { ItemIcon, ItemLabel } from '../ItemIcon'
import { Money } from '../Money'
import { itemName } from '../../lib/gameData'
import { licenseName, type DispatchTerms } from '../../lib/dispatch'
import { fmt } from '../../lib/format'
import type { OverflowUse, ResolvedTarget, SupplyUse } from '../../lib/solver'
import { buildingNameFor, machineNameFor, noun } from '../../lib/plural'
import { type PlanTarget } from '../../lib/types'
import { type Feeds } from '../../lib/plannerView'
import { TargetLink } from './TargetLink'

export type Unit = NonNullable<PlanTarget['unit']>

/** A target's amount and unit: items per minute, machines' worth, or net of what the plan uses. */
export function TargetAmount({
  target,
  resolved,
  feedsInto,
  absorbs,
  fedBack,
  dispatchable,
  onChange,
}: {
  target: PlanTarget
  resolved: ResolvedTarget | undefined
  /** What the item could feed back into, if anything. */
  feedsInto: Feeds
  /** This net-surplus target covers what's left of what the plan takes of its item from the bus. */
  absorbs: boolean
  /** The plan feeds the item back (so net can take some off). */
  fedBack: boolean
  /** Dispatch Portal buyers take the item (so it can be sized to their daily limit). */
  dispatchable: boolean
  onChange: (patch: Partial<PlanTarget>) => void
}) {
  const unit = target.unit ?? 'items'
  const perMachine = resolved?.perMachine ?? null
  const made = resolved?.made ?? 0
  if (unit === 'overflow' || unit === 'supply')
    return (
      <div
        className="target-amount"
        title={unit === 'overflow' ? 'As many as the overflow it takes makes' : "As many as what it takes of an input's supply makes"}
      >
        <strong>{fmt(made)}</strong> /min
      </div>
    )
  const units = (
    <select
      value={unit}
      onChange={(e) => {
        const next = e.target.value as Unit
        // Keep the same output when switching units (net counts as items; a dispatch target makes its limit's rate).
        let rate = target.rate
        if (unit === 'dispatch') rate = next === 'machines' && perMachine ? made / perMachine : made
        else if (next === 'machines' && unit !== 'machines' && perMachine) rate = made / perMachine
        else if (unit === 'machines' && next !== 'machines' && perMachine) rate = target.rate * perMachine
        onChange({ unit: next, rate: Math.round(rate * 1000) / 1000 })
      }}
      aria-label="Target unit"
    >
      <option value="items">/min</option>
      <option value="machines" disabled={!perMachine}>
        {resolved?.machineName ? machineNameFor(resolved.machineName, target.rate) : 'machines'}
      </option>
      {(feedsInto || unit === 'net') && (
        <option value="net" title="Left over after the plan takes what it needs of it, in place of the input">
          net /min
        </option>
      )}
      {(dispatchable || unit === 'dispatch') && (
        <option value="dispatch" title="As many per minute as reach the Dispatch Portal's daily limit by the end of the day">
          /min to the dispatch limit
        </option>
      )}
    </select>
  )
  if (unit === 'dispatch')
    return (
      <div className="target-amount" title="As many per minute as reach the Dispatch Portal's daily limit by the end of the day">
        <strong>{fmt(made)}</strong> {units}
      </div>
    )
  return (
    <>
      <div className="target-amount">
        <input
          type="number"
          min={0}
          step="any"
          value={target.rate}
          onChange={(e) => onChange({ rate: Math.max(0, Number(e.target.value)) })}
          aria-label="Target amount"
          title="Items per minute, or a number of machines' worth of the chosen recipe"
        />
        {units}
      </div>
      {unit === 'net' && absorbs && (
        <>
          <div className="machine-meta" title="Made in all: the net amount, plus what the plan takes of it in place of the input">
            = {fmt(made)}/min
          </div>
          <div className="machine-meta">{fmt(made - (resolved?.rate ?? 0))} for the plan itself</div>
        </>
      )}
      {unit === 'net' && !absorbs && target.item && (
        <div
          className="machine-meta"
          title={
            feedsInto !== 'bus'
              ? 'The plan takes none of it as an input: nothing to take off'
              : !fedBack
                ? 'Not fed back into the plan: nothing to take off'
                : 'A net target above covers what the plan takes of it'
          }
        >
          {feedsInto !== 'bus' ? 'not used' : !fedBack ? 'not fed back' : 'covered above'}: same as /min
        </div>
      )}
    </>
  )
}

/** Under a target's recipe: what its amount comes to, and whether the plan feeds it back. */
export function TargetNotes({
  target,
  resolved,
  feedsInto,
  fedBack,
  ownFeedback,
  onFeedback,
  sharedWith,
  onShowTarget,
  onConvert,
  overflowing,
  onUseOverflow,
  capped,
  onUseSupply,
  dispatch,
  beltSpeed,
}: {
  target: PlanTarget
  resolved: ResolvedTarget | undefined
  /** What the item could feed back into, if anything. */
  feedsInto: Feeds
  fedBack: boolean
  /** The target sets its own feedback instead of following its item's. */
  ownFeedback: boolean
  /** A dispatch target's contract terms. */
  dispatch: DispatchTerms | null
  /** Items per minute one belt carries. */
  beltSpeed: number
  onFeedback: (on: boolean) => void
  /** The earlier target whose row also builds this one's item (built separately), if any. */
  sharedWith: number | null
  onShowTarget: (index: number) => void
  /** Makes an overflow target an ordinary one. */
  onConvert: () => void
  /** Items the plan overflows, which a standard target can switch to using. */
  overflowing: string[]
  /** Makes a standard target use the plan's overflow of an item. */
  onUseOverflow: (consumes: string) => void
  /** Items the bus carries a set amount of (and what the plan leaves of it), which a standard target can switch to using. */
  capped: { item: string; cap: number; left: number }[]
  /** Makes a standard target use what the plan leaves of the bus's supply of an item. */
  onUseSupply: (consumes: string) => void
}) {
  if (!target.item) return <span className="leaf-note">Pick what to make</span>
  // What a standard target can switch to using instead of a set amount (not its own item).
  const overflow = overflowing.filter((item) => item !== target.item)
  const supply = capped.filter((c) => c.item !== target.item)
  const unit = target.unit ?? 'items'
  const perMachine = resolved?.perMachine ?? null
  return (
    <>
      {sharedWith !== null && (
        <div className="note-line">
          ⇲ built separately, in the row of <TargetLink index={sharedWith} onShow={onShowTarget} />
        </div>
      )}
      {unit === 'machines' && perMachine === null && (
        <div className="note-line">Bought or not made by a machine: set items /min.</div>
      )}
      {unit === 'dispatch' && dispatch ? (
        <DispatchTargetNote terms={dispatch} beltSpeed={beltSpeed} />
      ) : unit === 'overflow' && target.consumes ? (
        <OverflowTargetNote consumes={target.consumes} use={resolved?.overflow} onShowTarget={onShowTarget} onConvert={onConvert} />
      ) : unit === 'supply' && target.consumes ? (
        <SupplyTargetNote consumes={target.consumes} use={resolved?.supply} onShowTarget={onShowTarget} onConvert={onConvert} />
      ) : (
        (overflow.length > 0 || supply.length > 0) && (
          <select
            className="overflow-link"
            value=""
            onChange={(e) => {
              const [from, item] = e.target.value.split('|')
              if (from === 'overflow') onUseOverflow(item)
              else if (from === 'supply') onUseSupply(item)
            }}
            aria-label="Size it by an overflow or an input's supply instead"
            title="Make as many as the plan's overflow of an item, or what it leaves of an input's supply, makes, instead of a set amount"
          >
            <option value="">↪ Size it by…</option>
            {overflow.length > 0 && (
              <optgroup label="Overflow of">
                {overflow.map((item) => (
                  <option key={item} value={`overflow|${item}`}>
                    {itemName(item)}
                  </option>
                ))}
              </optgroup>
            )}
            {supply.length > 0 && (
              <optgroup label="What's left of the input">
                {supply.map((c) => (
                  <option key={c.item} value={`supply|${c.item}`}>
                    {itemName(c.item)} ({fmt(c.left)} of {fmt(c.cap)}/min left)
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        )
      )}
      {/* Always offered, so it's settled before a change makes the plan use the item. */}
      <label
        className="check target-feedback"
        title={
          feedsInto === 'money'
            ? 'Covers what the plan spends, in target order'
            : 'Rows in the plan using it take what this target makes first, in target order: rows of its own chain looping back into it, rows making it elsewhere, and the plan input of it. Not fed back, its own chain takes it in as a plan input.'
        }
      >
        <input type="checkbox" checked={fedBack} onChange={(e) => onFeedback(e.target.checked)} />
        {feedsInto === 'money' ? (
          <>Feed back into the plan&apos;s money</>
        ) : feedsInto === 'bus' ? (
          <>Feed back in place of the input</>
        ) : (
          <>Feed back into the plan</>
        )}
        {ownFeedback && <span className="hint-inline">(this target only)</span>}
      </label>
    </>
  )
}

/**
 * What an overflow target takes, or why it takes nothing: its recipes don't use the item, a target
 * above takes it all, or nothing overflows. It can become an ordinary target at any time.
 */
/**
 * What a supply target takes of the bus's capped supply, or why it takes nothing: the bus's supply
 * isn't capped, its recipes don't take the item from the bus, or a target above takes it all. It can
 * become an ordinary target at any time.
 */
function SupplyTargetNote({
  consumes,
  use,
  onShowTarget,
  onConvert,
}: {
  consumes: string
  use: SupplyUse | undefined
  onShowTarget: (index: number) => void
  onConvert: () => void
}) {
  const name = itemName(consumes)
  return (
    <>
      <div className="note-line">
        ↪ uses what&apos;s left of the input supply of <ItemLabel item={consumes} size={16} />
        {use && use.taken > 0 && <span className="hint-inline"> · {fmt(use.taken)}/min</span>}
      </div>
      {use && !use.uses ? (
        <div className="note-line warn-text">
          ⚠ Its recipes don&apos;t take {name} as an input: pick ones that do in the rows below, or it makes none.
        </div>
      ) : use && !use.capped ? (
        <div className="note-line warn-text">
          ⚠ The {name} input has no supply set: set it on its line under Inputs, or it makes none.
        </div>
      ) : use?.takenBy != null ? (
        <div className="note-line warn-text">
          ⚠ <TargetLink index={use.takenBy} onShow={onShowTarget} /> above takes all that&apos;s left.
        </div>
      ) : use && use.unused > 0 ? (
        <div className="note-line warn-text">⚠ Can&apos;t use {fmt(use.unused)}/min of it without leaving something short.</div>
      ) : (
        use?.taken === 0 && <div className="note-line warn-text">⚠ The plan&apos;s other rows take all of it.</div>
      )}
      <button
        type="button"
        className="compact-button"
        title="Keep making what it makes now as an ordinary target, whatever the supply does"
        onClick={onConvert}
      >
        Make it a standard target
      </button>
    </>
  )
}

/** Under a dispatch target: the contract its daily limit comes from, and what dispatching pays. */
function DispatchTargetNote({ terms, beltSpeed }: { terms: DispatchTerms; beltSpeed: number }) {
  const { contract } = terms
  // The portal takes one belt and has no craft time: it keeps up with whatever the belt brings.
  const portals = Math.ceil(terms.rate / beltSpeed - 1e-9)
  return (
    <>
      <div
        className="note-line"
        title={
          `Buyers take ${contract.dailyLimit} contracts a day, more with Supplier Licenses, counting every portal. ` +
          'The day lasts from 6:00 until bedtime (Potion Belt): the portal stops taking items once the limit is reached.'
        }
      >
        📦 {fmt(terms.itemsPerDay)} a day to Dispatch Portals: {fmt(terms.perDay)} {noun(terms.perDay, 'contract')} of{' '}
        {fmt(contract.count)}, over a {fmt(terms.dayMinutes)}-minute day
      </div>
      <div className="note-line">
        pays{' '}
        {terms.pay.map((p) => (
          <span key={p.coin} className="money">
            {fmt(p.count)}
            <ItemIcon item={p.coin} size={16} />
          </span>
        ))}{' '}
        a contract, <Money copper={terms.copperPerMinute} suffix="/min" /> ·{' '}
        <span title={`One belt each, at ${fmt(beltSpeed)} items/min`}>
          {portals} {buildingNameFor('Portal_Wholesaling', portals)}
        </span>
      </div>
      {terms.locked && (
        <div className="note-line warn-text">
          ⚠ Needs the {licenseName(contract.license)} license to unlock: its limit assumes you have it.
        </div>
      )}
    </>
  )
}

function OverflowTargetNote({
  consumes,
  use,
  onShowTarget,
  onConvert,
}: {
  consumes: string
  use: OverflowUse | undefined
  onShowTarget: (index: number) => void
  onConvert: () => void
}) {
  const name = itemName(consumes)
  return (
    <>
      <div className="note-line">
        ↪ uses the plan&apos;s overflow of <ItemLabel item={consumes} size={16} />
        {use && use.taken > 0 && <span className="hint-inline"> · {fmt(use.taken)}/min</span>}
      </div>
      {use && !use.uses ? (
        <div className="note-line warn-text">
          ⚠ Its recipes don&apos;t use {name}: pick ones that do in the rows below, or it makes none.
        </div>
      ) : use?.runaway ? (
        <div className="note-line warn-text" title="Each one it makes leads to at least as much overflow as it takes">
          ⚠ Runs away: its loop overflows at least as much {name} as it takes, so it would need an endless factory. It makes
          none until you change its recipes or make it a standard target.
        </div>
      ) : use && use.unused > 0 ? (
        <div className="note-line warn-text">
          ⚠ Can&apos;t use {fmt(use.unused)}/min of it without leaving something short.
        </div>
      ) : use?.takenBy != null ? (
        <div className="note-line warn-text">
          ⚠ <TargetLink index={use.takenBy} onShow={onShowTarget} /> above takes all the {name} overflow.
        </div>
      ) : (
        use?.taken === 0 && <div className="note-line warn-text">⚠ No {name} overflows in the plan now.</div>
      )}
      <button
        type="button"
        className="compact-button"
        title="Keep making what it makes now as an ordinary target, whatever the overflow does"
        onClick={onConvert}
      >
        Make it a standard target
      </button>
    </>
  )
}
