import { startTransition, useEffect, useMemo, useOptimistic } from 'react'
import { ItemIcon, ItemLabel } from '../components/ItemIcon'
import { ItemPicker } from '../components/ItemPicker'
import { Money } from '../components/Money'
import { ProducerSelect, TierTag } from '../components/ProducerSelect'
import { BookmarkIcon, ProductionTree } from '../components/ProductionTree'
import { busLines, type BusLine, type BusUse } from '../lib/baseInputs'
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
  tierIcon,
  tierName,
} from '../lib/gameData'
import { fmt } from '../lib/format'
import { checkLogistics, type LogisticsCheck } from '../lib/logistics'
import type { ProcessCatalog } from '../lib/processes'
import type { PlanModel } from '../lib/planModel'
import {
  chooseProducer,
  clearBranchChoice,
  migrateCatalysts,
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

const visibleItems = items.filter((i) => !i.hidden)

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
    else if (pruneChoices(plan, catalog)) onUpdatePlan((p) => pruneChoices(p, catalog) ?? p)
  }, [plan, catalog, onUpdatePlan])
  // result.targets skips rows with no item chosen yet; line them back up with the rows.
  let resolvedIndex = 0
  const resolvedByRow = plan.targets.map((t) => (t.item ? result.targets[resolvedIndex++] : undefined))
  const bus = busLines(plan, result)
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
  const setSeparate = (s: Separation, on: boolean) =>
    onUpdatePlan((p) => {
      const list = separationsOf(p.separate)
      return { ...p, separate: on ? withSeparation(list, s) : withoutSeparation(list, s) }
    })
  const setFeedback = (resource: 'fuel' | 'fertilizer', on: boolean) =>
    onUpdatePlan((p) => ({ ...p, feedback: { ...p.feedback, [resource]: on } }))

  const purchases = result.balances.filter((b) => !b.item.startsWith('@') && b.imported > 0)
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
              {planWide(HEAT)}
            </label>
            <label className="check">
              <input type="checkbox" checked={!!plan.feedback?.fuel} onChange={(e) => setFeedback('fuel', e.target.checked)} />
              Feed back this fuel if the plan makes it
            </label>
            <label className="stacked">
              Preferred fertilizer
              {planWide(NUTRIENTS)}
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

              {beyond.length > 0 && (
                <div className="panel notice">
                  <strong>Beyond research tier {tierName(catalog.tier)}.</strong> These steps need research you haven&apos;t
                  reached yet. Pick another recipe for them, or plan ahead for the tier:
                  <ul className="flow-list">
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

              {bus.length > 0 && (
                <section className="panel">
                  <h2>From the bus</h2>
                  <ul className="flow-list base-inputs">
                    {bus.map((line) => (
                      <BusRow key={line.item} line={line} />
                    ))}
                  </ul>
                  {machineTier(STEAM_BOILER) <= catalog.tier && <BoilerRoom bus={bus} factorySpeed={mods.factorySpeed} />}
                </section>
              )}

              <section className="panel">
                <h2>Production</h2>
                <ProductionTree
                  key={plan.id}
                  planId={plan.id}
                  tree={result.tree}
                  catalog={catalog}
                  onProducer={setProducer}
                  onResetProducer={resetProducer}
                  onRemember={remember}
                  onCatalysts={setCatalysts}
                  onSeparate={setSeparate}
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

const STEAM_BOILER = 'SteamBoiler'

/**
 * The plan's heat as steam: how many Steam Boilers on each setting carry it, burning the same fuel
 * (steam carries heat without loss).
 */
function BoilerRoom({ bus, factorySpeed }: { bus: BusLine[]; factorySpeed: number }) {
  const heat = bus.flatMap((l) => l.uses).reduce((t, u) => t + (u.kind === 'fuel' ? u.supplies : 0), 0)
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
      <span className="hint-inline">burning the same fuel</span>
    </p>
  )
}

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
      <ItemLabel item={line.item} count={line.need} />
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
            {resolved?.machineName ? machineNameFor(resolved.machineName, target.rate) : 'machines'}
          </option>
        </select>
      </div>
      {target.item && (
        <div className="target-hint">
          {perMachine === null
            ? 'Bought or not made by a machine: set items /min.'
            : unit === 'machines'
              ? `= ${fmt(resolved?.rate ?? 0)} items /min (${fmt(perMachine)}/min each)`
              : `≈ ${fmt((resolved?.rate ?? 0) / perMachine)} ${machineNameFor(resolved?.machineName ?? '', (resolved?.rate ?? 0) / perMachine)} (${fmt(perMachine)}/min each)`}
        </div>
      )}
    </div>
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
          below it is made. Every plan will start from it.
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
                    : [p.kind === 'cauldron' ? (p.name ?? 'saved mix') : (machine ?? p.label), p.alternate ? 'alt' : '']
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
