import { useState, type ReactNode } from 'react'
import { ItemLabel } from '../ItemIcon'
import { AltarDetail, Exp } from '../Exp'
import { Money } from '../Money'
import { OverflowTargetForm } from '../OverflowTargetForm'
import { type DrawUse, type ItemLedger } from '../../lib/ledger'
import { itemName } from '../../lib/gameData'
import { KNOWLEDGE_ALTAR, altarsBuilt, altarsFor, altarYield, type AltarYield } from '../../lib/altar'
import { fmt, fmtMachines, fmtSeconds, wholeMachines } from '../../lib/format'
import { type ResourceUser } from '../../lib/logistics'
import { type BusUse, type MoneyLedger, type OutputRow, type OutputSource } from '../../lib/money'
import { buildingNameFor, noun } from '../../lib/plural'
import { type Modifiers } from '../../lib/upgrades'
import { isFed, sourceUse, type OverflowSource } from '../../lib/plannerView'
import { TargetLink } from './TargetLink'

/** Knowledge Altars breaking down an item, as built: "3 Knowledge Altars (2.4)". */
function altarCount(y: AltarYield, perMinute: number, mods: Modifiers): string {
  const n = altarsFor(y, perMinute, mods)
  return `${fmtMachines(n)} ${buildingNameFor(KNOWLEDGE_ALTAR, wholeMachines(n))}`
}

/** What feeding an output back does, as a verb: the plan uses it in place of the bus, or spends it. */
const FEED_VERB: Record<BusUse, string> = { plan: 'uses', money: 'spends' }

const feedButton = (feeds: BusUse[]) => (feeds.length === 1 && feeds[0] === 'money' ? 'Spend' : 'Use')

/** What the plan's rows take an item from the bus for. */
const DRAW_VERB: Record<DrawUse, string> = { burn: 'burned', spread: 'spread', use: 'used' }

/**
 * The plan's effect on the bus. Into the plan go the items its rows take from the bus (fuel to burn,
 * fertilizer to spread, and anything a row takes instead of making it), one line each, net of what
 * the plan's own output covers, and money (what the Purchase Portals spend, and coins taken in). Out
 * go the items it delivers, one row each with every source, what the plan feeds back of it and
 * what's left for the bus; items it also takes from the bus (and coins) move between the two per
 * source.
 */
export function BusPanel({
  ledgers,
  money,
  defaults,
  overflowFrom,
  onFeedback,
  onProvide,
  onCap,
  onUseSupply,
  onUseOverflow,
  onAltar,
  onShowTarget,
  onShowRow,
  altar,
}: {
  ledgers: ItemLedger[]
  money: MoneyLedger
  /** The fuel and fertilizer the plan's rows burn and spread unless their branch picks another. */
  defaults: ReactNode
  /** Per overflowing item, the rows it overflows from. */
  overflowFrom: Map<string, OverflowSource[]>
  /** Feeds a source back (the plan uses it) or not (it goes out to the bus). */
  onFeedback: (item: string, target: number | null, on: boolean) => void
  onProvide: (item: string) => void
  /** Caps what the bus carries of an item (undefined: as much as the plan takes). */
  onCap: (item: string, cap: number | undefined) => void
  /** Adds a supply target making `item` from what the plan leaves of the bus's supply of `consumes`. */
  onUseSupply: (item: string, consumes: string) => void
  /** Adds an overflow target making `item` from the overflow of `consumes`. */
  onUseOverflow: (item: string, consumes: string) => void
  /** Breaks down what's left of an item's overflow at Knowledge Altars, or stops. */
  onAltar: (item: string, on: boolean) => void
  /** Shows a target's row in the production tree. */
  onShowTarget: (index: number) => void
  /** Shows the next of these rows in the production tree. */
  onShowRow: (ids: string[]) => void
  /** The plan's upgrades when its research tier has the Knowledge Altar (outputs show their EXP), else null. */
  altar: Modifiers | null
}) {
  const margin = money.value - money.cost
  const exp = new Map(money.outputs.map((o) => [o.item, altar && altarYield(o.item, altar)]))
  const totalExp = money.outputs.reduce((t, o) => t + o.toBus * (exp.get(o.item)?.exp ?? 0), 0)
  const totalAltars = altar ? money.outputs.reduce((t, o) => t + altarsBuilt(o.item, o.toBus, altar), 0) : 0
  // What the overflow broken down at Knowledge Altars makes, and on how many.
  const altarExp = money.outputs.reduce((t, o) => t + o.altar * (exp.get(o.item)?.exp ?? 0), 0)
  const altarsUsed = altar ? money.outputs.reduce((t, o) => t + altarsBuilt(o.item, o.altar, altar), 0) : 0
  const fedBack = money.outputs.filter((o) => o.sources.some((s) => isFed(s)))
  const out = money.outputs.filter((o) => o.toBus > 0 || o.altar > 0 || o.sources.some((s) => !isFed(s)))
  // Items the plan's own fed-back output wholly covers take nothing from the bus: the fed-back
  // strip shows them. A cap the user set keeps its line, so it isn't hidden away.
  const drawing = ledgers.filter((l) => l.bus > 0 || l.short > 0 || l.covered === 0 || l.cap !== null)
  return (
    <section className="panel ledger" data-flip="bus" aria-label="Inputs and outputs">
      <div className="bus-flow">
      <div className="ledger-columns">
        <div>
          <h3>Inputs</h3>
          <div className="bus-inputs">
            {defaults}
            {drawing.length > 0 && (
              <ul className="bus-outputs">
                {drawing.map((l) => (
                  <ItemIn
                    key={l.item}
                    ledger={l}
                    onProvide={onProvide}
                    onCap={onCap}
                    onUseSupply={onUseSupply}
                    onShowTarget={onShowTarget}
                    onShowRow={onShowRow}
                  />
                ))}
              </ul>
            )}
            <MoneyIn money={money} />
          </div>
        </div>
        <div>
          <h3>Outputs</h3>
          {out.length === 0 ? (
            <p className="hint">
              {money.outputs.length === 0 ? 'Nothing: the plan delivers no items.' : 'Nothing: the plan feeds back all it makes.'}
            </p>
          ) : (
            <ul className="bus-outputs">
              {out.map((o) => (
                <OutputLine
                  key={o.item}
                  row={o}
                  overflowFrom={overflowFrom}
                  onFeedback={onFeedback}
                  onUseOverflow={onUseOverflow}
                  onAltar={onAltar}
                  onShowTarget={onShowTarget}
                  onShowRow={onShowRow}
                  exp={exp.get(o.item) ?? null}
                  mods={altar}
                />
              ))}
            </ul>
          )}
          {money.value > 0 && (
            <p className="bus-total">
              Sale value <Money copper={money.value} suffix="/min" />
              <span className="hint-inline"> at base shop prices, if it all sells · margin </span>
              <span className={`rate ${margin >= 0 ? 'positive' : 'negative'}`}>
                {margin >= 0 ? '+' : '−'}
                <Money copper={Math.abs(margin)} suffix="/min" />
              </span>
            </p>
          )}
          {totalExp > 0 && (
            <p className={`bus-total${money.value > 0 ? ' bus-total-more' : ''}`}>
              Knowledge <Exp exp={totalExp} suffix="/min" />
              <span className="hint-inline">
                {' '}
                if {altarExp > 0 ? 'the rest' : 'it all'} goes to {totalAltars} {buildingNameFor(KNOWLEDGE_ALTAR, totalAltars)} instead of the shop
              </span>
            </p>
          )}
          {altarExp > 0 && (
            <p className={`bus-total${money.value > 0 || totalExp > 0 ? ' bus-total-more' : ''}`}>
              Knowledge <Exp exp={altarExp} suffix="/min" />
              <span className="hint-inline">
                {' '}
                from {altarsUsed} {buildingNameFor(KNOWLEDGE_ALTAR, altarsUsed)} breaking down overflow
              </span>
            </p>
          )}
        </div>
      </div>
      {fedBack.length > 0 && (
        <ul className="bus-fed" aria-label="Fed back into the plan">
          {fedBack.map((o) => (
            <FedBanner
              key={o.item}
              row={o}
              overflowFrom={overflowFrom}
              onFeedback={onFeedback}
              onShowTarget={onShowTarget}
              onShowRow={onShowRow}
            />
          ))}
        </ul>
      )}
      </div>
      <BusLine />
    </section>
  )
}

/** The rows an item overflows from, as links, when these of its sources include its overflow. */
function OverflowFrom({ sources, from, onShowRow }: { sources: OutputSource[]; from: OverflowSource[]; onShowRow: (ids: string[]) => void }) {
  if (!sources.some((s) => s.target === null) || from.length === 0) return null
  return (
    <span className="hint-inline">
      from{' '}
      {from.map((f, i) => (
        <span key={f.label}>
          {i > 0 && ', '}
          <button
            className="tree-link"
            title={`Show ${f.title} in the plan${f.ids.length > 1 ? ` (${f.ids.length} places, click again for the next)` : ''}`}
            onClick={() => onShowRow(f.ids)}
          >
            {f.label}
          </button>
        </span>
      ))}
    </span>
  )
}

/** Overflow targets taking some of a source. */
function TakenBy({ source, onShowTarget }: { source: OutputSource; onShowTarget: (index: number) => void }) {
  return source.taken.map((x) => (
    <span key={x.target} className="fed-text">
      {fmt(x.amount)}/min taken by <TargetLink index={x.target} onShow={onShowTarget} />
    </span>
  ))
}

/**
 * Notches in the panel's bottom edge, which stands for the bus: it dips under what comes in from it
 * and rises under what goes out to it. Each covers its stretch of the border and draws its own.
 */
function BusLine() {
  return (
    <>
      <svg className="bus-notch bus-notch-in" viewBox="0 0 32 18" aria-hidden="true">
        <path className="bus-notch-fill" d="M0 7.5 H32 V9 L16 17 L0 9 Z" />
        <path d="M0 9 L16 17 L32 9" />
      </svg>
      <svg className="bus-notch bus-notch-out" viewBox="0 0 32 18" aria-hidden="true">
        <path className="bus-notch-fill" d="M0 10.5 H32 V9 L16 1 L0 9 Z" />
        <path d="M0 9 L16 1 L32 9" />
      </svg>
    </>
  )
}

/** A plan-wide default pick: the picker, and the rows picking something else, which can follow it. */
interface DefaultPick {
  pick: ReactNode
  /** Rows picking something else. */
  own: number
  onFollow: () => void
}

/**
 * The fuel and fertilizer the plan's machines burn and spread, and the coin its Purchasing Portals
 * are paid in, unless their row picks another, shown from the start so a plan can be set up before it needs them. Changing one keeps the rows
 * picking their own; a link switches them too.
 */
export function PlanDefaults({
  heat,
  boilers,
  nutrients,
  money,
}: {
  heat: DefaultPick
  /** What boilers burn, when the plan heats with Steam. */
  boilers: ReactNode
  nutrients: DefaultPick
  money: DefaultPick
}) {
  const line = (glyph: string, verb: string, d: DefaultPick) => (
    <span className="ledger-what">
      {glyph} {verb} {d.pick}
      {d.own > 0 && (
        <button
          className="tree-link hint-inline"
          title={`${d.own} ${noun(d.own, 'row')} picked something else on ${d.own === 1 ? 'its' : 'their'} own: switch them to this too`}
          onClick={d.onFollow}
        >
          {d.own} {noun(d.own, 'row')} {d.own === 1 ? 'differs' : 'differ'} · use it there too
        </button>
      )}
    </span>
  )
  return (
    <div className="bus-defaults" title="What the plan's machines burn, spread and pay with unless their row picks another">
      {line('🔥', 'burns', heat)}
      {boilers && (
        <span className="ledger-what" title="The solid fuel under the plan's Steam Boilers, unless a boiler row picks another">
          🔥 boilers burn {boilers}
        </span>
      )}
      {line('🌱', 'spreads', nutrients)}
      {line('🪙', 'pays with', money)}
      <span className="hint-inline">by default</span>
    </div>
  )
}

/**
 * An item the plan's rows take from the bus: how much, what for (burned, spread or used), and what
 * the plan's own fed-back output covers; a way to make it in the plan instead. The bus may carry
 * only so much of it (a cap): past that the rows fall short, and a target can use what they leave.
 */
function ItemIn({
  ledger,
  onProvide,
  onCap,
  onUseSupply,
  onShowTarget,
  onShowRow,
}: {
  ledger: ItemLedger
  onProvide: (item: string) => void
  /** Caps what the bus carries of the item (undefined: as much as the plan takes). */
  onCap: (item: string, cap: number | undefined) => void
  /** Adds a target making `item` from what the plan leaves of this item's capped supply. */
  onUseSupply: (item: string, consumes: string) => void
  onShowTarget: (index: number) => void
  onShowRow: (ids: string[]) => void
}) {
  const uses = (Object.entries(ledger.uses) as [DrawUse, number][]).filter(([, n]) => n > 0)
  const rows = ledger.rows.length
  const left = ledger.cap !== null ? Math.max(0, ledger.cap - ledger.bus) : 0
  const [using, setUsing] = useState(false)
  return (
    <li className="bus-output">
      <div className="bus-output-head">
        <span className="bus-output-item">
          <ItemLabel item={ledger.item} size={18} />
          <button
            className="tree-link hint-inline"
            title={`Show the ${noun(rows, 'row')} taking it in the plan${rows > 1 ? ' (click again for the next)' : ''}`}
            onClick={() => onShowRow(ledger.rows)}
          >
            {rows} {noun(rows, 'row')}
          </button>
        </span>
        <span className="bus-net">
          {ledger.bus > 0 ? (
            <strong>{fmt(ledger.bus)}/min in</strong>
          ) : (
            <span className="hint-inline">none in</span>
          )}
        </span>
      </div>
      <ul className="bus-output-sources">
        <li>
          <span className="ledger-what">
            <span>
              {uses.map(([use, n]) => `${fmt(n)}/min ${DRAW_VERB[use]}`).join(' · ')}
              {ledger.covered > 0 && (
                <span className="hint-inline"> · the plan&apos;s own covers {fmt(ledger.covered)}/min</span>
              )}
            </span>
            {ledger.absorbedBy !== null && (
              <span className="hint-inline">
                made by <TargetLink index={ledger.absorbedBy} onShow={onShowTarget} />
              </span>
            )}
          </span>
          {ledger.absorbedBy === null && ledger.bus > 0 && (
            <button
              className="move-button"
              title="Add a target of 0 net /min, fed back: the planner builds what the plan takes of it, after what the targets above it cover. Raise it for a surplus, or remove it to take it as an input again."
              onClick={() => onProvide(ledger.item)}
            >
              Make in plan
            </button>
          )}
        </li>
        {ledger.absorbedBy === null && (
          <li>
            <label
              className="ledger-what bus-cap"
              title="How much of it comes in: a target can use what the plan leaves of it, and the plan warns when it needs more. Empty: as much as it takes."
            >
              <span className="hint-inline">supply</span>
              <input
                type="number"
                min={0}
                step="any"
                placeholder="any"
                value={ledger.cap ?? ''}
                onChange={(e) => onCap(ledger.item, e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)))}
                aria-label={`Input supply of ${itemName(ledger.item)}, per minute`}
              />
              <span className="hint-inline">/min{ledger.cap !== null && left > 0 && ` · ${fmt(left)} left`}</span>
            </label>
            {ledger.cap !== null && left > 0 && (
              <button
                className="move-button"
                title="Add a target sized to use what the plan leaves of it"
                aria-expanded={using}
                onClick={() => setUsing((u) => !u)}
              >
                Use the rest…
              </button>
            )}
          </li>
        )}
      </ul>
      {using && (
        <OverflowTargetForm
          item={ledger.item}
          supply
          onAdd={(item) => {
            onUseSupply(item, ledger.item)
            setUsing(false)
          }}
          onCancel={() => setUsing(false)}
        />
      )}
      {ledger.overCap > 0 && (
        <p className="rate negative">
          needs {fmt(ledger.bus)}/min, {fmt(ledger.cap!)}/min comes in: {fmt(ledger.overCap)}/min short
        </p>
      )}
      {ledger.short > 0 && (
        <p className="rate negative">
          {fmt(ledger.short)}/min can&apos;t be covered: the net target&apos;s own chain uses more than it gives
        </p>
      )}
    </li>
  )
}

/**
 * Money into the plan: the coins it takes from the bus (what its Purchasing Portals are paid in, and
 * coins its recipes take), what the portals buy with them, and own coins covering some.
 */
function MoneyIn({ money }: { money: MoneyLedger }) {
  return (
    <div className="bus-input">
      <div className="ledger-head">
        <strong>🪙 Money</strong>
        <span className="ledger-balance">
          <Money copper={money.cost} suffix="/min" />
          {money.covered > 0 && (
            <>
              {' '}
              (of <Money copper={money.need} suffix="/min" />: the plan&apos;s own coins cover <Money copper={money.covered} />)
            </>
          )}
        </span>
      </div>
      {money.coins.length === 0 ? (
        <p className="hint">Nothing to pay for.</p>
      ) : (
        <ul className="money-lines">
          {money.coins.map((l) => (
            <li key={l.item}>
              <ItemLabel item={l.item} size={16} />
              <span className="hint-inline">{fmt(l.count)}/min as an input</span>
              <span className="money-cost">
                <Money copper={l.count * (l.price ?? 0)} suffix="/min" />
              </span>
            </li>
          ))}
          {money.purchases.map((l) => (
            <li key={`buy:${l.item}`} className="money-purchase">
              <span className="hint-inline">buys</span>
              <ItemLabel item={l.item} size={16} />
              <span className="hint-inline">{fmt(l.count)}/min</span>
              <span className="money-cost hint-inline">
                <Money copper={l.count * (l.price ?? 0)} suffix="/min" />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * One item leaving the plan: what goes out to the bus and what it's worth, and the sources it goes
 * out from (targets and overflow), each movable into the plan when the item can feed back; what's
 * left over of a source the plan feeds back goes out too. Overflow nothing uses is flagged: it backs
 * up the machines making it, unless the player breaks it down at Knowledge Altars.
 */
function OutputLine({
  row,
  overflowFrom,
  onFeedback,
  onUseOverflow,
  onAltar,
  onShowTarget,
  onShowRow,
  exp,
  mods,
}: {
  row: OutputRow
  overflowFrom: Map<string, OverflowSource[]>
  onFeedback: (item: string, target: number | null, on: boolean) => void
  /** Adds an overflow target making `item` from this item's overflow. */
  onUseOverflow: (item: string, consumes: string) => void
  /** Breaks down what's left of this item's overflow at Knowledge Altars, or stops. */
  onAltar: (item: string, on: boolean) => void
  onShowTarget: (index: number) => void
  /** Shows the next of these rows in the production tree. */
  onShowRow: (ids: string[]) => void
  /** What one is worth at a Knowledge Altar, when the plan has it and it gives EXP. */
  exp: AltarYield | null
  mods: Modifiers | null
}) {
  // Fed-back sources show here only for what's left over of them: their banner has the rest.
  const sources = row.sources.filter((s) => !isFed(s) || s.altar > 0 || sourceUse(s).left > 1e-9 * s.amount)
  const [using, setUsing] = useState(false)
  const overflow = row.sources.find((s) => s.target === null)
  // Overflow broken down at Knowledge Altars: how many, what for, and sending it back out instead.
  const atAltar = (s: OutputSource) =>
    s.altar > 0 && (
      <li key={`${s.target ?? 'overflow'}:altar`}>
        <span className="ledger-what">
          <span className="fed-text">↳ {fmt(s.altar)}/min broken down at</span>
          {mods ? (
            <AltarDetail item={row.item} perMinute={s.altar} mods={mods} />
          ) : (
            <span className="warn-text">Knowledge Altars, which the plan&apos;s research tier hasn&apos;t reached</span>
          )}
          {s.atSource > 0 && <span className="hint-inline">{s.atSource < s.altar ? `${fmt(s.atSource)}/min as` : 'as'} it comes out of the rows making it</span>}
        </span>
        {s.altar > s.atSource && (
          <button
            className="move-button"
            title="Stop breaking it down: it goes out as an output that nothing uses"
            onClick={() => onAltar(row.item, false)}
          >
            Send to outputs →
          </button>
        )}
      </li>
    )
  return (
    <li className="bus-output">
      <div className="bus-output-head">
        <span className="bus-output-item">
          <ItemLabel item={row.item} size={18} />
          <OverflowFrom sources={sources} from={overflowFrom.get(row.item) ?? []} onShowRow={onShowRow} />
        </span>
        <span className="bus-net">
          {row.toBus > 0 ? <strong>+{fmt(row.toBus)}/min out</strong> : <span className="hint-inline">none out</span>}
          {row.toBus > 0 &&
            (row.price !== null ? (
              <Money copper={row.toBus * row.price} suffix="/min" />
            ) : (
              <span className="hint-inline">not sold in shops</span>
            ))}
          {row.toBus > 0 && exp && mods && (
            <span
              title={
                `${fmt(exp.exp)} EXP each at a Knowledge Altar${exp.relic ? ' (a relic: Relic Knowledge adds to it)' : ''}, ` +
                `${fmtSeconds(exp.seconds)} to break one down: ${altarCount(exp, row.toBus, mods)} to take it all`
              }
            >
              <Exp exp={row.toBus * exp.exp} suffix="/min" />
            </span>
          )}
        </span>
      </div>
      <ul className="bus-output-sources">
        {sources.map((s) => {
          const { left } = sourceUse(s)
          if (isFed(s))
            return [
              left > 1e-9 * s.amount && (
                <li key={s.target ?? 'overflow'}>
                  <span className="ledger-what">
                    <span>
                      {s.target === null ? 'overflow' : <TargetLink index={s.target} onShow={onShowTarget} />} · {fmt(left)}/min
                      <span className="hint-inline"> left over after the plan {s.feeds.map((f) => FEED_VERB[f]).join(' or ')} it</span>
                    </span>
                  </span>
                </li>
              ),
              atAltar(s),
            ]
          const idle = s.target === null && left > 1e-9 * s.amount
          return [
            <li key={s.target ?? 'overflow'}>
              <span className="ledger-what">
                <span>
                  {s.target === null ? 'overflow' : <TargetLink index={s.target} onShow={onShowTarget} />} · {fmt(s.amount)}/min
                </span>
                {idle && (
                  <button
                    className="tree-link warn-text"
                    title="Made but used nowhere in the plan: route it somewhere or it backs up the machines. Click to add a target that uses it, or break it down at Knowledge Altars."
                    aria-expanded={using}
                    onClick={() => setUsing((u) => !u)}
                  >
                    ⚠ nothing uses it
                  </button>
                )}
                <TakenBy source={s} onShowTarget={onShowTarget} />
              </span>
              {s.feeds.length > 0 && (
                <button
                  className="move-button"
                  title={`Feed it back: the plan ${s.feeds.map((f) => FEED_VERB[f]).join(' or ')} it before taking any as an input`}
                  onClick={() => onFeedback(row.item, s.target, true)}
                >
                  ← {feedButton(s.feeds)} in plan
                </button>
              )}
            </li>,
            atAltar(s),
          ]
        })}
      </ul>
      {using && (
        <OverflowTargetForm
          item={row.item}
          altar={
            exp && mods && overflow
              ? {
                  detail: <AltarDetail item={row.item} perMinute={sourceUse(overflow).left} mods={mods} />,
                  onPick: () => {
                    onAltar(row.item, true)
                    setUsing(false)
                  },
                }
              : undefined
          }
          onAdd={(item) => {
            onUseOverflow(item, row.item)
            setUsing(false)
          }}
          onCancel={() => setUsing(false)}
        />
      )}
    </li>
  )
}

/**
 * An item the plan makes and feeds back in place of the bus or into its money, turned from the bus
 * back into the plan: what the plan uses or spends of it, and the sources it feeds back, each
 * movable out to the bus.
 */
function FedBanner({
  row,
  overflowFrom,
  onFeedback,
  onShowTarget,
  onShowRow,
}: {
  row: OutputRow
  overflowFrom: Map<string, OverflowSource[]>
  onFeedback: (item: string, target: number | null, on: boolean) => void
  onShowTarget: (index: number) => void
  onShowRow: (ids: string[]) => void
}) {
  const uses = (Object.entries(row.used) as [BusUse, number][]).filter(([, n]) => n > 0)
  const sources = row.sources.filter((s) => isFed(s))
  return (
    <li className="bus-banner">
      <div className="bus-output-head">
        <span className="bus-output-item">
          <ItemLabel item={row.item} size={18} />
          <OverflowFrom sources={sources} from={overflowFrom.get(row.item) ?? []} onShowRow={onShowRow} />
        </span>
        <span className="bus-net">
          {uses.length > 0 ? (
            <strong>plan {uses.map(([use, n]) => `${FEED_VERB[use]} ${fmt(n)}/min`).join(' · ')}</strong>
          ) : (
            <span className="hint-inline" title="Fed back, but the plan's need is already covered: it all goes out">
              none needed
            </span>
          )}
        </span>
      </div>
      <ul className="bus-output-sources">
        {sources.map((s) => {
          const { fed, left } = sourceUse(s)
          return (
            <li key={s.target ?? 'overflow'}>
              <span className="ledger-what">
                <span>
                  {s.target === null ? 'overflow' : <TargetLink index={s.target} onShow={onShowTarget} />} · {fmt(fed)}/min
                  {left > 1e-9 * s.amount && <span className="hint-inline"> of {fmt(s.amount)}</span>}
                </span>
                <TakenBy source={s} onShowTarget={onShowTarget} />
              </span>
              <button
                className="move-button"
                title="Stop feeding it back: it all goes out as an output"
                onClick={() => onFeedback(row.item, s.target, false)}
              >
                Send to outputs →
              </button>
            </li>
          )
        })}
      </ul>
    </li>
  )
}

/** What draws heat (per building type) or nutrients (per nursery and plant), biggest first. */
export function ResourceUsers({ title, users, unit }: { title: string; users: ResourceUser[]; unit: string }) {
  if (!users.length) return null
  return (
    <div className="resource-users">
      <h3>{title}</h3>
      <ul className="flow-list">
        {users.map((u) => (
          <li key={`${u.machine}|${u.item ?? ''}`}>
            <span className="building-name">
              <strong>{Number.isFinite(u.count) ? u.count : '∞'}</strong> {buildingNameFor(u.machine, u.count)}
              {u.item && (
                <>
                  {' '}
                  <ItemLabel item={u.item} size={16} />
                </>
              )}
            </span>
            <span className="rate">
              {fmt(u.perSecond)} {unit}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
