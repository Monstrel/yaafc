import { startTransition, useEffect, useMemo, useOptimistic, useState, type ReactNode } from 'react'
import { ItemIcon, ItemLabel } from '../components/ItemIcon'
import { ItemPicker } from '../components/ItemPicker'
import { Money } from '../components/Money'
import { ProducerSelect, TierTag } from '../components/ProducerSelect'
import { BookmarkIcon, ProductionTree, type TargetSlot } from '../components/ProductionTree'
import { carriers, ledgers, targetFedBack, type Resource, type ResourceLedger } from '../lib/ledger'
import {
  HEAT,
  MAX_TIER,
  NUTRIENTS,
  buildingsByKey,
  buyTier,
  coinValue,
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
import { buildingCounts, checkLogistics, resourceUsers, type LogisticsCheck, type ResourceUser } from '../lib/logistics'
import { fedOverflow, moneyLedger, type BusUse, type MoneyLedger, type OutputRow } from '../lib/money'
import { processTitle, type ProcessCatalog } from '../lib/processes'
import type { PlanModel } from '../lib/planModel'
import {
  chooseProducer,
  clearBranchChoice,
  keepDefaultInPlan,
  addProvider,
  addOverflowTarget,
  convertOverflowTarget,
  linkToOverflow,
  migrateCatalysts,
  migrateFeedback,
  moveTarget,
  removeTarget,
  setItemFeedback,
  setTargetFeedback,
  pruneChoices,
  rememberSetup,
  setRoundUp,
  setRowCatalysts,
  type ProducerPick,
} from '../lib/choices'
import type { OverflowUse, PlanResult, ResolvedTarget } from '../lib/solver'
import { separationsOf, withSeparation, withoutSeparation } from '../lib/separate'
import { buildingNameFor, machineNameFor, noun } from '../lib/plural'
import { boilerHeat, boilersFor } from '../lib/steamBoiler'
import { IMPORT, planProducer } from '../lib/unfold'
import { dropUnits, setUnits, unitScales } from '../lib/units'
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

const NO_ROWS: string[] = []

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
  // Copies of each row built in units; units picked for a different machine count are dropped.
  const units = useMemo(
    () => unitScales(result.tree, plan.units, (n) => logistics.get(n.run!.key)?.utilization ?? 1),
    [result.tree, plan.units, logistics],
  )
  const stale = model.result?.status === 'ok' && units.stale.length > 0
  useEffect(() => {
    if (stale) onUpdatePlan((p) => dropUnits(p, units.stale, plan.units))
  }, [stale, units, plan.units, onUpdatePlan])

  const setProducer = (pick: ProducerPick) => onUpdatePlan((p) => chooseProducer(p, catalog, pick))
  const resetProducer = (row: string) => onUpdatePlan((p) => clearBranchChoice(p, row))
  /** Fuel or fertilizer: picked for the whole plan. */
  const planWide = (item: string, link?: boolean) => {
    const producer = planProducer(plan, catalog, item)
    return (
      <ProducerSelect
        item={item}
        current={{ producer, process: catalog.byId.get(producer) }}
        catalog={catalog}
        onChange={(producer, machine) => setProducer({ item, producer, machine })}
        noImport
        oneLine
        link={link}
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
    [fuels.has(item) && 'heat', fertilizers.has(item) && 'fertilizer', coinValue(item) !== null && 'money']
      .filter(Boolean)
      .join(' & ')

  // Targets are set in their own rows of the production tree.
  const [shownTarget, setShownTarget] = useState<{ index: number; n: number } | null>(null)
  const showTarget = (index: number) => setShownTarget((s) => ({ index, n: (s?.n ?? 0) + 1 }))
  /** The target just added, whose item picker opens. */
  const [added, setAdded] = useState<{ plan: string; index: number } | null>(null)
  const addTarget = () => {
    const index = plan.targets.length
    onUpdatePlan((p) => ({ ...p, targets: [...p.targets, { item: '', rate: 10 }] }))
    setAdded({ plan: plan.id, index })
    showTarget(index)
  }
  const updateTarget = (i: number, patch: Partial<PlanTarget>) =>
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
  // Row ids number only the targets with an item.
  let filled = 0
  const targetRoots = plan.targets.map((t) => (t.item ? `${filled++}/${t.item}` : null))
  const builtAtTop = new Set(separationsOf(plan.separate).flatMap((s) => (s.anchor ? [] : [s.item])))
  const targetSlot = (t: PlanTarget, i: number): TargetSlot => {
    const moveTo = (to: number) => onUpdatePlan((p) => moveTarget(p, i, to))
    // Targets of an item built separately share the first one's row (theirs isn't in the tree).
    const sharedWith = builtAtTop.has(t.item) ? plan.targets.findIndex((x) => x.item === t.item) : i
    const absorbs = ledger
      .filter((l) => l.absorbedBy === i)
      .map((l) => l.resource)
      .join(' & ')
    return {
      rootId: targetRoots[i],
      item: (
        <ItemPicker
          value={t.item || null}
          options={targetItems}
          onChange={(k) => {
            if (added?.index === i) setAdded(null)
            updateTarget(i, { item: k ?? '' })
          }}
          defaultOpen={added?.plan === plan.id && added.index === i && !t.item}
          compact
        />
      ),
      amount: (
        <TargetAmount
          target={t}
          resolved={resolvedByRow[i]}
          feedsInto={t.item ? feedsInto(t.item) : ''}
          absorbs={absorbs}
          fedBack={targetFedBack(plan, t)}
          onChange={(patch) => updateTarget(i, patch)}
        />
      ),
      notes: (
        <TargetNotes
          target={t}
          resolved={resolvedByRow[i]}
          feedsInto={t.item ? feedsInto(t.item) : ''}
          fedBack={targetFedBack(plan, t)}
          ownFeedback={t.feedback !== undefined}
          onFeedback={(on) => onUpdatePlan((p) => setTargetFeedback(p, i, on))}
          sharedWith={sharedWith === i ? null : sharedWith}
          onShowTarget={showTarget}
          onConvert={() => onUpdatePlan((p) => convertOverflowTarget(p, i, resolvedByRow[i]?.rate ?? 0))}
          overflowing={overflowing}
          onUseOverflow={(consumes) => onUpdatePlan((p) => linkToOverflow(p, i, consumes))}
        />
      ),
      move: plan.targets.length > 1 && (
        <>
          <button
            type="button"
            className="target-button"
            title="Move up: targets fed back cover the plan's heat and fertilizer in this order"
            aria-label="Move target up"
            disabled={i === 0}
            onClick={() => moveTo(i - 1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="target-button"
            title="Move down: targets fed back cover the plan's heat and fertilizer in this order"
            aria-label="Move target down"
            disabled={i === plan.targets.length - 1}
            onClick={() => moveTo(i + 1)}
          >
            ↓
          </button>
        </>
      ),
      remove: (
        <button
          type="button"
          className="target-button"
          title="Remove target"
          aria-label={`Remove target ${i + 1}`}
          onClick={() => {
            setAdded(null)
            onUpdatePlan((p) => removeTarget(p, i))
          }}
        >
          ×
        </button>
      ),
    }
  }

  const overflowSources = useMemo(() => overflowRows(result.tree), [result.tree])
  const deficits = result.balances.filter((b) => b.deficit > 0)
  const runaways = resolvedByRow.flatMap((r, index) => (r?.overflow?.runaway ? [{ index, item: r.overflow.item }] : []))
  const heat = result.balances.find((b) => b.item === HEAT)
  const money = useMemo(() => moneyLedger(plan, catalog, result, ledger), [plan, catalog, result, ledger])
  // Items the plan overflows (including what overflow targets take), which a target can switch to using.
  const overflowing = money.outputs.filter((o) => o.sources.some((s) => s.target === null)).map((o) => o.item)
  // Overflow the plan feeds back into its heat, fertilizer or money isn't overflow: it gets used.
  const fed = useMemo(() => fedOverflow(money), [money])

  // Whole machines per building type, as built: each tree row rounds up on its own.
  const buildings = useMemo(() => buildingCounts(result.tree, logistics, units.copies), [result.tree, logistics, units])
  const totalMachines = buildings.reduce((t, b) => t + b.count, 0)
  const heatUsers = useMemo(() => resourceUsers(result.tree, logistics, 'heat', units.copies), [result.tree, logistics, units])
  const nutrientUsers = useMemo(() => resourceUsers(result.tree, logistics, 'nutrients', units.copies), [result.tree, logistics, units])

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
                Pick what you want to make and how many per minute, or how many machines&apos; worth. The planner works out every
                step and machine needed. Every item uses its standard recipe by default; switch any step to one of your saved
                cauldron recipes (★) in the production tree.
              </p>
              <button className="primary empty-state-action" onClick={addTarget}>
                + Add target
              </button>
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

              {runaways.length > 0 && (
                <div className="panel warning">
                  <strong>Overflow loop runs away.</strong> These overflow targets overflow at least as much as they take, so
                  they would need an endless factory. They make nothing until their recipes change or they become standard
                  targets:
                  <ul>
                    {runaways.map(({ index, item }) => (
                      <li key={index}>
                        <TargetLink index={index} onShow={showTarget} /> · <ItemLabel item={plan.targets[index].item} /> from{' '}
                        <ItemLabel item={item} /> overflow
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

              <BusPanel
                ledgers={ledger}
                money={money}
                plan={plan}
                catalog={catalog}
                busPick={(resource) => planWide(resource === 'heat' ? HEAT : NUTRIENTS, true)}
                overflowFrom={overflowSources}
                onFeedback={(item, target, on) =>
                  onUpdatePlan((p) => (target === null ? setItemFeedback(p, item, on) : setTargetFeedback(p, target, on)))
                }
                onProvide={(item) => {
                  onUpdatePlan((p) => addProvider(p, item))
                  showTarget(plan.targets.length)
                }}
                onUseOverflow={(item, consumes) => {
                  onUpdatePlan((p) => addOverflowTarget(p, item, consumes))
                  showTarget(plan.targets.length)
                }}
                onShowTarget={showTarget}
              >
                {machineTier(STEAM_BOILER) <= catalog.tier && <BoilerRoom ledger={ledger.find((l) => l.resource === 'heat')!} mods={mods} />}
              </BusPanel>

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
                  mods={mods}
                  roundUp={plan.roundUp ?? NO_ROWS}
                  fed={fed}
                  onRoundUp={(row, on) => onUpdatePlan((p) => setRoundUp(p, row, on))}
                  units={units}
                  onUnits={(row, unit) => onUpdatePlan((p) => setUnits(p, row, unit))}
                  targets={plan.targets.map(targetSlot)}
                  onAddTarget={addTarget}
                  shownTarget={shownTarget}
                />
              </section>

              <div className="two-col">
                <section className="panel">
                  <h2>Buildings</h2>
                  <ul className="flow-list">
                    {buildings.map((b) => {
                      const slowed = b.count > b.atFullSpeed
                      return (
                        <li key={b.name}>
                          <span className="building-name">{b.name}</span>
                          {slowed && <span className="hint-inline">{fmt(b.atFullSpeed)} at full speed →</span>}
                          <span className={slowed ? 'rate belt-limited' : 'rate'}>{fmt(b.count)}</span>
                        </li>
                      )
                    })}
                  </ul>
                </section>
                {heatUsers.length + nutrientUsers.length > 0 && (
                  <section className="panel">
                    <h2>Heat &amp; nutrients used</h2>
                    <ResourceUsers title="🔥 Heat" users={heatUsers} unit="P/s" />
                    <ResourceUsers title="🌱 Nutrients" users={nutrientUsers} unit="nutrients/s" />
                  </section>
                )}
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

/** What feeding an output back does, as a verb: burn it, spread it, spend it (or use it, for several). */
const FEED_VERB: Record<BusUse, string> = { heat: 'burns', fertilizer: 'spreads', money: 'spends' }
const feedButton = (feeds: BusUse[]) =>
  feeds.length === 1 ? { heat: 'Burn', fertilizer: 'Spread', money: 'Spend' }[feeds[0]] : 'Use'

/**
 * The plan's effect on the bus. Into the plan go its three fundamental inputs: heat and fertilizer
 * (each balanced from zero, what the plan feeds back against what it uses, with the bus fuel or
 * fertilizer covering the rest) and money (what the Purchase Portals spend, and coins taken in).
 * Out go the items it delivers, one row each with every source, what the plan feeds back of it and
 * what's left for the bus; items that can feed back (fuel, the nurseries' fertilizer, coins) move
 * between the two per source.
 */
function BusPanel({
  ledgers,
  money,
  plan,
  catalog,
  busPick,
  overflowFrom,
  onFeedback,
  onProvide,
  onUseOverflow,
  onShowTarget,
  children,
}: {
  ledgers: ResourceLedger[]
  money: MoneyLedger
  plan: Plan
  catalog: ProcessCatalog
  /** Picks the fuel or fertilizer the bus supplies. */
  busPick: (resource: Resource) => ReactNode
  /** Per overflowing item, the rows it overflows from. */
  overflowFrom: Map<string, string[]>
  /** Feeds a source back (the plan uses it) or not (it goes out to the bus). */
  onFeedback: (item: string, target: number | null, on: boolean) => void
  onProvide: (item: string) => void
  /** Adds an overflow target making `item` from the overflow of `consumes`. */
  onUseOverflow: (item: string, consumes: string) => void
  /** Shows a target's row in the production tree. */
  onShowTarget: (index: number) => void
  children?: ReactNode
}) {
  const margin = money.value - money.cost
  const resources = [...ledgers].reverse().filter((l) => l.need > 0 || l.made > 0) // heat first
  return (
    <section className="panel ledger">
      <h2>Bus</h2>
      <div className="ledger-columns">
        <div>
          <h3>Into the plan</h3>
          <div className="bus-inputs">
            {resources.map((l) => (
              <ResourceIn
                key={l.resource} ledger={l} plan={plan} catalog={catalog} busPick={busPick(l.resource)} onProvide={onProvide}
                onShowTarget={onShowTarget}
              />
            ))}
            <MoneyIn money={money} />
          </div>
        </div>
        <div>
          <h3>Out to the bus</h3>
          {money.outputs.length === 0 ? (
            <p className="hint">Nothing: the plan delivers no items.</p>
          ) : (
            <ul className="bus-outputs">
              {money.outputs.map((o) => (
                <OutputLine
                  key={o.item}
                  row={o}
                  overflowFrom={overflowFrom}
                  onFeedback={onFeedback}
                  onUseOverflow={onUseOverflow}
                  onShowTarget={onShowTarget}
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
        </div>
      </div>
      {children}
    </section>
  )
}

/**
 * Heat or fertilizer into the plan: its balance (what the plan feeds back against what it uses),
 * the bus fuel or fertilizer covering the rest, and a way to provide that from the plan instead.
 */
function ResourceIn({
  ledger,
  plan,
  catalog,
  busPick,
  onProvide,
  onShowTarget,
}: {
  ledger: ResourceLedger
  plan: Plan
  catalog: ProcessCatalog
  busPick: ReactNode
  onProvide: (item: string) => void
  onShowTarget: (index: number) => void
}) {
  const { title, unit, verb } = RESOURCE[ledger.resource]
  const perSecond = (perMinute: number) => `${fmt(perMinute / 60)} ${unit}`
  // The plan's own balance, from zero: what it feeds back, less what its machines use.
  const net = Math.abs(ledger.made - ledger.need) < 1e-9 * Math.max(1, ledger.need) ? 0 : ledger.made - ledger.need
  const [providing, setProviding] = useState<string | null>(null)
  return (
    <div className="bus-input">
      <div className="ledger-head">
        <strong>{title}</strong>
        <span className="ledger-balance" title="What the plan feeds back, against what its machines use">
          uses {perSecond(ledger.need)} · makes {fmt(ledger.made / 60)}{' '}
          <strong className={`rate ${net >= 0 ? 'positive' : 'negative'}`}>
            {net >= 0 ? '+' : '−'}
            {perSecond(Math.abs(net))}
          </strong>
        </span>
        {ledger.absorbedBy !== null ? (
          <span className="ledger-provided hint-inline">
            provided by <TargetLink index={ledger.absorbedBy} onShow={onShowTarget} />
          </span>
        ) : (
          net < 0 &&
          providing === null && (
            <button
              className="compact-button"
              title={`Add a target that makes what the plan ${verb} itself`}
              onClick={() => setProviding(planProducer(plan, catalog, ledger.resource === 'heat' ? HEAT : NUTRIENTS))}
            >
              Provide from plan…
            </button>
          )
        )}
      </div>
      {providing !== null && (
        <ProviderForm
          resource={ledger.resource}
          picked={providing}
          catalog={catalog}
          onPick={setProviding}
          onProvide={(item) => {
            onProvide(item)
            setProviding(null)
          }}
          onCancel={() => setProviding(null)}
        />
      )}
      <div className="bus-line">
        <span className="ledger-what">
          {busPick}
          <span className="ledger-from">from the bus</span>
        </span>
        <span className="ledger-amount">
          {ledger.absorbedBy !== null
            ? 'not used'
            : ledger.bus && ledger.bus.count > 0
              ? `${fmt(ledger.bus.count)}/min → ${perSecond(ledger.bus.count * ledger.bus.per)}`
              : 'not needed'}
        </span>
      </div>
      {ledger.short > 0 && (
        <p className="rate negative">
          {perSecond(ledger.short)} can&apos;t be covered: the net target&apos;s own chain uses more than it gives
        </p>
      )}
    </div>
  )
}

/** Money into the plan: what the Purchase Portals spend, coins taken in, and own coins covering some. */
function MoneyIn({ money }: { money: MoneyLedger }) {
  const lines = [...money.purchases.map((l) => ({ ...l, coin: false })), ...money.coins.map((l) => ({ ...l, coin: true }))]
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
      {lines.length === 0 ? (
        <p className="hint">Nothing to buy.</p>
      ) : (
        <ul className="money-lines">
          {lines.map((l) => (
            <li key={l.item}>
              <ItemLabel item={l.item} size={16} />
              <span className="hint-inline">
                {fmt(l.count)}/min{l.coin ? ' off the bus' : ''}
              </span>
              {l.price !== null ? (
                <span className="money-cost">
                  <Money copper={l.count * l.price} suffix="/min" />
                </span>
              ) : (
                <span className="tag warn" title="Purchase Portals don't sell this item">
                  not sold at portals
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * One item leaving the plan: what goes out to the bus and what it's worth, what the plan feeds back
 * of it, and its sources (targets and overflow), each movable between the plan and the bus when the
 * item can feed back. Overflow nothing uses is flagged: it backs up the machines making it.
 */
function OutputLine({
  row,
  overflowFrom,
  onFeedback,
  onUseOverflow,
  onShowTarget,
}: {
  row: OutputRow
  overflowFrom: Map<string, string[]>
  onFeedback: (item: string, target: number | null, on: boolean) => void
  /** Adds an overflow target making `item` from this item's overflow. */
  onUseOverflow: (item: string, consumes: string) => void
  onShowTarget: (index: number) => void
}) {
  const uses = (Object.entries(row.used) as [BusUse, number][]).filter(([, n]) => n > 0)
  const [using, setUsing] = useState(false)
  return (
    <li className="bus-output">
      <div className="bus-output-head">
        <ItemLabel item={row.item} size={18} />
        <span className="bus-net">
          {row.toBus > 0 ? <strong>+{fmt(row.toBus)}/min out</strong> : <span className="hint-inline">none out</span>}
          {row.toBus > 0 &&
            (row.price !== null ? (
              <Money copper={row.toBus * row.price} suffix="/min" />
            ) : (
              <span className="hint-inline">not sold in shops</span>
            ))}
        </span>
      </div>
      {uses.length > 0 && (
        <div className="bus-output-uses">
          plan {uses.map(([use, n]) => `${FEED_VERB[use]} ${fmt(n)}/min`).join(' · ')}
        </div>
      )}
      <ul className="bus-output-sources">
        {row.sources.map((s) => {
          const fed = Object.values(s.used).reduce((t, n) => t + (n ?? 0), 0)
          const used = fed + s.taken.reduce((t, x) => t + x.amount, 0)
          const left = s.amount - used
          const idle = s.target === null && !s.fedBack && left > 1e-9 * s.amount
          return (
            <li key={s.target ?? 'overflow'}>
              <span className="ledger-what">
                <span>
                  {s.target === null ? 'overflow' : <TargetLink index={s.target} onShow={onShowTarget} />} · {fmt(s.amount)}/min
                </span>
                {idle && (
                  <button
                    className="tree-link warn-text"
                    title="Made but used nowhere in the plan: route it somewhere or it backs up the machines. Click to add a target that uses it."
                    aria-expanded={using}
                    onClick={() => setUsing((u) => !u)}
                  >
                    ⚠ nothing uses it
                  </button>
                )}
                {s.target === null && (
                  <span className="hint-inline">from {(overflowFrom.get(row.item) ?? []).join(', ')}</span>
                )}
                {s.taken.map((x) => (
                  <span key={x.target} className="fed-text">
                    {fmt(x.amount)}/min taken by <TargetLink index={x.target} onShow={onShowTarget} />
                  </span>
                ))}
                {s.fedBack && fed > 0 && left > 1e-9 * s.amount && (
                  <span className="hint-inline">{fmt(left)}/min left over</span>
                )}
              </span>
              {row.feeds.length > 0 &&
                (s.fedBack ? (
                  <button
                    className="move-button"
                    title="Stop feeding it back: it all goes out to the bus"
                    onClick={() => onFeedback(row.item, s.target, false)}
                  >
                    Send to bus →
                  </button>
                ) : (
                  <button
                    className="move-button"
                    title={`Feed it back: the plan ${row.feeds.map((f) => FEED_VERB[f]).join(' or ')} it before taking any from the bus`}
                    onClick={() => onFeedback(row.item, s.target, true)}
                  >
                    ← {feedButton(row.feeds)} in plan
                  </button>
                ))}
            </li>
          )
        })}
      </ul>
      {using && (
        <OverflowTargetForm
          item={row.item}
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
 * Adds a target that uses an item's overflow: the planner makes as many of what the player picks as
 * that overflow comes to. Any item can be picked; a cauldron recipe can take almost anything.
 */
function OverflowTargetForm({
  item,
  onAdd,
  onCancel,
}: {
  item: string
  onAdd: (item: string) => void
  onCancel: () => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  return (
    <div className="provider-form">
      <label className="stacked">
        Make from the overflow
        <ItemPicker value={picked} options={targetItems} onChange={setPicked} defaultOpen compact />
      </label>
      <p className="hint">
        Adds a target sized to use the {itemName(item)} nothing else uses. If its recipes don&apos;t take {itemName(item)},
        pick ones that do in its rows.
      </p>
      <div className="provider-actions">
        <button className="primary" disabled={!picked} onClick={() => picked && onAdd(picked)}>
          Add {picked ? itemName(picked) : ''} target
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/** What draws heat (per building type) or nutrients (per nursery and plant), biggest first. */
function ResourceUsers({ title, users, unit }: { title: string; users: ResourceUser[]; unit: string }) {
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

/** Shows a target's row in the production tree. */
function TargetLink({ index, onShow }: { index: number; onShow: (index: number) => void }) {
  return (
    <button className="tree-link" onClick={() => onShow(index)}>
      Target {index + 1}
    </button>
  )
}

/**
 * Sets the plan up to provide its own heat or fertilizer: adds a fed-back target at 0 net per
 * minute of a fuel the player picks (the bus fuel to start with), or of the nurseries' fertilizer.
 */
function ProviderForm({
  resource,
  picked,
  catalog,
  onPick,
  onProvide,
  onCancel,
}: {
  resource: 'heat' | 'fertilizer'
  /** The fuel or fertilizer process picked so far. */
  picked: string
  catalog: ProcessCatalog
  onPick: (producer: string) => void
  onProvide: (item: string) => void
  onCancel: () => void
}) {
  const input = catalog.byId.get(picked)?.inputs[0]?.item
  const item = input ? realItem(input) : null
  return (
    <div className="provider-form">
      {resource === 'heat' ? (
        <label className="stacked">
          Fuel to make
          <ProducerSelect
            item={HEAT}
            current={{ producer: picked, process: catalog.byId.get(picked) }}
            catalog={catalog}
            onChange={(producer) => onPick(producer)}
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
        <button className="primary" disabled={!item} onClick={() => item && onProvide(item)}>
          Add {item ? itemName(item) : ''} target
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/**
 * The plan's heat as steam (which carries heat without loss): per fuel it burns, the bus fuel and
 * any it feeds back, how many Steam Boilers on each setting carry that fuel's heat. A boiler sits on
 * a furnace fed by one belt, so a fuel with little heat per item can't keep a setting going.
 */
function BoilerRoom({ ledger, mods }: { ledger: ResourceLedger; mods: Modifiers }) {
  const fuels = new Map<string, { heat: number; per: number }>()
  const burn = (item: string, count: number, per: number) => {
    if (count <= 0) return
    const f = fuels.get(item) ?? { heat: 0, per }
    fuels.set(item, { heat: f.heat + (count * per) / 60, per })
  }
  for (const s of ledger.sources) burn(s.item, s.used, s.per)
  if (ledger.bus) burn(ledger.bus.item, ledger.bus.count, ledger.bus.per)
  if (!fuels.size) return null
  const icon = iconUrl(buildingsByKey.get(STEAM_BOILER)?.icon)
  return (
    <div className="boiler-room">
      {[...fuels].map(([item, { heat, per }]) => {
        const beltHeat = (mods.beltSpeed / 60) * per
        const boilers = boilersFor(heat, per, mods.factorySpeed, mods.beltSpeed)
        const why = `A furnace's belt brings ${fmt(mods.beltSpeed)} ${itemName(item)}/min, ${fmt(beltHeat)} P/s`
        const amount = (count: number) => (
          <>
            <strong>{Number.isFinite(count) ? count : '∞'}</strong> {buildingNameFor(STEAM_BOILER, count)}
          </>
        )
        return (
          <div key={item} className="boiler-line">
            <div className="boiler-fuel">
              {icon && <img src={icon} width={20} height={20} alt="" />}
              <span>As steam, burning</span>
              <ItemLabel item={item} size={16} />
              <span className="hint-inline">{fmt(heat)} P/s</span>
            </div>
            <div className="boiler-counts">
              {boilers.every((b) => b.beltLimited) ? (
                // The belt sets the pace whatever the setting: the counts are all the same.
                <span className="belt-limited" title={`${why}: less than a boiler draws on any setting`}>
                  {amount(boilers[0].count)} on any setting (belt-limited)
                </span>
              ) : (
                boilers.map(({ setting, each, count, beltLimited }, i) => (
                  <span
                    key={setting.name}
                    className={beltLimited ? 'belt-limited' : undefined}
                    title={
                      beltLimited
                        ? `${why}: less than a boiler on ${setting.name} draws (${fmt(boilerHeat(setting, mods.factorySpeed))} P/s)`
                        : `${fmt(heat / each)} at ${fmt(each)} P/s each`
                    }
                  >
                    {i > 0 && '· '}
                    {amount(count)} on {setting.name}
                    {beltLimited && ' (belt-limited)'}
                  </span>
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

type Unit = NonNullable<PlanTarget['unit']>

/** A target's amount and unit: items per minute, machines' worth, or net of what the plan uses. */
function TargetAmount({
  target,
  resolved,
  feedsInto,
  absorbs,
  fedBack,
  onChange,
}: {
  target: PlanTarget
  resolved: ResolvedTarget | undefined
  /** What the item could feed back into ('heat', 'fertilizer', both, or '' when nothing). */
  feedsInto: string
  /** What this net-surplus target covers the rest of ('heat', 'fertilizer', both, or ''). */
  absorbs: string
  /** The plan feeds the item back (so net can take some off). */
  fedBack: boolean
  onChange: (patch: Partial<PlanTarget>) => void
}) {
  const unit = target.unit ?? 'items'
  const perMachine = resolved?.perMachine ?? null
  const made = resolved?.made ?? 0
  if (unit === 'overflow')
    return (
      <div className="target-amount" title="As many as the overflow it takes makes">
        <strong>{fmt(made)}</strong> /min
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
          <option value="items">/min</option>
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
      {unit === 'machines' && perMachine !== null && (
        <div className="machine-meta" title={`${fmt(perMachine)}/min each`}>
          = {fmt(made)}/min
        </div>
      )}
      {unit === 'net' && absorbs && (
        <>
          <div className="machine-meta" title={`Made in all: the net amount, plus what the plan uses for its ${absorbs}`}>
            = {fmt(made)}/min
          </div>
          <div className="machine-meta">
            {fmt(made - (resolved?.rate ?? 0))} for the plan&apos;s {absorbs}
          </div>
        </>
      )}
      {unit === 'net' && !absorbs && target.item && (
        <div
          className="machine-meta"
          title={
            !feedsInto
              ? "Not a fuel or the nurseries' fertilizer: nothing to take off"
              : !fedBack
                ? 'Not fed back into the plan: nothing to take off'
                : `A net target above covers the plan's ${feedsInto}`
          }
        >
          {!feedsInto ? 'not fuel' : !fedBack ? 'not fed back' : 'covered above'}: same as /min
        </div>
      )}
    </>
  )
}

/** Under a target's recipe: what its amount comes to, and whether the plan feeds it back. */
function TargetNotes({
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
}: {
  target: PlanTarget
  resolved: ResolvedTarget | undefined
  /** What the item could feed back into ('heat', 'fertilizer', both, or '' when nothing). */
  feedsInto: string
  fedBack: boolean
  /** The target sets its own feedback instead of following its item's. */
  ownFeedback: boolean
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
}) {
  if (!target.item) return <span className="leaf-note">Pick what to make</span>
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
      {unit === 'overflow' && target.consumes ? (
        <OverflowTargetNote consumes={target.consumes} use={resolved?.overflow} onShowTarget={onShowTarget} onConvert={onConvert} />
      ) : (
        overflowing.some((item) => item !== target.item) && (
          <select
            className="overflow-link"
            value=""
            onChange={(e) => e.target.value && onUseOverflow(e.target.value)}
            aria-label="Use the plan's overflow instead"
            title="Make as many as the plan's overflow of an item makes, instead of a set amount"
          >
            <option value="">↪ Use overflow of…</option>
            {overflowing
              .filter((item) => item !== target.item)
              .map((item) => (
                <option key={item} value={item}>
                  {itemName(item)}
                </option>
              ))}
          </select>
        )
      )}
      {feedsInto && (
        <label className="check target-feedback" title="Covers the plan's own need before the bus does, in target order">
          <input type="checkbox" checked={fedBack} onChange={(e) => onFeedback(e.target.checked)} />
          Feed back into the plan&apos;s {feedsInto}
          {ownFeedback && <span className="hint-inline">(this target only)</span>}
        </label>
      )}
    </>
  )
}

/**
 * What an overflow target takes, or why it takes nothing: its recipes don't use the item, a target
 * above takes it all, or nothing overflows. It can become an ordinary target at any time.
 */
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
