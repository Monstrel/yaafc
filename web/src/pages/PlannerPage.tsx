import { startTransition, useEffect, useMemo, useOptimistic, useState, type ReactNode } from 'react'
import { ItemIcon, ItemLabel } from '../components/ItemIcon'
import { ItemPicker } from '../components/ItemPicker'
import { Money } from '../components/Money'
import { ProducerSelect, TierTag } from '../components/ProducerSelect'
import { BookmarkIcon, ProductionTree } from '../components/ProductionTree'
import { carriers, itemFedBack, ledgers, targetFedBack, type LedgerSource, type ResourceLedger } from '../lib/ledger'
import {
  HEAT,
  MAX_TIER,
  NUTRIENTS,
  buildingsByKey,
  buyTier,
  iconUrl,
  itemName,
  items,
  itemsByKey,
  machineTier,
  machinesByKey,
  realItem,
  tierIcon,
  tierName,
} from '../lib/gameData'
import { fmt } from '../lib/format'
import { checkLogistics, type LogisticsCheck } from '../lib/logistics'
import { moneyLedger, type MoneyLine } from '../lib/money'
import { processTitle, type ProcessCatalog } from '../lib/processes'
import type { PlanModel } from '../lib/planModel'
import {
  chooseProducer,
  clearBranchChoice,
  keepDefaultInPlan,
  addProvider,
  migrateCatalysts,
  migrateFeedback,
  moveTarget,
  removeTarget,
  setItemFeedback,
  setTargetFeedback,
  pruneChoices,
  rememberSetup,
  setRowCatalysts,
  type ProducerPick,
} from '../lib/choices'
import type { PlanResult, ResolvedTarget } from '../lib/solver'
import { separationsOf, withSeparation, withoutSeparation } from '../lib/separate'
import { buildingNameFor, machineNameFor, noun } from '../lib/plural'
import { BOILER_SETTINGS, boilerHeat } from '../lib/steamBoiler'
import { IMPORT, planProducer } from '../lib/unfold'
import type { TreeNode } from '../lib/tree'
import type { MyDefaults, Plan, PlanTarget, Progress, Separation } from '../lib/types'
import { MAX_COIN_STACK, PLANNER_UPGRADES, maxLevel, upgradeLevel, type Modifiers } from '../lib/upgrades'

/** What each planner upgrade series currently does, shown under its name. */
const UPGRADE_EFFECTS: Record<string, (m: Modifiers) => string> = {
  Conveyer: (m) => `${fmt(m.beltSpeed)} items/min per belt`,
  FactorySpeed: (m) => `×${fmt(m.factorySpeed)} crafting speed`,
  AlchemySkill: (m) => `×${fmt(m.extractor)} Extractor & Alembic output`,
  FuelEfficiency: (m) => `×${fmt(m.fuel)} heat per fuel`,
  FertilizeEfficiency: (m) => `×${fmt(m.fertilizer)} nutrients per fertilizer`,
}

interface Props {
  plans: Plan[]
  plan: Plan
  model: PlanModel
  /** Upgrade levels and research tier, for every plan. */
  progress: Progress
  onProgress: (update: (p: Progress) => Progress) => void
  /** How the player likes to make items, for every plan. */
  myDefaults: MyDefaults
  onMyDefaults: (defaults: MyDefaults) => void
  onSelectPlan: (id: string) => void
  onUpdatePlan: (update: (p: Plan) => Plan) => void
  onNewPlan: () => void
  onDuplicatePlan: () => void
  onDeletePlan: () => void
}

/**
 * Items a plan can't aim for: the Automatic Cashier is only bought from the shop in person, and
 * Steam is heat on its way from boilers (counted from the fuel line, see BoilerRoom).
 */
const NOT_TARGETS = new Set(['CashRegister', 'Steam'])

const targetItems = items.filter((i) => !i.hidden && !NOT_TARGETS.has(i.key))

/** Stands in until the plan's first solve comes back. */
const UNSOLVED: PlanResult = { status: 'ok', targets: [], runs: [], balances: [], tree: [] }

export function PlannerPage({
  plans,
  plan,
  model,
  progress,
  onProgress,
  myDefaults,
  onMyDefaults,
  onSelectPlan,
  onUpdatePlan,
  onNewPlan,
  onDuplicatePlan,
  onDeletePlan,
}: Props) {
  const { mods, catalog } = model
  const result = model.result ?? UNSOLVED
  // Forget recipe, machine, catalyst, branch and build-separately picks for anything that has left
  // the plan (and build-separately picks that no longer gather anything).
  useEffect(() => {
    if (migrateCatalysts(plan, catalog)) onUpdatePlan((p) => migrateCatalysts(p, catalog) ?? p)
    else if (migrateFeedback(plan, catalog)) onUpdatePlan((p) => migrateFeedback(p, catalog) ?? p)
    else if (pruneChoices(plan, catalog)) onUpdatePlan((p) => pruneChoices(p, catalog) ?? p)
  }, [plan, catalog, onUpdatePlan])
  // result.targets skips rows with no item chosen yet; line them back up with the rows.
  let resolvedIndex = 0
  const resolvedByRow = plan.targets.map((t) => (t.item ? result.targets[resolvedIndex++] : undefined))
  const ledger = useMemo(() => ledgers(plan, catalog, result), [plan, catalog, result])
  const fuels = useMemo(() => carriers(plan, catalog, 'heat'), [plan, catalog])
  const fertilizers = useMemo(() => carriers(plan, catalog, 'fertilizer'), [plan, catalog])
  const logistics = useMemo(() => checkLogistics(result.runs, mods), [result, mods])
  const usesCoins = result.runs.some(
    (r) => r.process.machine && [...r.inputs, ...r.outputs].some((x) => itemsByKey.get(x.item)?.tags.includes('Currency')),
  )
  const beltLimited = [...logistics.values()].filter((c) => c.utilization < 1 && c.machines > 0)
  const beyond = useMemo(() => beyondTier(result.tree, catalog.tier), [result.tree, catalog.tier])

  const setProducer = (pick: ProducerPick) => onUpdatePlan((p) => chooseProducer(p, catalog, pick))
  const resetProducer = (row: string) => onUpdatePlan((p) => clearBranchChoice(p, row))
  /** Fuel or fertilizer: picked for the whole plan. */
  const planWide = (item: string) => {
    const producer = planProducer(plan, catalog, item)
    return (
      <ProducerSelect
        item={item}
        current={{ producer, process: catalog.byId.get(producer) }}
        catalog={catalog}
        onChange={(producer, machine) => setProducer({ item, producer, machine })}
        noImport
        oneLine
      />
    )
  }
  const setCatalysts = (row: string, catalysts: string[], inherited: string[]) =>
    onUpdatePlan((p) => setRowCatalysts(p, row, catalysts, inherited))
  const remember = (row: TreeNode) => {
    const next = rememberSetup(plan, catalog, result.tree, row)
    onMyDefaults(next.mine)
    onUpdatePlan(() => next.plan)
  }
  const forget = (item: string) => onMyDefaults(Object.fromEntries(Object.entries(myDefaults).filter(([k]) => k !== item)))
  /** Un-saves a default from a row: this plan stays made that way; only other plans lose it. */
  const unsave = (item: string) => {
    const saved = myDefaults[item]
    if (saved) onUpdatePlan((p) => keepDefaultInPlan(p, result.tree, item, saved))
    forget(item)
  }
  const setSeparate = (s: Separation, on: boolean) =>
    onUpdatePlan((p) => {
      const list = separationsOf(p.separate)
      return { ...p, separate: on ? withSeparation(list, s) : withoutSeparation(list, s) }
    })
  /** What a target's item could feed back into, if anything. */
  const feedsInto = (item: string) =>
    [fuels.has(item) && 'heat', fertilizers.has(item) && 'fertilizer'].filter(Boolean).join(' & ')

  const surplus = result.balances.filter((b) => b.surplus > 0 && !b.item.startsWith('@'))
  const overflowSources = useMemo(() => overflowRows(result.tree), [result.tree])
  const deficits = result.balances.filter((b) => b.deficit > 0)
  const heat = result.balances.find((b) => b.item === HEAT)
  const money = useMemo(() => moneyLedger(result, ledger), [result, ledger])

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
              machine needed. Fuel and fertilizer targets fed back cover the plan&apos;s needs in this order.
            </p>
            {plan.targets.map((t, i) => (
              <TargetRow
                key={i}
                index={i}
                target={t}
                resolved={resolvedByRow[i]}
                feedsInto={t.item ? feedsInto(t.item) : ''}
                absorbs={ledger
                  .filter((l) => l.absorbedBy === i)
                  .map((l) => l.resource)
                  .join(' & ')}
                fedBack={targetFedBack(plan, t)}
                ownFeedback={t.feedback !== undefined}
                onFeedback={(on) => onUpdatePlan((p) => setTargetFeedback(p, i, on))}
                onChange={(patch) =>
                  onUpdatePlan((p) => ({
                    ...p,
                    targets: p.targets.map((x, j) => {
                      if (j !== i) return x
                      if (patch.item === undefined || patch.item === x.item) return { ...x, ...patch }
                      // A new item follows its own feedback setting.
                      const { feedback: _, ...rest } = x
                      return { ...rest, ...patch }
                    }),
                  }))
                }
                onMove={
                  plan.targets.length > 1
                    ? (by) => onUpdatePlan((p) => moveTarget(p, i, Math.max(0, Math.min(p.targets.length - 1, i + by))))
                    : undefined
                }
                first={i === 0}
                last={i === plan.targets.length - 1}
                onRemove={() => onUpdatePlan((p) => removeTarget(p, i))}
              />
            ))}
            <button onClick={() => onUpdatePlan((p) => ({ ...p, targets: [...p.targets, { item: '', rate: 10 }] }))}>
              + Add target
            </button>
          </section>

          <section className="panel">
            <h2>Upgrades</h2>
            <p className="hint">Your game&apos;s progress: shared by every plan.</p>
            <ResearchTier
              tier={catalog.tier}
              onChange={(tier) => onProgress((p) => ({ ...p, tier: tier === MAX_TIER ? undefined : tier }))}
            />
            {PLANNER_UPGRADES.map((u) => (
              <label
                className="upgrade-row"
                key={u.key}
                title={
                  u.unlimited
                    ? `Level ${u.levels.length} is the ∞ node; each level above it is one more purchase of it` +
                      (Number.isFinite(maxLevel(u)) ? ` (up to ${maxLevel(u)})` : '')
                    : undefined
                }
              >
                {u.icon && <img className="upgrade-icon" src={iconUrl(u.icon)!} width={32} height={32} alt="" />}
                <span className="upgrade-name">
                  {u.name}
                  <span className="upgrade-effect">{UPGRADE_EFFECTS[u.key]?.(mods)}</span>
                </span>
                <input
                  type="number"
                  min={0}
                  max={Number.isFinite(maxLevel(u)) ? maxLevel(u) : undefined}
                  value={upgradeLevel(progress.upgrades, u)}
                  onChange={(e) =>
                    onProgress((p) => ({
                      ...p,
                      upgrades: { ...p.upgrades, [u.key]: upgradeLevel({ [u.key]: Number(e.target.value) || 0 }, u) },
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
          </section>
          <MyDefaultsPanel defaults={myDefaults} catalog={catalog} onForget={forget} />
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
          ) : !model.result ? (
            <div className="panel empty-state" aria-busy>
              <p>Solving…</p>
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
                      <Money copper={money.cost} suffix="/min" />
                    </div>
                    <div className="stat-label">cost: portal purchases and coins</div>
                  </div>
                </div>
                {money.value > 0 && (
                  <div className="stat">
                    <span className="stat-glyph">⚖</span>
                    <div>
                      <div className="stat-value">
                        <Money copper={money.value} suffix="/min" />
                      </div>
                      <div className="stat-label">
                        sale value ·{' '}
                        <span className={money.value >= money.cost ? 'positive' : 'negative'}>
                          {money.value >= money.cost ? '+' : '−'}
                          <Money copper={Math.abs(money.value - money.cost)} suffix="/min" />
                        </span>{' '}
                        margin
                      </div>
                    </div>
                  </div>
                )}
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
                  <ul className="flow-list notice-list">
                    {surplus.map((b) => (
                      <li key={b.item}>
                        <ItemLabel item={b.item} />
                        <span className="rate">+{fmt(b.surplus)}/min</span>
                        <span className="hint-inline">from {(overflowSources.get(b.item) ?? []).join(', ')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {beyond.length > 0 && (
                <div className="panel notice">
                  <strong>Beyond research tier {tierName(catalog.tier)}.</strong> These steps need research you haven&apos;t
                  reached yet. Pick another recipe for them, or plan ahead for the tier:
                  <ul className="flow-list notice-list">
                    {beyond.map((b) => (
                      <li key={b.item}>
                        <ItemLabel item={b.item} />
                        <TierTag tier={b.tier} />
                        <span className="hint-inline">{b.what}</span>
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
                        key={c.key}
                        check={c}
                        label={result.runs.find((r) => r.key === c.key)?.process.label ?? c.key}
                      />
                    ))}
                  </ul>
                </div>
              )}

              {ledger.some((l) => l.need > 0 || l.sources.length > 0) && (
                <div className="two-col">
                  {ledger
                    .filter((l) => l.need > 0 || l.sources.length > 0)
                    .reverse() // heat first
                    .map((l) => (
                      <LedgerPanel
                        key={l.resource}
                        ledger={l}
                        plan={plan}
                        catalog={catalog}
                        busPick={planWide(l.resource === 'heat' ? HEAT : NUTRIENTS)}
                        onItemFeedback={(item, on) => onUpdatePlan((p) => setItemFeedback(p, item, on))}
                        onProvide={(item) => onUpdatePlan((p) => addProvider(p, item))}
                      >
                        {l.resource === 'heat' && machineTier(STEAM_BOILER) <= catalog.tier && (
                          <BoilerRoom heat={l.need / 60} factorySpeed={mods.factorySpeed} />
                        )}
                      </LedgerPanel>
                    ))}
                </div>
              )}

              <section className="panel tree-panel">
                <h2>Production</h2>
                <ProductionTree
                  key={plan.id}
                  planId={plan.id}
                  tree={result.tree}
                  catalog={catalog}
                  onProducer={setProducer}
                  onResetProducer={resetProducer}
                  onRemember={remember}
                  onForget={unsave}
                  onCatalysts={setCatalysts}
                  onSeparate={setSeparate}
                  logistics={logistics}
                />
              </section>

              <div className="two-col">
                <section className="panel">
                  <h2>Costs</h2>
                  {money.purchases.length + money.coins.length === 0 ? (
                    <p className="hint">Nothing to buy.</p>
                  ) : (
                    <>
                      <ul className="flow-list">
                        {money.purchases.map((l) => (
                          <MoneyRow key={l.item} line={l} missing="not sold at portals" />
                        ))}
                        {money.coins.map((l) => (
                          <MoneyRow key={l.item} line={l} note="off the bus" />
                        ))}
                      </ul>
                      <p className="total">
                        Total <Money copper={money.cost} suffix="/min" />
                      </p>
                    </>
                  )}
                </section>
                {money.sales.length + money.unsold.length > 0 && (
                  <section className="panel">
                    <h2>Sale value</h2>
                    <p className="hint">
                      What the plan delivers is worth this at the shop&apos;s base prices (before profit upgrades), if customers
                      buy it all.
                    </p>
                    <ul className="flow-list">
                      {money.sales.map((l) => (
                        <MoneyRow key={l.item} line={l} />
                      ))}
                      {money.unsold.map((l) => (
                        <MoneyRow key={l.item} line={l} unpriced="the shop won't buy it" />
                      ))}
                    </ul>
                    {money.value > 0 && (
                      <p className="total">
                        Total <Money copper={money.value} suffix="/min" />
                      </p>
                    )}
                  </section>
                )}
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

const RESOURCE = {
  heat: { title: '🔥 Heat', unit: 'P/s', verb: 'burns' },
  fertilizer: { title: '🌱 Fertilizer', unit: 'nutrients/s', verb: 'spreads' },
} as const

const STEAM_BOILER = 'SteamBoiler'

/**
 * One bus resource: what the plan needs, the fuel or fertilizer it makes that could cover it (fed
 * back per item, or per target from the target list), and what the bus supplies for the rest, with
 * the pick of which fuel or fertilizer that is.
 */
function LedgerPanel({
  ledger,
  plan,
  catalog,
  busPick,
  onItemFeedback,
  onProvide,
  children,
}: {
  ledger: ResourceLedger
  plan: Plan
  catalog: ProcessCatalog
  /** Picks the fuel or fertilizer the bus supplies. */
  busPick: ReactNode
  onItemFeedback: (item: string, on: boolean) => void
  onProvide: (item: string) => void
  children?: ReactNode
}) {
  const { title, unit, verb } = RESOURCE[ledger.resource]
  const perSecond = (perMinute: number) => `${fmt(perMinute / 60)} ${unit}`
  const byItem = new Map<string, LedgerSource[]>()
  for (const s of ledger.sources) byItem.set(s.item, [...(byItem.get(s.item) ?? []), s])
  const source = (s: LedgerSource) => {
    const own = s.target !== null && plan.targets[s.target]?.feedback !== undefined
    return (
      <li key={`${s.target}:${s.item}`} className="ledger-source">
        <span>
          {s.target === null ? 'Overflow' : <TargetLink index={s.target} />}
          {s.target !== null && s.target === ledger.absorbedBy && ' (net)'} · {fmt(s.amount)}/min
        </span>
        <span className="hint-inline">
          {!s.fedBack
            ? 'not fed back'
            : s.used > 0
              ? `plan ${verb} ${fmt(s.used)}/min for ${perSecond(s.used * s.per)}, ${fmt(s.amount - s.used)}/min left over`
              : 'fed back, not needed'}
          {own && ' (set on the target)'}
        </span>
      </li>
    )
  }
  return (
    <section className="panel ledger">
      <h2>
        {title} <span className="hint-inline">{perSecond(ledger.need)} needed</span>
      </h2>
      <ul className="flow-list ledger-list">
        {[...byItem].map(([item, sources]) => (
          <li key={item} className="ledger-item">
            <div className="ledger-item-head">
              <ItemLabel item={item} />
              <label className="check" title={`Feed back every source of ${itemName(item)}; a target can say otherwise`}>
                <input type="checkbox" checked={itemFedBack(plan, item)} onChange={(e) => onItemFeedback(item, e.target.checked)} />
                Feed back
              </label>
            </div>
            <ul className="ledger-sources">{sources.map(source)}</ul>
          </li>
        ))}
        <li className="ledger-bus">
          <span className="base-kind">From the bus</span>
          {busPick}
          <span className="hint-inline">
            {ledger.absorbedBy !== null
              ? 'not used: a target provides it'
              : ledger.bus && ledger.bus.count > 0
                ? `${fmt(ledger.bus.count)}/min for ${perSecond(ledger.bus.count * ledger.bus.per)}`
                : ledger.need > 0
                  ? 'not needed: the plan covers it'
                  : 'nothing needed'}
          </span>
        </li>
        {ledger.short > 0 && (
          <li className="ledger-total">
            <span className="rate negative">
              {perSecond(ledger.short)} can&apos;t be covered: the net target&apos;s own chain uses more than it gives
            </span>
          </li>
        )}
        {ledger.need > 0 && ledger.covered > 0 && (
          <li className="ledger-total">
            <span className="rate positive">
              The plan covers {perSecond(ledger.covered)} of {perSecond(ledger.need)} itself
            </span>
          </li>
        )}
      </ul>
      {ledger.need > 0 &&
        (ledger.absorbedBy !== null ? (
          <p className="ledger-provider hint">
            {ledger.resource === 'heat' ? 'Heat' : 'Fertilizer'} provided by <TargetLink index={ledger.absorbedBy} /> (
            {itemName(plan.targets[ledger.absorbedBy].item)}, net)
          </p>
        ) : (
          <Provider resource={ledger.resource} plan={plan} catalog={catalog} onProvide={onProvide} />
        ))}
      {children}
    </section>
  )
}

/** Scrolls to a target in the list and pulses it. */
function TargetLink({ index }: { index: number }) {
  const show = () => {
    const el = document.getElementById(`target-${index}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove('pulse')
    void el.offsetWidth // restart the animation
    el.classList.add('pulse')
  }
  return (
    <button className="tree-link" onClick={show}>
      Target {index + 1}
    </button>
  )
}

/**
 * Sets the plan up to provide its own heat or fertilizer: adds a fed-back target at 0 net per
 * minute of a fuel the player picks (the bus fuel to start with), or of the nurseries' fertilizer.
 */
function Provider({
  resource,
  plan,
  catalog,
  onProvide,
}: {
  resource: 'heat' | 'fertilizer'
  plan: Plan
  catalog: ProcessCatalog
  onProvide: (item: string) => void
}) {
  const key = resource === 'heat' ? HEAT : NUTRIENTS
  const [picked, setPicked] = useState<string | null>(null)
  const itemOf = (producer: string) => {
    const input = catalog.byId.get(producer)?.inputs[0]?.item
    return input ? realItem(input) : null
  }
  if (picked === null)
    return (
      <p className="ledger-provider">
        <button onClick={() => setPicked(planProducer(plan, catalog, key))}>Provide from this plan…</button>
      </p>
    )
  const item = itemOf(picked)
  return (
    <div className="ledger-provider provider-form">
      {resource === 'heat' ? (
        <label className="stacked">
          Fuel to make
          <ProducerSelect
            item={HEAT}
            current={{ producer: picked, process: catalog.byId.get(picked) }}
            catalog={catalog}
            onChange={(producer) => setPicked(producer)}
            noImport
            oneLine
          />
        </label>
      ) : (
        <p className="hint">
          Nurseries grow at the speed of the fertilizer they get, so this makes {item ? itemName(item) : 'it'}. To make
          another, change the fertilizer from the bus first.
        </p>
      )}
      <p className="hint">
        Adds a target of 0 net /min, fed back: the planner builds what the plan {resource === 'heat' ? 'burns' : 'spreads'}{' '}
        after the targets above it. Raise it for a surplus, or remove it to go back to the bus.
      </p>
      <div className="provider-actions">
        <button
          className="primary"
          disabled={!item}
          onClick={() => {
            if (item) onProvide(item)
            setPicked(null)
          }}
        >
          Add {item ? itemName(item) : ''} target
        </button>
        <button onClick={() => setPicked(null)}>Cancel</button>
      </div>
    </div>
  )
}

/**
 * The plan's heat as steam: how many Steam Boilers on each setting carry it, burning the plan's
 * fuel (steam carries heat without loss).
 */
function BoilerRoom({ heat, factorySpeed }: { heat: number; factorySpeed: number }) {
  if (heat <= 0) return null
  const icon = iconUrl(buildingsByKey.get(STEAM_BOILER)?.icon)
  return (
    <p className="boiler-room">
      {icon && <img src={icon} width={20} height={20} alt="" />}
      <span>As steam:</span>
      {BOILER_SETTINGS.map((s, i) => {
        const each = boilerHeat(s, factorySpeed)
        const count = Math.ceil(heat / each - 1e-9)
        return (
          <span key={s.name} title={`${fmt(heat / each)} at ${fmt(each)} P/s each`}>
            {i > 0 && '· '}
            <strong>{count}</strong> {buildingNameFor(STEAM_BOILER, count)} on {s.name}
          </span>
        )
      })}
      <span className="hint-inline">burning the plan's fuel</span>
    </p>
  )
}

type Unit = NonNullable<PlanTarget['unit']>

function TargetRow({
  index,
  target,
  resolved,
  feedsInto,
  absorbs,
  fedBack,
  ownFeedback,
  onFeedback,
  onChange,
  onMove,
  first,
  last,
  onRemove,
}: {
  index: number
  target: PlanTarget
  resolved: ResolvedTarget | undefined
  /** What the item could feed back into ('heat', 'fertilizer', both, or '' when nothing). */
  feedsInto: string
  /** What this net-surplus target covers the rest of ('heat', 'fertilizer', both, or ''). */
  absorbs: string
  fedBack: boolean
  /** The target sets its own feedback instead of following its item's. */
  ownFeedback: boolean
  onFeedback: (on: boolean) => void
  onChange: (patch: Partial<PlanTarget>) => void
  /** Moves the target up (-1) or down (1) the list; absent with only one target. */
  onMove?: (by: number) => void
  first: boolean
  last: boolean
  onRemove: () => void
}) {
  const unit = target.unit ?? 'items'
  const perMachine = resolved?.perMachine ?? null
  const made = resolved?.made ?? 0
  return (
    <div className="target" id={`target-${index}`}>
      <div className="target-row">
        <ItemPicker value={target.item || null} options={targetItems} onChange={(k) => onChange({ item: k ?? '' })} />
        {onMove && (
          <>
            <button className="icon-button" title="Move up" aria-label="Move target up" disabled={first} onClick={() => onMove(-1)}>
              ↑
            </button>
            <button className="icon-button" title="Move down" aria-label="Move target down" disabled={last} onClick={() => onMove(1)}>
              ↓
            </button>
          </>
        )}
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
            const next = e.target.value as Unit
            // Keep the same output when switching between machines and items (net counts as items).
            const toMachines = next === 'machines' && unit !== 'machines'
            const fromMachines = unit === 'machines' && next !== 'machines'
            const rate =
              perMachine && toMachines ? made / perMachine : perMachine && fromMachines ? target.rate * perMachine : target.rate
            onChange({ unit: next, rate: Math.round(rate * 1000) / 1000 })
          }}
          aria-label="Target unit"
        >
          <option value="items">items /min</option>
          <option value="machines" disabled={!perMachine}>
            {resolved?.machineName ? machineNameFor(resolved.machineName, target.rate) : 'machines'}
          </option>
          {(feedsInto || unit === 'net') && (
            <option value="net" title="Left over after the plan burns or spreads what it needs of it">
              net /min
            </option>
          )}
        </select>
      </div>
      {target.item && (
        <div className="target-hint">
          {unit === 'net' && absorbs && (
            <>
              Makes {fmt(made)}/min, {fmt(made - (resolved?.rate ?? 0))} of it for the plan&apos;s {absorbs}.{' '}
            </>
          )}
          {perMachine === null
            ? 'Bought or not made by a machine: set items /min.'
            : unit === 'machines'
              ? `= ${fmt(made)} items /min (${fmt(perMachine)}/min each)`
              : `≈ ${fmt(made / perMachine)} ${machineNameFor(resolved?.machineName ?? '', made / perMachine)} (${fmt(perMachine)}/min each)`}
        </div>
      )}
      {unit === 'net' && !absorbs && target.item && (
        <div className="target-hint">
          {!feedsInto
            ? "Not a fuel or the nurseries' fertilizer: same as items /min."
            : !fedBack
              ? 'Not fed back: same as items /min.'
              : `A net target above covers the plan's ${feedsInto}: same as items /min.`}
        </div>
      )}
      {feedsInto && (
        <label className="check target-feedback" title="Covers the plan's own need before the bus does, in target order">
          <input type="checkbox" checked={fedBack} onChange={(e) => onFeedback(e.target.checked)} />
          Feed back into the plan&apos;s {feedsInto}
          {ownFeedback && <span className="hint-inline">(this target only)</span>}
        </label>
      )}
    </div>
  )
}

/** One item's money per minute: its count, and what that's worth (or why it has no price). */
function MoneyRow({ line, note, missing, unpriced }: { line: MoneyLine; note?: string; missing?: string; unpriced?: string }) {
  return (
    <li>
      <ItemLabel item={line.item} />
      <span className="rate">{fmt(line.count)}/min</span>
      {line.price !== null ? (
        <span className="cost">
          <Money copper={line.count * line.price} suffix="/min" />
          {note && <span className="hint-inline"> {note}</span>}
        </span>
      ) : (
        unpriced ? <span className="hint-inline">{unpriced}</span> : <span className="tag warn">{missing}</span>
      )}
    </li>
  )
}

function LogisticsLine({ check, label }: { check: LogisticsCheck; label: string }) {
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
              {fmt(check.machinesNeeded)} {machineNameFor(check.machineName, check.machinesNeeded)} instead of{' '}
              {fmt(check.machines)}
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

/**
 * Per overflowing item, the rows it overflows from, as "Athanors making Copper Powder": the
 * machines, and the item they're run for (the overflow may be their main product or a side one).
 */
function overflowRows(tree: TreeNode[]): Map<string, string[]> {
  const found = new Map<string, Set<string>>()
  const note = (item: string, n: TreeNode) => {
    const machine = n.run?.process.machine?.name
    const what = itemName(n.item)
    const from = machine ? `${machineNameFor(machine, n.machines)} making ${what}` : what
    found.set(item, (found.get(item) ?? new Set()).add(from))
  }
  const visit = (n: TreeNode) => {
    if (n.overflow > 0) note(n.item, n)
    for (const b of n.byproducts) if (b.overflow > 0) note(b.item, n)
    n.children.forEach(visit)
  }
  tree.forEach(visit)
  return new Map([...found].map(([item, from]) => [item, [...from]]))
}

/** Steps of the plan whose own recipe, machine or purchase needs research beyond `tier`. */
function beyondTier(tree: TreeNode[], tier: number): { item: string; tier: number; what: string }[] {
  const found = new Map<string, { item: string; tier: number; what: string }>()
  const visit = (n: TreeNode) => {
    const p = n.run?.process
    const made = !!p && (n.kind === 'produce' || n.kind === 'byproduct')
    const bought = n.kind === 'purchase' && itemsByKey.get(n.item)?.buyPrice != null
    const needs = made ? p.tier : bought ? buyTier(n.item) : 0
    const seen = found.get(n.item)
    if (needs > tier && (!seen || needs < seen.tier))
      found.set(n.item, { item: n.item, tier: needs, what: made ? (p.machine?.name ?? p.label) : 'bought at a portal' })
    n.children.forEach(visit)
  }
  tree.forEach(visit)
  return [...found.values()].sort((a, b) => a.tier - b.tier)
}

/** The research tier the plan assumes, with the tier's icon and the machines it unlocks. */
function ResearchTier({ tier: planTier, onChange }: { tier: number; onChange: (tier: number) => void }) {
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

/** The player's saved defaults: how they like each item made, in every plan. */
function MyDefaultsPanel({
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
                  : !p
                    ? 'recipe no longer available'
                    : [p.kind === 'cauldron' ? processTitle(p) : (machine ?? p.label), p.alternate ? 'alt' : '']
                        .filter(Boolean)
                        .join(' · ')
              return (
                <li key={item}>
                  <ItemLabel item={item} />
                  <span className="hint-inline">
                    {how}
                    {d.catalysts?.length ? ` + ${d.catalysts.map(itemName).join(', ')}` : ''}
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
