import { useMemo } from 'react'
import { ItemIcon, ItemLabel } from '../components/ItemIcon'
import { ItemPicker } from '../components/ItemPicker'
import { Money } from '../components/Money'
import { ProducerSelect } from '../components/ProducerSelect'
import { ProductionTree } from '../components/ProductionTree'
import { busLines, type BusLine, type BusUse } from '../lib/baseInputs'
import { HEAT, NUTRIENTS, itemName, items, itemsByKey } from '../lib/gameData'
import { fmt } from '../lib/format'
import { checkLogistics, type LogisticsCheck } from '../lib/logistics'
import { usePlanModel } from '../lib/planModel'
import type { ResolvedTarget } from '../lib/solver'
import { buildTree } from '../lib/tree'
import type { Plan, PlanTarget, SavedRecipe } from '../lib/types'
import { MAX_COIN_STACK, PLANNER_UPGRADES, maxLevel } from '../lib/upgrades'

interface Props {
  plans: Plan[]
  plan: Plan
  saved: SavedRecipe[]
  onSelectPlan: (id: string) => void
  onUpdatePlan: (update: (p: Plan) => Plan) => void
  onNewPlan: () => void
  onDuplicatePlan: () => void
  onDeletePlan: () => void
}

const visibleItems = items.filter((i) => !i.hidden)

export function PlannerPage({ plans, plan, saved, onSelectPlan, onUpdatePlan, onNewPlan, onDuplicatePlan, onDeletePlan }: Props) {
  const { mods, catalog, result } = usePlanModel(plan, saved)
  const tree = useMemo(() => buildTree(result, result.targets), [result])
  // result.targets skips rows with no item chosen yet; line them back up with the rows.
  let resolvedIndex = 0
  const resolvedByRow = plan.targets.map((t) => (t.item ? result.targets[resolvedIndex++] : undefined))
  const bus = busLines(plan, result)
  const logistics = useMemo(() => checkLogistics(result.runs, mods), [result, mods])
  const usesCoins = result.runs.some(
    (r) => r.process.machine && [...r.inputs, ...r.outputs].some((x) => itemsByKey.get(x.item)?.tags.includes('Currency')),
  )
  const beltLimited = [...logistics.values()].filter((c) => c.utilization < 1 && c.machines > 0)

  const setProducer = (item: string, producer: string) =>
    onUpdatePlan((p) => ({ ...p, producers: { ...p.producers, [item]: producer } }))
  const setMachine = (processId: string, machine: string) =>
    onUpdatePlan((p) => ({ ...p, machines: { ...p.machines, [processId]: machine } }))
  const setCatalysts = (processId: string, catalysts: string[]) =>
    onUpdatePlan((p) => ({ ...p, catalysts: { ...p.catalysts, [processId]: catalysts } }))
  const setFeedback = (resource: 'fuel' | 'fertilizer', on: boolean) =>
    onUpdatePlan((p) => ({ ...p, feedback: { ...p.feedback, [resource]: on } }))

  const purchases = result.balances.filter((b) => b.producer === 'import' && !b.item.startsWith('@') && b.imported > 0)
  const surplus = result.balances.filter((b) => b.surplus > 0 && !b.item.startsWith('@'))
  const deficits = result.balances.filter((b) => b.deficit > 0)
  const heat = result.balances.find((b) => b.item === HEAT)
  const moneyPerMinute = purchases.reduce((s, b) => s + b.imported * (itemsByKey.get(b.item)?.buyPrice ?? 0), 0)

  // Machines per building type across the whole plan, with and without belt limits.
  const buildings = new Map<string, { full: number; limited: number }>()
  for (const r of result.runs)
    if (r.machines > 0 && r.process.machine) {
      const b = buildings.get(r.process.machine.name) ?? { full: 0, limited: 0 }
      b.full += r.machines
      b.limited += logistics.get(r.process.id)?.machinesNeeded ?? r.machines
      buildings.set(r.process.machine.name, b)
    }
  const totalMachines = [...buildings.values()].reduce((a, b) => a + b.limited, 0)

  return (
    <div className="page planner">
      <div className="plan-bar panel">
        <select value={plan.id} onChange={(e) => onSelectPlan(e.target.value)} aria-label="Plan">
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          className="plan-name"
          value={plan.name}
          onChange={(e) => onUpdatePlan((p) => ({ ...p, name: e.target.value }))}
          aria-label="Plan name"
        />
        <button onClick={onNewPlan}>New</button>
        <button onClick={onDuplicatePlan}>Duplicate</button>
        <button className="danger" onClick={onDeletePlan} disabled={plans.length <= 1}>
          Delete
        </button>
      </div>

      <div className="planner-layout">
        <aside className="planner-side">
          <section className="panel">
            <h2>Targets</h2>
            <p className="hint">
              Items per minute, or a number of machines' worth of the chosen recipe. The planner works out every step and
              machine needed.
            </p>
            {plan.targets.map((t, i) => (
              <TargetRow
                key={i}
                target={t}
                resolved={resolvedByRow[i]}
                onChange={(patch) =>
                  onUpdatePlan((p) => ({ ...p, targets: p.targets.map((x, j) => (j === i ? { ...x, ...patch } : x)) }))
                }
                onRemove={() => onUpdatePlan((p) => ({ ...p, targets: p.targets.filter((_, j) => j !== i) }))}
              />
            ))}
            <button onClick={() => onUpdatePlan((p) => ({ ...p, targets: [...p.targets, { item: '', rate: 10 }] }))}>
              + Add target
            </button>
          </section>

          <section className="panel">
            <h2>Fuel &amp; fertilizer</h2>
            <p className="hint">Taken from the factory bus: the planner shows how much you need instead of planning their production.</p>
            <label className="stacked">
              Preferred fuel
              <ProducerSelect item={HEAT} plan={plan} catalog={catalog} onChange={setProducer} noImport />
            </label>
            <label className="check">
              <input type="checkbox" checked={!!plan.feedback?.fuel} onChange={(e) => setFeedback('fuel', e.target.checked)} />
              Feed back this fuel if the plan makes it
            </label>
            <label className="stacked">
              Preferred fertilizer
              <ProducerSelect item={NUTRIENTS} plan={plan} catalog={catalog} onChange={setProducer} noImport />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={!!plan.feedback?.fertilizer}
                onChange={(e) => setFeedback('fertilizer', e.target.checked)}
              />
              Feed back this fertilizer if the plan makes it
            </label>
          </section>

          <section className="panel">
            <h2>Upgrades</h2>
            {PLANNER_UPGRADES.map((u) => (
              <label className="upgrade-row" key={u.key}>
                <span>{u.name}</span>
                <input
                  type="number"
                  min={0}
                  max={maxLevel(u)}
                  value={plan.upgrades[u.key] ?? 0}
                  onChange={(e) =>
                    onUpdatePlan((p) => ({
                      ...p,
                      upgrades: { ...p.upgrades, [u.key]: Math.min(maxLevel(u), Math.max(0, Number(e.target.value) || 0)) },
                    }))
                  }
                />
              </label>
            ))}
            {usesCoins && (
              <label className="upgrade-row" title="Machines and containers emit full stacks of 50; a Bank Portal can be set to 1–50">
                <span>Coin stack size (Bank Portal)</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_COIN_STACK}
                  value={plan.coinStack ?? MAX_COIN_STACK}
                  onChange={(e) =>
                    onUpdatePlan((p) => ({
                      ...p,
                      coinStack: Math.min(MAX_COIN_STACK, Math.max(1, Math.round(Number(e.target.value) || 1))),
                    }))
                  }
                />
              </label>
            )}
            <p className="hint">
              Speed ×{fmt(mods.factorySpeed)} · fuel ×{fmt(mods.fuel)} · fertilizer ×{fmt(mods.fertilizer)} · extractor/alembic
              yield ×{fmt(mods.extractor)}
            </p>
          </section>
        </aside>

        <main className="planner-main">
          {result.status !== 'ok' && <div className="panel warning">Could not solve this plan: {result.message}</div>}

          {plan.targets.length === 0 ? (
            <div className="panel empty-state">
              <h2>Add a target to start</h2>
              <p>
                Pick what you want to make and how many per minute. Every item uses its standard recipe by default; switch any
                step to one of your saved cauldron recipes (★) in the production tree.
              </p>
            </div>
          ) : (
            <>
              <section className="summary">
                <div className="stat">
                  <span className="stat-glyph">🔥</span>
                  <div>
                    <div className="stat-value">{fmt((heat?.consumed ?? 0) / 60)} P/s</div>
                    <div className="stat-label">heat</div>
                  </div>
                </div>
                <div className="stat">
                  <ItemIcon item="GoldCoin" size={32} />
                  <div>
                    <div className="stat-value">
                      <Money copper={moneyPerMinute} suffix="/min" />
                    </div>
                    <div className="stat-label">money for purchased inputs</div>
                  </div>
                </div>
                <div className="stat">
                  <span className="stat-glyph">⚙</span>
                  <div>
                    <div className="stat-value">{fmt(totalMachines)}</div>
                    <div className="stat-label">machines</div>
                  </div>
                </div>
              </section>

              {deficits.length > 0 && (
                <div className="panel warning">
                  <strong>Can't be met.</strong> The chosen recipes can't supply these items (usually a loop that consumes as much
                  as it makes). Pick a different recipe for them or buy them:
                  <ul>
                    {deficits.map((d) => (
                      <li key={d.item}>
                        <ItemLabel item={d.item} /> short by {fmt(d.deficit)}/min
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {surplus.length > 0 && (
                <div className="panel notice">
                  <strong>Overflow.</strong> These are made but nothing in the plan uses them. Route them somewhere (sell, store,
                  or use them in another recipe) or they'll back up the machines that make them:
                  <ul className="flow-list">
                    {surplus.map((b) => (
                      <li key={b.item}>
                        <ItemLabel item={b.item} />
                        <span className="rate">+{fmt(b.surplus)}/min</span>
                        <span className="hint-inline">
                          from{' '}
                          {result.runs
                            .filter((r) => r.outputs.some((s) => s.item === b.item && s.count > 0))
                            .map((r) => r.process.label)
                            .join(', ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {beltLimited.length > 0 && (
                <div className="panel notice">
                  <strong>Input belts can&apos;t keep up.</strong> At {fmt(mods.beltSpeed)} items/min per belt these machines
                  need more input belts than they have, so they run starved and you need more of them:
                  <ul className="logistics-list">
                    {beltLimited.map((c) => (
                      <LogisticsLine
                        key={c.processId}
                        check={c}
                        label={result.runs.find((r) => r.process.id === c.processId)?.process.label ?? c.processId}
                      />
                    ))}
                  </ul>
                </div>
              )}

              {bus.length > 0 && (
                <section className="panel">
                  <h2>From the bus</h2>
                  <ul className="flow-list base-inputs">
                    {bus.map((line) => (
                      <BusRow key={line.item} line={line} />
                    ))}
                  </ul>
                </section>
              )}

              <section className="panel">
                <h2>Production</h2>
                <ProductionTree
                  tree={tree}
                  plan={plan}
                  catalog={catalog}
                  onProducer={setProducer}
                  onMachine={setMachine}
                  onCatalysts={setCatalysts}
                  unused={new Map(surplus.map((b) => [b.item, b.surplus]))}
                  logistics={logistics}
                />
              </section>

              <div className="two-col">
                <section className="panel">
                  <h2>Purchased inputs</h2>
                  {purchases.length === 0 ? (
                    <p className="hint">Nothing to buy.</p>
                  ) : (
                    <>
                      <ul className="flow-list">
                        {purchases.map((b) => {
                          const price = itemsByKey.get(b.item)?.buyPrice
                          return (
                            <li key={b.item}>
                              <ItemLabel item={b.item} />
                              <span className="rate">{fmt(b.imported)}/min</span>
                              {price != null ? (
                                <span className="cost">
                                  <Money copper={b.imported * price} suffix="/min" />
                                </span>
                              ) : (
                                <span className="tag warn" title="Purchasing portals don't sell this item">
                                  not sold at portals
                                </span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                      <p className="total">
                        Total <Money copper={moneyPerMinute} suffix="/min" />
                      </p>
                    </>
                  )}
                </section>
                <section className="panel">
                  <h2>Buildings</h2>
                  <ul className="flow-list">
                    {[...buildings].map(([name, count]) => {
                      const slowed = count.limited > count.full + 1e-9
                      return (
                        <li key={name}>
                          <span className="building-name">{name}</span>
                          {slowed && <span className="hint-inline">{fmt(count.full)} at full speed →</span>}
                          <span className={slowed ? 'rate belt-limited' : 'rate'}>{fmt(count.limited)}</span>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  )
}

const USE_LABEL = { fuel: '🔥 Fuel', fertilizer: '🌱 Fertilizer' } as const

/**
 * One bus item: how much is needed (split by use when it's both fuel and fertilizer), and — with
 * feedback — how the plan's own output of it covers the need, counted once.
 */
function BusRow({ line }: { line: BusLine }) {
  const describe = (u: BusUse) => `${fmt(u.supplies)} ${u.kind === 'fuel' ? 'P/s heat' : 'nutrients/s'}`
  const single = line.uses.length === 1
  return (
    <li>
      <span className="base-kind">{line.uses.map((u) => USE_LABEL[u.kind]).join(' + ')}</span>
      <ItemLabel item={line.item} count={fmt(line.need)} />
      <span className="hint-inline">
        /min {single ? `for ${describe(line.uses[0])}` : `(${line.uses.map((u) => `${fmt(u.need)} for ${describe(u)}`).join(' + ')})`}
      </span>
      {line.net === null ? null : line.planMakes === 0 ? (
        <span className="hint-inline">plan doesn&apos;t make {itemName(line.item)}</span>
      ) : (
        <span className={`rate ${line.net >= 0 ? 'positive' : 'negative'}`}>
          {line.boughtNeed > 0 &&
            `${line.uses.filter((u) => u.feedback).map((u) => u.kind).join(' + ')} fed back, ${line.uses.filter((u) => !u.feedback).map((u) => `${fmt(u.need)} ${u.kind}`).join(' + ')} from the bus · `}
          plan makes {fmt(line.planMakes)}/min → {line.net >= 0 ? `+${fmt(line.net)} surplus` : `${fmt(-line.net)} short`}/min
        </span>
      )}
    </li>
  )
}

function TargetRow({
  target,
  resolved,
  onChange,
  onRemove,
}: {
  target: PlanTarget
  resolved: ResolvedTarget | undefined
  onChange: (patch: Partial<PlanTarget>) => void
  onRemove: () => void
}) {
  const unit = target.unit ?? 'items'
  const perMachine = resolved?.perMachine ?? null
  return (
    <div className="target">
      <div className="target-row">
        <ItemPicker value={target.item || null} options={visibleItems} onChange={(k) => onChange({ item: k ?? '' })} />
        <button className="icon-button" title="Remove target" onClick={onRemove}>
          ×
        </button>
      </div>
      <div className="target-row">
        <input
          type="number"
          min={0}
          step="any"
          value={target.rate}
          onChange={(e) => onChange({ rate: Math.max(0, Number(e.target.value)) })}
          aria-label="Target amount"
        />
        <select
          value={unit}
          onChange={(e) => {
            const next = e.target.value as 'items' | 'machines'
            // Keep the same output when switching units.
            const rate =
              perMachine && next !== unit
                ? next === 'machines'
                  ? target.rate / perMachine
                  : target.rate * perMachine
                : target.rate
            onChange({ unit: next, rate: Math.round(rate * 1000) / 1000 })
          }}
          aria-label="Target unit"
        >
          <option value="items">items /min</option>
          <option value="machines" disabled={!perMachine}>
            {resolved?.machineName ?? 'machines'}
          </option>
        </select>
      </div>
      {target.item && (
        <div className="target-hint">
          {perMachine === null
            ? 'Bought or not made by a machine: set items /min.'
            : unit === 'machines'
              ? `= ${fmt(resolved?.rate ?? 0)} items /min (${fmt(perMachine)}/min each)`
              : `≈ ${fmt((resolved?.rate ?? 0) / perMachine)} ${resolved?.machineName} (${fmt(perMachine)}/min each)`}
        </div>
      )}
    </div>
  )
}

function LogisticsLine({ check, label }: { check: LogisticsCheck; label: string }) {
  const fed = check.utilization > 0
  let reason: string
  if (!fed) reason = `needs ${check.inputs.length} different ingredients but has only ${check.beltIn} input belts`
  else reason = `needs ${check.inputBeltsNeeded} input belts, has ${check.beltIn}`
  return (
    <li>
      <div>
        <strong>{label}</strong> · {check.machineName}: {reason}
        {fed && (
          <>
            {' '}
            → runs at {Math.round(check.utilization * 100)}% ·{' '}
            <span className="belt-limited">
              {fmt(check.machinesNeeded)} machines instead of {fmt(check.machines)}
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
            {check.inputBeltsNeeded} of {check.beltIn} inputs at full speed
          </span>
        )}
      </div>
    </li>
  )
}
