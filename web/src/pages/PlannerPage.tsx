import { startTransition, useEffect, useMemo, useOptimistic, useRef, useState, type ReactNode } from 'react'
import { ItemIcon, ItemLabel } from '../components/ItemIcon'
import { ItemPicker } from '../components/ItemPicker'
import { Exp } from '../components/Exp'
import { Money } from '../components/Money'
import { OverflowTargetForm } from '../components/OverflowTargetForm'
import { ProducerSelect, TierTag } from '../components/ProducerSelect'
import { BookmarkIcon, ProductionTree, type TargetSlot } from '../components/ProductionTree'
import { ledgers, targetFedBack, type DrawUse, type ItemLedger } from '../lib/ledger'
import { useFlip } from '../lib/flip'
import { setNetworkFuel, setNetworkSource } from '../lib/heatChoices'
import type { HeatNetwork } from '../lib/heatNetworks'
import {
  HEAT,
  MAX_TIER,
  MONEY,
  NUTRIENTS,
  coinValue,
  iconUrl,
  itemName,
  machineTier,
  machinesByKey,
  targetItems,
  tierIcon,
  tierName,
} from '../lib/gameData'
import { altarsFor, altarYield, type AltarYield } from '../lib/altar'
import { fmt, fmtMachines, fmtSeconds, wholeMachines } from '../lib/format'
import { buildingCounts, checkLogistics, resourceUsers, type LogisticsCheck, type ResourceUser } from '../lib/logistics'
import { fedOverflow, moneyLedger, type BusUse, type MoneyLedger, type OutputRow, type OutputSource } from '../lib/money'
import { STEAM_HEAT_ID, defaultProducer, processTitle, type ProcessCatalog } from '../lib/processes'
import type { PlanModel } from '../lib/planModel'
import { namedAfterTargets, planTitle, targetsName } from '../lib/planName'
import {
  chooseProducer,
  chooseReuse,
  clearBranchChoice,
  keepDefaultInPlan,
  addProvider,
  addOverflowTarget,
  addSupplyTarget,
  setBusSupply,
  convertOverflowTarget,
  linkToOverflow,
  linkToSupply,
  migrateCatalysts,
  migrateFeedback,
  moveTarget,
  removeTarget,
  setItemFeedback,
  setTargetFeedback,
  pruneChoices,
  rememberSetup,
  ownPicks,
  setBuilt,
  setPlanDefault,
  setRoundUp,
  setMixedFeed,
  followDefault,
  setRowCatalysts,
  setRowHeight,
  setRowStack,
  type ProducerPick,
} from '../lib/choices'
import type { OverflowUse, PlanResult, ResolvedTarget, SupplyUse } from '../lib/solver'
import { separationsOf } from '../lib/separate'
import { canSeparateShared, mergeSingleUses, separateShared, setSeparation } from '../lib/separateAll'
import { buildingNameFor, machineNameFor, noun } from '../lib/plural'
import { BOILER_HEAT, BUS, IMPORT, parentId, planProducer, rowItem } from '../lib/unfold'
import { dropUnits, setUnits, unitScales } from '../lib/units'
import type { TreeNode } from '../lib/tree'
import { usePersistentState } from '../lib/store'
import { blankTarget, type MyDefaults, type Plan, type PlanTarget, type Progress, type Separation } from '../lib/types'
import { PLANNER_UPGRADES, maxLevel, upgradeLevel, type Modifiers } from '../lib/upgrades'

/** What each planner upgrade series currently does, shown under its name. */
const UPGRADE_EFFECTS: Record<string, (m: Modifiers) => string> = {
  Conveyer: (m) => `${fmt(m.beltSpeed)} items/min per belt`,
  FactorySpeed: (m) => `×${fmt(m.factorySpeed)} crafting speed`,
  AlchemySkill: (m) => `×${fmt(m.extractor)} Extractor & Alembic output`,
  FuelEfficiency: (m) => `×${fmt(m.fuel)} heat per fuel`,
  FertilizeEfficiency: (m) => `×${fmt(m.fertilizer)} nutrients per fertilizer`,
  AltarEfficiency: (m) => `×${fmt(m.altar)} EXP from relics`,
}

interface Props {
  plans: Plan[]
  plan: Plan
  model: PlanModel
  /** Upgrade levels and research tier, for every plan. */
  progress: Progress
  /** Each change says what it does, for undo. */
  onProgress: (label: string, update: (p: Progress) => Progress) => void
  /** How the player likes to make items, for every plan. */
  myDefaults: MyDefaults
  onMyDefaults: (label: string, defaults: MyDefaults) => void
  onSelectPlan: (id: string) => void
  /** Null for upkeep the app does by itself, which is never a step of its own to undo. */
  onUpdatePlan: (label: string | null, update: (p: Plan) => Plan) => void
  onNewPlan: () => void
  onDuplicatePlan: () => void
  onDeletePlan: () => void
  /** Looks for a new cauldron recipe for a row's item on the Cauldron page. */
  onFindCauldron: (row: TreeNode) => void
  /** A row to show once the plan is solved (after a recipe was put on it from the Cauldron page), and hearing it was. */
  reveal: string | null
  onRevealed: () => void
}

const NO_ROWS: string[] = []

/** A tree row's name in undo's list. */
const rowName = (row: string) => itemName(rowItem(row))

/** A tree row gone from the plan is held in place by the row above it. */
const flipParent = (key: string) => {
  const above = key.startsWith('row:') ? parentId(key.slice(4)) : null
  return above === null ? null : `row:${above}`
}

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
  onFindCauldron,
  reveal,
  onRevealed,
}: Props) {
  const { mods, catalog } = model
  const result = model.result ?? UNSOLVED
  // Panels and rows glide to where a change puts them, around the one just used.
  const main = useRef<HTMLElement>(null)
  useFlip(main, flipParent)
  // Forget recipe, machine, catalyst, branch and build-separately picks for anything that has left
  // the plan (and build-separately picks that no longer gather anything).
  useEffect(() => {
    if (migrateCatalysts(plan, catalog)) onUpdatePlan(null, (p) => migrateCatalysts(p, catalog) ?? p)
    else if (migrateFeedback(plan, catalog)) onUpdatePlan(null, (p) => migrateFeedback(p, catalog) ?? p)
    else if (pruneChoices(plan, catalog)) onUpdatePlan(null, (p) => pruneChoices(p, catalog) ?? p)
  }, [plan, catalog, onUpdatePlan])
  // result.targets skips rows with no item chosen yet; line them back up with the rows.
  let resolvedIndex = 0
  const resolvedByRow = plan.targets.map((t) => (t.item ? result.targets[resolvedIndex++] : undefined))
  const ledger = useMemo(() => ledgers(plan, result), [plan, result])
  const drawn = useMemo(() => new Set(ledger.map((l) => l.item)), [ledger])
  const logistics = useMemo(() => checkLogistics(result.runs, mods), [result, mods])
  const beltLimited = [...logistics.values()].filter((c) => c.utilization < 1 && c.machines > 0)
  const beyond = useMemo(() => beyondTier(result.tree, catalog.tier), [result.tree, catalog.tier])
  // Copies of each row built in units; units picked for a different machine count are dropped.
  const units = useMemo(
    () => unitScales(result.tree, plan.units, (n) => logistics.get(n.run!.key)?.utilization ?? 1),
    [result.tree, plan.units, logistics],
  )
  const stale = model.result?.status === 'ok' && units.stale.length > 0
  useEffect(() => {
    if (stale) onUpdatePlan(null, (p) => dropUnits(p, units.stale, plan.units))
  }, [stale, units, plan.units, onUpdatePlan])

  const setProducer = (pick: ProducerPick) =>
    onUpdatePlan(`Change how ${itemName(pick.item)} is made`, (p) => chooseProducer(p, catalog, pick))
  const setNetworkBurn = (net: HeatNetwork, producer: string, machine?: string) =>
    onUpdatePlan(`Change what a ${itemName(net.fuel)} heat network burns`, (p) => setNetworkFuel(p, catalog, net, producer, machine))
  const setNetworkSupply = (net: HeatNetwork, producer: string, machine?: string) =>
    onUpdatePlan(`Change where a ${itemName(net.fuel)} heat network gets its fuel`, (p) => setNetworkSource(p, catalog, net, producer, machine))
  const resetProducer = (row: string) => onUpdatePlan(`Reset the pick for ${rowName(row)}`, (p) => clearBranchChoice(p, row))
  const setReuse = (item: string, on: boolean, row?: string) =>
    onUpdatePlan(`${on ? 'Reuse' : 'Stop reusing'} ${itemName(item)} by-products`, (p) => chooseReuse(p, item, on, row))
  /**
   * The fuel or fertilizer (heat or nutrients) rows burn or spread unless their branch picks
   * another. Changing it keeps those picks; the rows making them can follow it too.
   */
  const planDefault = (item: typeof HEAT | typeof NUTRIENTS | typeof MONEY) => {
    const producer = planProducer(plan, catalog, item)
    return {
      pick: (
        <ProducerSelect
          item={item}
          current={{ producer, process: catalog.byId.get(producer) }}
          catalog={catalog}
          onChange={(producer) => onUpdatePlan(`Change the plan default for ${itemName(item)}`, (p) => setPlanDefault(p, item, producer))}
          noImport
          oneLine
          link
        />
      ),
      own: ownPicks(plan, catalog, item).length,
      onFollow: () => onUpdatePlan(`Follow the plan default for ${itemName(item)}`, (p) => followDefault(p, item)),
    }
  }
  /** When the plan heats with Steam: the solid fuel its boilers burn (their own heat can't be Steam). */
  const boilerDefault = () => {
    if (planProducer(plan, catalog, HEAT) !== STEAM_HEAT_ID) return null
    const picked = plan.producers[BOILER_HEAT]
    const producer = picked && catalog.byId.has(picked) ? picked : defaultProducer(catalog, HEAT)
    return (
      <ProducerSelect
        item={HEAT}
        current={{ producer, process: catalog.byId.get(producer) }}
        catalog={catalog}
        onChange={(producer) => onUpdatePlan('Change boiler fuel', (p) => setPlanDefault(p, BOILER_HEAT, producer))}
        noImport
        oneLine
        link
        exclude={[STEAM_HEAT_ID]}
      />
    )
  }
  const setCatalysts = (row: string, catalysts: string[], inherited: string[]) =>
    onUpdatePlan(`Change catalysts for ${rowName(row)}`, (p) => setRowCatalysts(p, row, catalysts, inherited))
  const setHeight = (row: string, height: number, inherited: number) =>
    onUpdatePlan(`Change height for ${rowName(row)}`, (p) => setRowHeight(p, row, height, inherited))
  const setStack = (row: string, stack: number, inherited: number) =>
    onUpdatePlan(`Change stacking for ${rowName(row)}`, (p) => setRowStack(p, row, stack, inherited))
  const remember = (row: TreeNode) => {
    const next = rememberSetup(plan, catalog, result.tree, row)
    const label = `Save default for ${itemName(row.item)}`
    onMyDefaults(label, next.mine)
    onUpdatePlan(label, () => next.plan)
  }
  const forget = (item: string, label = `Forget default for ${itemName(item)}`) =>
    onMyDefaults(label, Object.fromEntries(Object.entries(myDefaults).filter(([k]) => k !== item)))
  /** Un-saves a default from a row: this plan stays made that way; only other plans lose it. */
  const unsave = (item: string) => {
    const saved = myDefaults[item]
    const label = `Unsave default for ${itemName(item)}`
    if (saved) onUpdatePlan(label, (p) => keepDefaultInPlan(p, result.tree, item, saved))
    forget(item, label)
  }
  const setSeparate = (s: Separation, on: boolean, from?: string, replacing?: Separation) =>
    onUpdatePlan(`${on ? 'Build' : 'Stop building'} ${itemName(s.item)} separately`, (p) =>
      setSeparation(p, catalog, s, on, from, replacing),
    )
  // Whether the plan-wide build-separately buttons would change anything.
  const canSeparate = useMemo(() => canSeparateShared(plan, catalog), [plan, catalog])
  const canMerge = useMemo(() => mergeSingleUses(plan, catalog) !== plan, [plan, catalog])
  /** What a target's item could feed back into, if anything: what the plan takes of it from the bus, or its money. */
  const feedsInto = (item: string): Feeds => (coinValue(item) !== null ? 'money' : drawn.has(item) ? 'bus' : null)

  // Targets are set in their own rows of the production tree.
  const [shownTarget, setShownTarget] = useState<{ index: number; n: number } | null>(null)
  const showTarget = (index: number) => setShownTarget((s) => ({ index, n: (s?.n ?? 0) + 1 }))
  // Rows shown from links elsewhere on the page: each click on the same rows shows the next of them.
  const [shownRow, setShownRow] = useState<{ id: string; n: number; of: string[] } | null>(null)
  const showRow = (ids: string[]) =>
    setShownRow((s) => {
      const same = s && s.of.join() === ids.join()
      const id = ids[same ? (ids.indexOf(s.id) + 1) % ids.length : 0]
      return { id, n: (s?.n ?? 0) + 1, of: ids }
    })
  // A recipe just put on a row from the Cauldron page: show that row, once the plan has a tree to show it in.
  const [revealedRow, setRevealedRow] = useState<string | null>(null)
  if (reveal && model.result && revealedRow !== reveal) {
    setRevealedRow(reveal)
    showRow([reveal])
  }
  // Shown once: coming back to the planner later starts at the top again.
  useEffect(() => {
    if (revealedRow) onRevealed()
  }, [revealedRow, onRevealed])
  /** The target just added, whose item picker opens. */
  // Whether the upgrades and defaults column shows beside the plan (two-column layout only).
  const [sideOpen, setSideOpen] = usePersistentState<boolean>('planner-side', true, (v) => (typeof v === 'boolean' ? v : undefined), {
    perTab: true,
  })
  const [added, setAdded] = useState<{ plan: string; index: number } | null>(null)
  const addTarget = () => {
    // A plan with only its blank target uses that one: show it instead of adding another.
    if (plan.targets.length === 1 && !plan.targets[0].item) return showTarget(0)
    const index = plan.targets.length
    onUpdatePlan('Add target', (p) => ({ ...p, targets: [...p.targets, blankTarget()] }))
    setAdded({ plan: plan.id, index })
    showTarget(index)
  }
  /** A target's name in undo's list. */
  const targetName = (i: number) => (plan.targets[i]?.item ? `${itemName(plan.targets[i].item)} target` : `target ${i + 1}`)
  const updateTarget = (i: number, patch: Partial<PlanTarget>) =>
    onUpdatePlan(
      patch.item === undefined
        ? `Change amount of ${targetName(i)}`
        : patch.item
          ? `Set target ${i + 1} to ${itemName(patch.item)}`
          : `Clear ${targetName(i)}`,
      (p) => ({
      ...p,
      targets: p.targets.map((x, j) => {
        if (j !== i) return x
        if (patch.item === undefined || patch.item === x.item) return { ...x, ...patch }
        // A new item follows its own feedback setting.
        const { feedback: _, ...rest } = x
        return { ...rest, ...patch }
      }),
      }),
    )
  // Row ids number only the targets with an item.
  let filled = 0
  const targetRoots = plan.targets.map((t) => (t.item ? `${filled++}/${t.item}` : null))
  const builtAtTop = new Set(separationsOf(plan.separate).flatMap((s) => (s.anchor ? [] : [s.item])))
  const targetSlot = (t: PlanTarget, i: number): TargetSlot => {
    const moveTo = (to: number) => onUpdatePlan(`Move ${targetName(i)} ${to < i ? 'up' : 'down'}`, (p) => moveTarget(p, i, to))
    // Targets of an item built separately share the first one's row (theirs isn't in the tree).
    const sharedWith = builtAtTop.has(t.item) ? plan.targets.findIndex((x) => x.item === t.item) : i
    const absorbs = ledger.some((l) => l.absorbedBy === i)
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
          feedsInto={t.item ? feedsInto(t.item) : null}
          absorbs={absorbs}
          fedBack={targetFedBack(plan, t)}
          onChange={(patch) => updateTarget(i, patch)}
        />
      ),
      notes: (
        <TargetNotes
          target={t}
          resolved={resolvedByRow[i]}
          feedsInto={t.item ? feedsInto(t.item) : null}
          fedBack={targetFedBack(plan, t)}
          ownFeedback={t.feedback !== undefined}
          onFeedback={(on) => onUpdatePlan(`${on ? 'Feed back' : 'Stop feeding back'} ${targetName(i)}`, (p) => setTargetFeedback(p, i, on))}
          sharedWith={sharedWith === i ? null : sharedWith}
          onShowTarget={showTarget}
          onConvert={() =>
            onUpdatePlan(`Give ${targetName(i)} a set amount`, (p) => convertOverflowTarget(p, i, resolvedByRow[i]?.rate ?? 0))
          }
          overflowing={overflowing}
          onUseOverflow={(consumes) => onUpdatePlan(`Size ${targetName(i)} to use overflow`, (p) => linkToOverflow(p, i, consumes))}
          capped={capped}
          onUseSupply={(consumes) => onUpdatePlan(`Size ${targetName(i)} to use the bus supply`, (p) => linkToSupply(p, i, consumes))}
        />
      ),
      move: plan.targets.length > 1 && (
        <>
          <button
            type="button"
            className="target-button"
            title="Move up: targets fed back cover what the plan takes from the bus in this order"
            aria-label="Move target up"
            disabled={i === 0}
            onClick={() => moveTo(i - 1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="target-button"
            title="Move down: targets fed back cover what the plan takes from the bus in this order"
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
          // The only target clears instead: a plan always has one (nothing to clear on a blank one).
          title={plan.targets.length > 1 ? 'Remove target' : 'Clear target'}
          aria-label={`${plan.targets.length > 1 ? 'Remove' : 'Clear'} target ${i + 1}`}
          disabled={plan.targets.length === 1 && !t.item}
          onClick={() => {
            setAdded(null)
            onUpdatePlan(`${plan.targets.length > 1 ? 'Remove' : 'Clear'} ${targetName(i)}`, (p) => removeTarget(p, i))
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
  const money = useMemo(() => moneyLedger(plan, result, ledger), [plan, result, ledger])
  // Items the plan overflows (including what overflow targets take), which a target can switch to using.
  const overflowing = money.outputs.filter((o) => o.sources.some((s) => s.target === null)).map((o) => o.item)
  // Items the bus carries a set amount of, which a target can switch to using what's left of.
  const capped = ledger.flatMap((l) => (l.cap !== null ? [{ item: l.item, cap: l.cap, left: Math.max(0, l.cap - l.bus) }] : []))
  // Overflow the plan feeds back in place of the bus or into its money isn't overflow: it gets used.
  const fed = useMemo(() => fedOverflow(money), [money])

  // Whole machines per building type, as built: each tree row rounds up on its own.
  const buildings = useMemo(() => buildingCounts(result.tree, logistics, units.copies), [result.tree, logistics, units])
  const totalMachines = buildings.reduce((t, b) => t + b.count, 0)
  const heatUsers = useMemo(() => resourceUsers(result.tree, logistics, 'heat', units.copies), [result.tree, logistics, units])
  const nutrientUsers = useMemo(() => resourceUsers(result.tree, logistics, 'nutrients', units.copies), [result.tree, logistics, units])

  return (
    <div className="page planner">
      <div className={sideOpen ? 'planner-layout' : 'planner-layout side-closed'}>
        <aside className="planner-side" id="planner-side">
          <button
            className="icon-button side-toggle"
            onClick={() => setSideOpen((o) => !o)}
            aria-controls="planner-side"
            aria-expanded={sideOpen}
            title={sideOpen ? 'Hide upgrades and defaults' : 'Show upgrades and defaults'}
          >
            <SidebarIcon open={sideOpen} />
          </button>
          <section className="panel">
            <h2>Upgrades</h2>
            <p className="hint">Your game&apos;s progress: shared by every plan.</p>
            <ResearchTier
              tier={catalog.tier}
              onChange={(tier) => onProgress('Change research tier', (p) => ({ ...p, tier: tier === MAX_TIER ? undefined : tier }))}
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
                    onProgress(`Change ${u.name} level`, (p) => ({
                      ...p,
                      upgrades: { ...p.upgrades, [u.key]: upgradeLevel({ [u.key]: Number(e.target.value) || 0 }, u) },
                    }))
                  }
                />
              </label>
            ))}
          </section>
          <MyDefaultsPanel defaults={myDefaults} catalog={catalog} onForget={forget} />
        </aside>

        <main className="planner-main" ref={main}>
          <div className="plan-bar panel">
            <select value={plan.id} onChange={(e) => onSelectPlan(e.target.value)} aria-label="Plan">
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {planTitle(p)}
                </option>
              ))}
            </select>
            <input
              className="plan-name"
              value={namedAfterTargets(plan) ? '' : plan.name}
              placeholder={targetsName(plan)}
              title="Leave empty to name the plan after what it makes"
              onChange={(e) => onUpdatePlan('Rename plan', (p) => ({ ...p, name: e.target.value }))}
              aria-label="Plan name"
            />
            <button onClick={onNewPlan}>New</button>
            <button onClick={onDuplicatePlan}>Duplicate</button>
            <button className="danger" onClick={onDeletePlan} disabled={plans.length <= 1}>
              Delete
            </button>
          </div>

          {result.status !== 'ok' && <div className="panel warning" data-flip="unsolved">Could not solve this plan: {result.message}</div>}

          {!model.result ? (
            <div className="panel empty-state" aria-busy>
              <p>Solving…</p>
            </div>
          ) : (
            <>
              <section className="summary" data-flip="summary">
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
                <div className="panel warning" data-flip="deficits">
                  <strong>Can't be met.</strong> The chosen recipes can't supply these items (usually a loop that consumes as much
                  as it makes, or more than the bus carries of them). Pick a different recipe for them, or raise what the bus carries:
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
                <div className="panel warning" data-flip="runaways">
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
                <div className="panel notice" data-flip="beyond">
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
                <div className="panel notice" data-flip="belts">
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
                defaults={
                  <PlanDefaults heat={planDefault(HEAT)} boilers={boilerDefault()} nutrients={planDefault(NUTRIENTS)} money={planDefault(MONEY)} />
                }
                overflowFrom={overflowSources}
                onFeedback={(item, target, on) =>
                  onUpdatePlan(`${on ? 'Feed back' : 'Stop feeding back'} ${itemName(item)}`, (p) =>
                    target === null ? setItemFeedback(p, item, on) : setTargetFeedback(p, target, on),
                  )
                }
                onProvide={(item) => {
                  onUpdatePlan(`Add target for ${itemName(item)}`, (p) => addProvider(p, item))
                  showTarget(plan.targets.length)
                }}
                onUseOverflow={(item, consumes) => {
                  onUpdatePlan(`Use overflow of ${itemName(item)}`, (p) => addOverflowTarget(p, item, consumes))
                  showTarget(plan.targets.length)
                }}
                onCap={(item, cap) => onUpdatePlan(`Change bus supply of ${itemName(item)}`, (p) => setBusSupply(p, item, cap))}
                onUseSupply={(item, consumes) => {
                  onUpdatePlan(`Use bus supply of ${itemName(item)}`, (p) => addSupplyTarget(p, item, consumes))
                  showTarget(plan.targets.length)
                }}
                onShowTarget={showTarget}
                onShowRow={showRow}
                altar={machineTier(KNOWLEDGE_ALTAR) <= catalog.tier ? mods : null}
              />

              <section className="panel tree-panel" data-flip="tree">
                <h2 data-flip="tree-title">Production</h2>
                <ProductionTree
                  key={plan.id}
                  planId={plan.id}
                  tree={result.tree}
                  ledger={ledger}
                  onNetworkFuel={setNetworkBurn}
                  onNetworkSource={setNetworkSupply}
                  catalog={catalog}
                  onProducer={setProducer}
                  onResetProducer={resetProducer}
                  onFindCauldron={onFindCauldron}
                  onReuse={setReuse}
                  onRemember={remember}
                  onForget={unsave}
                  onCatalysts={setCatalysts}
                  onHeight={setHeight}
                  onStack={setStack}
                  onSeparate={setSeparate}
                  onSeparateShared={
                    canSeparate ? () => onUpdatePlan('Build shared items separately', (p) => separateShared(p, catalog)) : undefined
                  }
                  onMergeSingles={canMerge ? () => onUpdatePlan('Merge single-use builds', (p) => mergeSingleUses(p, catalog)) : undefined}
                  logistics={logistics}
                  mods={mods}
                  roundUp={plan.roundUp ?? NO_ROWS}
                  fed={fed}
                  onUseOverflow={(item, consumes) => {
                    onUpdatePlan(`Use overflow of ${itemName(item)}`, (p) => addOverflowTarget(p, item, consumes))
                    showTarget(plan.targets.length)
                  }}
                  onRoundUp={(row, on) => onUpdatePlan(`${on ? 'Round up' : 'Stop rounding up'} ${rowName(row)}`, (p) => setRoundUp(p, row, on))}
                  onMixedFeed={(row, on, inherited) =>
                    onUpdatePlan(`${on ? 'Mix by-products into' : 'Stop mixing by-products into'} ${rowName(row)}`, (p) =>
                      setMixedFeed(p, row, on, inherited),
                    )
                  }
                  units={units}
                  onUnits={(row, unit) =>
                    onUpdatePlan(`Build ${rowName(row)} ${unit ? 'in units' : 'as one line'}`, (p) => setUnits(p, row, unit))
                  }
                  built={plan.built ?? NO_ROWS}
                  onBuilt={(rows, on) =>
                    onUpdatePlan(
                      `${on ? 'Check off' : 'Uncheck'} ${rows.length === 1 ? rowName(rows[0]) : `${rows.length} rows`}`,
                      (p) => setBuilt(p, rows, on),
                    )
                  }
                  targets={plan.targets.map(targetSlot)}
                  onAddTarget={addTarget}
                  shownTarget={shownTarget}
                  shownRow={shownRow}
                />
              </section>

              <div className="two-col" data-flip="totals">
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

/** What a target's item can feed back into: what the plan takes of it from the bus, or (coins) its money. */
type Feeds = 'bus' | 'money' | null

const KNOWLEDGE_ALTAR = 'KnowledgeAltar'

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
function BusPanel({
  ledgers,
  money,
  defaults,
  overflowFrom,
  onFeedback,
  onProvide,
  onCap,
  onUseSupply,
  onUseOverflow,
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
  const totalAltars = altar
    ? money.outputs.reduce((t, o) => {
        const y = exp.get(o.item)
        return t + (y && o.toBus > 0 ? wholeMachines(altarsFor(y, o.toBus, altar)) : 0)
      }, 0)
    : 0
  const fedBack = money.outputs.filter((o) => o.sources.some((s) => isFed(o, s)))
  const out = money.outputs.filter((o) => o.toBus > 0 || o.sources.some((s) => !isFed(o, s)))
  // Items the plan's own fed-back output wholly covers take nothing from the bus: the fed-back
  // strip shows them. A cap the user set keeps its line, so it isn't hidden away.
  const drawing = ledgers.filter((l) => l.bus > 0 || l.short > 0 || l.covered === 0 || l.cap !== null)
  return (
    <section className="panel ledger" data-flip="bus">
      <h2>Bus</h2>
      <div className="bus-flow">
      <div className="ledger-columns">
        <div>
          <h3>In from the bus</h3>
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
          <h3>Out to the bus</h3>
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
                if it all goes to {totalAltars} {buildingNameFor(KNOWLEDGE_ALTAR, totalAltars)} instead of the shop
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

/** Whether the plan feeds this source back in place of the bus or into its money (so it's in a banner, not out). */
const isFed = (row: OutputRow, s: OutputSource) => s.fedBack && row.feeds.length > 0

/** What a source's own overflow targets take of it and what the plan feeds back of it, per minute. */
function sourceUse(s: OutputSource) {
  const fed = Object.values(s.used).reduce((t, n) => t + (n ?? 0), 0)
  const taken = s.taken.reduce((t, x) => t + x.amount, 0)
  return { fed, left: s.amount - fed - taken }
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
function PlanDefaults({
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
              title="Add a target of 0 net /min, fed back: the planner builds what the plan takes of it, after what the targets above it cover. Raise it for a surplus, or remove it to go back to the bus."
              onClick={() => onProvide(ledger.item)}
            >
              Make in plan
            </button>
          )}
        </li>
        {ledger.absorbedBy === null && (
          <li>
            <label className="ledger-what bus-cap" title="What the bus carries of it: the plan's rows share that and fall short past it. Empty: as much as they take.">
              <span className="hint-inline">bus carries</span>
              <input
                type="number"
                min={0}
                step="any"
                placeholder="any"
                value={ledger.cap ?? ''}
                onChange={(e) => onCap(ledger.item, e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)))}
                aria-label={`What the bus carries of ${itemName(ledger.item)}, per minute`}
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
              <span className="hint-inline">{fmt(l.count)}/min off the bus</span>
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
 * up the machines making it.
 */
function OutputLine({
  row,
  overflowFrom,
  onFeedback,
  onUseOverflow,
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
  onShowTarget: (index: number) => void
  /** Shows the next of these rows in the production tree. */
  onShowRow: (ids: string[]) => void
  /** What one is worth at a Knowledge Altar, when the plan has it and it gives EXP. */
  exp: AltarYield | null
  mods: Modifiers | null
}) {
  // Fed-back sources show here only for what's left over of them: their banner has the rest.
  const sources = row.sources.filter((s) => !isFed(row, s) || sourceUse(s).left > 1e-9 * s.amount)
  const [using, setUsing] = useState(false)
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
          if (isFed(row, s))
            return (
              <li key={s.target ?? 'overflow'}>
                <span className="ledger-what">
                  <span>
                    {s.target === null ? 'overflow' : <TargetLink index={s.target} onShow={onShowTarget} />} · {fmt(left)}/min
                    <span className="hint-inline"> left over after the plan {row.feeds.map((f) => FEED_VERB[f]).join(' or ')} it</span>
                  </span>
                </span>
              </li>
            )
          const idle = s.target === null && left > 1e-9 * s.amount
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
                <TakenBy source={s} onShowTarget={onShowTarget} />
              </span>
              {row.feeds.length > 0 && (
                <button
                  className="move-button"
                  title={`Feed it back: the plan ${row.feeds.map((f) => FEED_VERB[f]).join(' or ')} it before taking any from the bus`}
                  onClick={() => onFeedback(row.item, s.target, true)}
                >
                  ← {feedButton(row.feeds)} in plan
                </button>
              )}
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
  const sources = row.sources.filter((s) => isFed(row, s))
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
                title="Stop feeding it back: it all goes out to the bus"
                onClick={() => onFeedback(row.item, s.target, false)}
              >
                Send to bus →
              </button>
            </li>
          )
        })}
      </ul>
    </li>
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
  /** What the item could feed back into, if anything. */
  feedsInto: Feeds
  /** This net-surplus target covers what's left of what the plan takes of its item from the bus. */
  absorbs: boolean
  /** The plan feeds the item back (so net can take some off). */
  fedBack: boolean
  onChange: (patch: Partial<PlanTarget>) => void
}) {
  const unit = target.unit ?? 'items'
  const perMachine = resolved?.perMachine ?? null
  const made = resolved?.made ?? 0
  if (unit === 'overflow' || unit === 'supply')
    return (
      <div
        className="target-amount"
        title={unit === 'overflow' ? 'As many as the overflow it takes makes' : "As many as what it takes of the bus's supply makes"}
      >
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
            <option value="net" title="Left over after the plan takes what it needs of it, in place of the bus">
              net /min
            </option>
          )}
        </select>
      </div>
      {unit === 'net' && absorbs && (
        <>
          <div className="machine-meta" title="Made in all: the net amount, plus what the plan takes of it in place of the bus">
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
              ? 'The plan takes none of it from the bus: nothing to take off'
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
  capped,
  onUseSupply,
}: {
  target: PlanTarget
  resolved: ResolvedTarget | undefined
  /** What the item could feed back into, if anything. */
  feedsInto: Feeds
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
      {unit === 'overflow' && target.consumes ? (
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
            aria-label="Size it by an overflow or the bus's supply instead"
            title="Make as many as the plan's overflow of an item, or what it leaves of the bus's supply of one, makes, instead of a set amount"
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
              <optgroup label="What's left on the bus of">
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
      {feedsInto && (
        <label className="check target-feedback" title="Covers the plan's own need before the bus does, in target order">
          <input type="checkbox" checked={fedBack} onChange={(e) => onFeedback(e.target.checked)} />
          {feedsInto === 'money' ? <>Feed back into the plan&apos;s money</> : <>Feed back in place of the bus</>}
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
        ↪ uses what&apos;s left of the bus&apos;s <ItemLabel item={consumes} size={16} />
        {use && use.taken > 0 && <span className="hint-inline"> · {fmt(use.taken)}/min</span>}
      </div>
      {use && !use.uses ? (
        <div className="note-line warn-text">
          ⚠ Its recipes don&apos;t take {name} from the bus: pick ones that do in the rows below, or it makes none.
        </div>
      ) : use && !use.capped ? (
        <div className="note-line warn-text">
          ⚠ The bus&apos;s {name} has no cap: set what it carries on its line in the bus panel, or it makes none.
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

/** Where an item overflows from: the rows of one kind of machine (by name). */
interface OverflowSource {
  /** The machines, as "Athanors" (or the item made, for rows not made by a machine). */
  label: string
  /** What the rows make, as "Athanors making Copper Powder, Steel Ingot". */
  title: string
  /** The tree rows it overflows from, biggest first. */
  ids: string[]
}

/**
 * Per overflowing item, the rows it overflows from, by machine: the overflow may be their main
 * product or a side one.
 */
function overflowRows(tree: TreeNode[]): Map<string, OverflowSource[]> {
  const found = new Map<string, Map<string, { machines: number; making: Set<string>; rows: TreeNode[] }>>()
  const note = (item: string, n: TreeNode) => {
    const machine = n.run?.process.machine?.name ?? ''
    const byMachine = found.get(item) ?? new Map()
    found.set(item, byMachine)
    const g = byMachine.get(machine) ?? { machines: 0, making: new Set(), rows: [] }
    byMachine.set(machine, g)
    g.machines += n.machines
    g.making.add(itemName(n.item))
    g.rows.push(n)
  }
  const visit = (n: TreeNode) => {
    if (n.overflow > 0) note(n.item, n)
    for (const b of n.byproducts) if (b.overflow > 0) note(b.item, n)
    n.children.forEach(visit)
  }
  tree.forEach(visit)
  return new Map(
    [...found].map(([item, byMachine]) => [
      item,
      [...byMachine].map(([machine, g]) => {
        const making = [...g.making].join(', ')
        const label = machine ? machineNameFor(machine, g.machines) : making
        return {
          label,
          title: machine ? `${label} making ${making}` : making,
          ids: g.rows.sort((a, b) => b.machines - a.machines).map((n) => n.id),
        }
      }),
    ]),
  )
}

/** Steps of the plan whose own recipe, machine or purchase needs research beyond `tier`. */
function beyondTier(tree: TreeNode[], tier: number): { item: string; tier: number; what: string }[] {
  const found = new Map<string, { item: string; tier: number; what: string }>()
  const visit = (n: TreeNode) => {
    const p = n.run?.process
    const made = !!p && (n.kind === 'produce' || n.kind === 'byproduct')
    const needs = made ? p.tier : 0
    const seen = found.get(n.item)
    if (made && needs > tier && (!seen || needs < seen.tier))
      found.set(n.item, { item: n.item, tier: needs, what: p.kind === 'buy' ? 'bought at a Purchasing Portal' : (p.machine?.name ?? p.label) })
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

/** A window with its left column drawn, filled while that column shows. */
function SidebarIcon({ open }: { open: boolean }) {
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
                  : d.producer === BUS
                    ? 'from the bus'
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
