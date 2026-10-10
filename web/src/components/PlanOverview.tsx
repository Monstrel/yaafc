import { fmt } from '../lib/format'
import { itemName } from '../lib/gameData'
import { usePlanSummaries, type PlanModel, type SummaryState } from '../lib/planModel'
import { useNoticeable } from '../lib/useNoticeable'
import { planTitle } from '../lib/planName'
import type { SummaryLine } from '../lib/planSummary'
import { noun } from '../lib/plural'
import type { MyDefaults, Plan, Progress, SavedRecipe } from '../lib/types'
import { Exp } from './Exp'
import { ItemLabel } from './ItemIcon'
import { Money } from './Money'
import { Spinner } from './Spinner'

/** Lines a card shows of its inputs or outputs before the rest go under "more". */
const SHOWN = 6

/**
 * Every plan at a glance, in place of the open one: what each takes in and puts out, and how many
 * machines it builds. Picking one opens it.
 */
export function PlanOverview({
  plans,
  openId,
  model,
  progress,
  saved,
  myDefaults,
  onOpen,
}: {
  plans: Plan[]
  /** The plan the planner has open. */
  openId: string
  /** The open plan's solve: its summary comes from this rather than a solve of its own. */
  model: PlanModel
  progress: Progress
  saved: SavedRecipe[]
  myDefaults: MyDefaults
  onOpen: (id: string) => void
}) {
  const states = usePlanSummaries(plans, { id: openId, model }, progress, saved, myDefaults)
  return (
    <ul className="plan-overview" aria-label="Plans">
      {plans.map((p) => (
        <PlanCard key={p.id} plan={p} state={states.get(p.id)} open={p.id === openId} onOpen={() => onOpen(p.id)} />
      ))}
    </ul>
  )
}

function PlanCard({ plan, state, open, onOpen }: { plan: Plan; state: SummaryState | undefined; open: boolean; onOpen: () => void }) {
  const s = state?.summary
  const title = planTitle(plan)
  // Only a solve that takes a noticeable while dims the card and spins: quick ones just swap in.
  const slow = useNoticeable(!state?.current)
  return (
    <li
      className={`panel plan-card${open ? ' plan-card-open' : ''}${s && slow ? ' plan-card-stale' : ''}`}
      aria-busy={!state?.current}
    >
      <div className="plan-card-head">
        <h3 className="plan-card-title">
          {/* The whole card opens the plan: this button stretches over it. */}
          <button className="plan-card-link" onClick={onOpen} title={open ? `Back to “${title}”` : `Open “${title}”`}>
            {title}
          </button>
        </h3>
        {open && <span className="pill">open</span>}
        {s && slow && <Spinner label="Solving" />}
        {s && !s.error && s.started && (
          <span className="hint-inline plan-card-size">
            {fmt(s.machines)} {noun(s.machines, 'machine')}
          </span>
        )}
      </div>
      {!s ? (
        // Holds its line while a quick solve runs, so the card doesn't grow when a slow one says so.
        <p className="hint">
          {slow ? (
            <>
              <Spinner /> Solving…
            </>
          ) : (
            ' '
          )}
        </p>
      ) : s.error ? (
        <p className="warn-text">Could not solve this plan: {s.error}</p>
      ) : !s.started ? (
        <p className="hint">No targets yet.</p>
      ) : (
        <>
          {(s.short.length > 0 || s.runaway > 0) && (
            <p className="warn-text plan-card-problems">
              {s.short.length > 0 && <>⚠ Can&apos;t be met: {s.short.map(itemName).join(', ')}</>}
              {s.short.length > 0 && s.runaway > 0 && ' · '}
              {s.runaway > 0 && <>⚠ {s.runaway === 1 ? 'An overflow loop runs' : `${s.runaway} overflow loops run`} away</>}
            </p>
          )}
          <div className="plan-card-flow">
            <div>
              <h4>Inputs</h4>
              {s.inputs.length === 0 && s.cost <= 0 ? (
                <p className="hint">Nothing</p>
              ) : (
                <ul className="plan-card-lines">
                  <Lines lines={s.inputs} />
                  {s.cost > 0 && (
                    <li>
                      <span className="plan-card-what">🪙 Money</span>
                      <span className="rate">
                        <Money copper={s.cost} suffix="/min" />
                      </span>
                    </li>
                  )}
                </ul>
              )}
            </div>
            <div>
              <h4>Outputs</h4>
              {s.outputs.length === 0 && s.exp <= 0 ? (
                <p className="hint">Nothing</p>
              ) : (
                <ul className="plan-card-lines">
                  <Lines lines={s.outputs} />
                  {s.value > 0 && (
                    <li className="plan-card-total">
                      <span className="plan-card-what hint-inline">sale value</span>
                      <span className="rate">
                        <Money copper={s.value} suffix="/min" />
                      </span>
                    </li>
                  )}
                  {s.exp > 0 && (
                    <li className="plan-card-total">
                      <span className="plan-card-what hint-inline">Knowledge Altars</span>
                      <span className="rate">
                        <Exp exp={s.exp} suffix="/min" />
                      </span>
                    </li>
                  )}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </li>
  )
}

/** Items coming in or going out, the first few with their rates, the rest counted. */
function Lines({ lines }: { lines: (SummaryLine & { idle?: boolean })[] }) {
  const more = lines.length - SHOWN
  // A lone line over the limit shows instead of a "1 more".
  const shown = more > 1 ? lines.slice(0, SHOWN) : lines
  return (
    <>
      {shown.map((l) => (
        <li key={l.item}>
          <span className="plan-card-what">
            <ItemLabel item={l.item} size={18} />
            {l.idle && (
              <span className="warn-text" title="Overflow nothing uses: it backs up the machines making it">
                ⚠
              </span>
            )}
          </span>
          <span className="rate">{fmt(l.perMinute)}/min</span>
        </li>
      ))}
      {more > 1 && (
        <li className="hint-inline" title={lines.slice(SHOWN).map((l) => itemName(l.item)).join(', ')}>
          {more} more
        </li>
      )}
    </>
  )
}
