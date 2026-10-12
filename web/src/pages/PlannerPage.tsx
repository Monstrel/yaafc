import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { ItemIcon, ItemLabel } from '../components/ItemIcon'
import { ItemPicker } from '../components/ItemPicker'
import { Money } from '../components/Money'
import { PlanOverview } from '../components/PlanOverview'
import { ProducerSelect, TierTag } from '../components/ProducerSelect'
import { ProductionTree } from '../components/ProductionTree'
import type { TargetSlot } from '../components/tree/types'
import { Spinner } from '../components/Spinner'
import { useNoticeable } from '../lib/useNoticeable'
import { ledgers, targetFedBack } from '../lib/ledger'
import { releaseScrollAnchor, useFlip } from '../lib/flip'
import {
  HEAT,
  MAX_TIER,
  MONEY,
  NUTRIENTS,
  coinValue,
  dispatch,
  iconUrl,
  itemName,
  targetItems,
  tierName,
} from '../lib/gameData'
import { altarYield } from '../lib/altar'
import { contractFor, dispatchTerms, licenseName } from '../lib/dispatch'
import { fmt } from '../lib/format'
import { checkLogistics, resourceUsers } from '../lib/logistics'
import { fedOverflow, moneyLedger } from '../lib/money'
import { STEAM_HEAT_ID, defaultProducer } from '../lib/processes'
import type { PlanModel } from '../lib/planModel'
import { namedAfterTargets, planTitle, targetsName } from '../lib/planName'
import {
  addProvider,
  addOverflowTarget,
  addSupplyTarget,
  setBusSupply,
  convertOverflowTarget,
  linkToOverflow,
  linkToSupply,
  migrateCatalysts,
  migrateFeedback,
  migrateInputs,
  migrateLoopFeedback,
  moveTarget,
  removeTarget,
  setItemFeedback,
  setTargetFeedback,
  pruneChoices,
  ownPicks,
  setPlanDefault,
  followDefault,
} from '../lib/choices'
import type { PlanResult } from '../lib/solver'
import { separationsOf } from '../lib/separate'
import { canSeparateShared, mergeSingleUses, organize } from '../lib/separateAll'
import { BOILER_HEAT, parentId, planProducer } from '../lib/unfold'
import { dropUnits, unitScales } from '../lib/units'
import type { TreeNode } from '../lib/tree'
import { altarMods, planBuildings } from '../lib/planSummary'
import { usePersistentState } from '../lib/store'
import { blankTarget, type MyDefaults, type Plan, type PlanTarget, type Progress, type SavedRecipe } from '../lib/types'
import {
  DISPATCH_UPGRADES,
  PLANNER_UPGRADES,
  POTION_BELT,
  SUPPLIER_LICENSES,
  attributeBonus,
  firstLevel,
  maxLevel,
  upgradeLevel,
  type Modifiers,
} from '../lib/upgrades'
import { type Feeds, sourceUse, overflowRows, beyondTier } from '../lib/plannerView'
import { TargetLink } from '../components/planner/TargetLink'
import { BusPanel, PlanDefaults, ResourceUsers } from '../components/planner/BusPanel'
import { TargetAmount, TargetNotes } from '../components/planner/TargetControls'
import { LogisticsLine, ResearchTier, SidebarIcon, MyDefaultsPanel } from '../components/planner/PlanPanels'
import { usePlanActions } from '../components/planner/usePlanActions'
import { useStable } from '../lib/useStable'

/** What each planner upgrade series currently does, shown under its name. */
const UPGRADE_EFFECTS: Record<string, (m: Modifiers) => string> = {
  Conveyer: (m) => `${fmt(m.beltSpeed)} items/min per belt`,
  FactorySpeed: (m) => `×${fmt(m.factorySpeed)} crafting speed`,
  AlchemySkill: (m) => `×${fmt(m.extractor)} Extractor & Alembic output`,
  FuelEfficiency: (m) => `×${fmt(m.fuel)} heat per fuel`,
  FertilizeEfficiency: (m) => `×${fmt(m.fertilizer)} nutrients per fertilizer`,
  AltarEfficiency: (m) => `×${fmt(m.altar)} EXP from relics`,
  ContractProfit: (m) => {
    if (!m.licenses) return 'base dispatch limits and pay'
    const held = { [SUPPLIER_LICENSES.key]: m.licenses }
    return `${licenseName(m.licenses)}: +${fmt(attributeBonus(held, 'ContractNum'))}% dispatch limits, +${fmt(attributeBonus(held, 'ContractProfit'))}% pay`
  },
  SleepTime: (m) => `${fmt(m.dayMinutes)}-minute days${m.dayMinutes < 24 ? ', never going to bed early' : ', no sleep'}`,
}

const UPGRADE_TITLES: Record<string, string> = {
  [SUPPLIER_LICENSES.key]: `Supplier Licenses held, for Dispatch Portal targets: ${dispatch.licenses.join(', ')}`,
  [POTION_BELT.key]: 'Potion Belt level, for Dispatch Portal targets: each level above 1 cuts sleep by 2 hours, so the day lasts longer',
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
  /** Saved cauldron recipes, which every plan's rows can use (for summarizing them all). */
  saved: SavedRecipe[]
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
  saved,
  onSelectPlan,
  onUpdatePlan: updateStoredPlan,
  onNewPlan,
  onDuplicatePlan,
  onDeletePlan,
  onFindCauldron,
  reveal,
  onRevealed,
}: Props) {
  const { mods, catalog } = model
  // An auto-organized plan stays organized through every change, in the same undo step.
  const onUpdatePlan = useCallback(
    (label: string | null, update: (p: Plan) => Plan) =>
      updateStoredPlan(label, (p) => {
        const next = update(p)
        return next.autoOrganize ? organize(next, catalog) : next
      }),
    [updateStoredPlan, catalog],
  )
  // ...and through changes made elsewhere (saved defaults, research tier, another tab).
  const organized = useMemo(() => (plan.autoOrganize ? organize(plan, catalog) : plan), [plan, catalog])
  const result = model.result ?? UNSOLVED
  const slowSolve = useNoticeable(model.solving)
  // Panels and rows glide to where a change puts them, around the one just used.
  const main = useRef<HTMLElement>(null)
  useFlip(main, flipParent)
  // Forget recipe, machine, catalyst, branch and build-separately picks for anything that has left
  // the plan (and build-separately picks that no longer gather anything).
  useEffect(() => {
    if (migrateCatalysts(plan, catalog)) onUpdatePlan(null, (p) => migrateCatalysts(p, catalog) ?? p)
    else if (migrateFeedback(plan, catalog)) onUpdatePlan(null, (p) => migrateFeedback(p, catalog) ?? p)
    else if (migrateInputs(plan)) onUpdatePlan(null, (p) => migrateInputs(p) ?? p)
    else if (migrateLoopFeedback(plan, catalog)) onUpdatePlan(null, (p) => migrateLoopFeedback(p, catalog) ?? p)
    else if (pruneChoices(plan, catalog)) onUpdatePlan(null, (p) => pruneChoices(p, catalog) ?? p)
    else if (organized !== plan) updateStoredPlan(null, (p) => (p === plan ? organized : p))
  }, [plan, catalog, organized, onUpdatePlan, updateStoredPlan])
  // result.targets skips targets with no item chosen yet; line them back up with the targets solved.
  // While a solve for changed targets is on its way, each target takes what was solved for it (or for
  // a target of its item in its place), so none shows another's numbers.
  const solvedTargets = model.solvedTargets ?? []
  let resolvedIndex = 0
  const solvedByPlace = solvedTargets.map((t) => (t.item ? result.targets[resolvedIndex++] : undefined))
  const solvedByTarget = new Map(solvedTargets.map((t, i) => [t, solvedByPlace[i]]))
  const resolvedByRow = plan.targets.map((t, i) =>
    !t.item ? undefined : solvedByTarget.has(t) ? solvedByTarget.get(t) : solvedTargets[i]?.item === t.item ? solvedByPlace[i] : undefined,
  )
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
  // Whether the plan-wide build-separately buttons would change anything (never, auto-organized).
  const canSeparate = useMemo(() => !plan.autoOrganize && canSeparateShared(plan, catalog), [plan, catalog])
  const canMerge = useMemo(() => !plan.autoOrganize && mergeSingleUses(plan, catalog) !== plan, [plan, catalog])
  /** What a target's item could feed back into, if anything: what the plan takes of it from the bus, or its money. */
  const feedsInto = (item: string): Feeds => (coinValue(item) !== null ? 'money' : drawn.has(item) ? 'bus' : null)

  // Targets are set in their own rows of the production tree.
  const [shownTarget, setShownTarget] = useState<{ index: number; n: number } | null>(null)
  const showTarget = (index: number) => setShownTarget((s) => ({ index, n: (s?.n ?? 0) + 1 }))
  // What the tree's rows change, each keeping its identity so rows that didn't change aren't drawn again.
  const actions = usePlanActions({ plan, catalog, tree: result.tree, myDefaults, onUpdatePlan, onMyDefaults, showTarget })
  // The app makes this anew whenever a plan changes: held still, so typing a target amount redraws no rows.
  const findCauldron = useStable(onFindCauldron)
  // Rows shown from links elsewhere on the page: each click on the same rows shows the next of them.
  const [shownRow, setShownRow] = useState<{ id: string; n: number; of: string[] } | null>(null)
  const showRow = (ids: string[]) =>
    setShownRow((s) => {
      const same = s && s.of.join() === ids.join()
      const id = ids[same ? (ids.indexOf(s.id) + 1) % ids.length : 0]
      return { id, n: (s?.n ?? 0) + 1, of: ids }
    })
  // A recipe just put on a row from the Cauldron page: show that row, once the plan has a tree to show
  // it in. Asked for after the tree is drawn, so the tree sees the request arrive (one there when it
  // first draws is taken as already shown). Shown once: coming back to the planner later starts at the top again.
  const hasTree = model.result !== null
  const revealRow = useEffectEvent((row: string) => {
    showRow([row])
    onRevealed()
  })
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the request must come after the tree mounts
    if (reveal && hasTree) revealRow(reveal)
  }, [reveal, hasTree])
  /** The target just added, whose item picker opens. */
  // Whether the upgrades and defaults column shows beside the plan (two-column layout only).
  const [sideOpen, setSideOpen] = usePersistentState<boolean>('planner-side', true, (v) => (typeof v === 'boolean' ? v : undefined), {
    perTab: true,
  })
  // Whether every plan shows, in place of the open one.
  const [overview, setOverview] = usePersistentState<boolean>('plan-overview', false, (v) => (typeof v === 'boolean' ? v : undefined), {
    perTab: true,
  })
  /** Back to the open plan, from its top: the card picked may have been far down the overview. */
  const closeOverview = () => {
    setOverview(false)
    releaseScrollAnchor()
    const top = main.current?.getBoundingClientRect().top ?? 0
    if (top < 0) scrollBy(0, top)
  }
  const onOverviewKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) closeOverview()
  })
  useEffect(() => {
    if (!overview) return
    const listener = (e: KeyboardEvent) => onOverviewKey(e)
    addEventListener('keydown', listener)
    return () => removeEventListener('keydown', listener)
  }, [overview])
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
        // A new item follows its own feedback setting, and is sized to a dispatch limit only if buyers take it.
        const { feedback: _, ...rest } = x
        if (rest.unit === 'dispatch' && !(patch.item && contractFor(patch.item))) delete rest.unit
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
      byMachines: t.unit === 'machines',
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
          dispatchable={!!t.item && !!contractFor(t.item)}
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
          dispatch={t.unit === 'dispatch' ? dispatchTerms(t.item, mods) : null}
          beltSpeed={mods.beltSpeed}
          onFeedback={(on) => onUpdatePlan(`${on ? 'Feed back' : 'Stop feeding back'} ${targetName(i)}`, (p) => setTargetFeedback(p, i, on))}
          sharedWith={sharedWith === i ? null : sharedWith}
          onShowTarget={showTarget}
          onConvert={() =>
            onUpdatePlan(`Give ${targetName(i)} a set amount`, (p) => convertOverflowTarget(p, i, resolvedByRow[i]?.rate ?? 0))
          }
          overflowing={overflowing}
          onUseOverflow={(consumes) => onUpdatePlan(`Size ${targetName(i)} to use overflow`, (p) => linkToOverflow(p, i, consumes))}
          capped={capped}
          onUseSupply={(consumes) => onUpdatePlan(`Size ${targetName(i)} to use an input's supply`, (p) => linkToSupply(p, i, consumes))}
        />
      ),
      move: plan.targets.length > 1 && (
        <>
          <button
            type="button"
            className="target-button"
            title="Move up: targets fed back cover what the plan takes as inputs in this order"
            aria-label="Move target up"
            disabled={i === 0}
            onClick={() => moveTo(i - 1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="target-button"
            title="Move down: targets fed back cover what the plan takes as inputs in this order"
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
  // The plan's upgrades when its research tier has the Knowledge Altar, else null.
  const altar = altarMods(mods, catalog.tier)
  // What's left of each item's overflow that Knowledge Altars could break down, when the plan has them.
  const altarLeft = useMemo(() => {
    if (!altar) return null
    const left = new Map<string, number>()
    for (const o of money.outputs) {
      const s = o.sources.find((s) => s.target === null)
      if (s && altarYield(o.item, altar)) left.set(o.item, sourceUse(s).left)
    }
    return left
  }, [money, altar])
  // Whether an item can go on a Knowledge Altar, when the plan has them.
  const canAltar = useMemo(() => (altar ? (item: string) => !!altarYield(item, altar) : null), [altar])

  // Whole machines per building type, as built: each tree row rounds up on its own, and so do the
  // Knowledge Altars breaking down each item's overflow.
  const buildings = useMemo(
    () => planBuildings(result.tree, logistics, units.copies, money, altar),
    [result.tree, logistics, units, money, altar],
  )
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
            {[...PLANNER_UPGRADES, ...DISPATCH_UPGRADES].map((u) => (
              <label
                className="upgrade-row"
                key={u.key}
                title={
                  u.unlimited
                    ? `Level ${u.levels.length} is the ∞ node; each level above it is one more purchase of it` +
                      (Number.isFinite(maxLevel(u)) ? ` (up to ${maxLevel(u)})` : '')
                    : UPGRADE_TITLES[u.key]
                }
              >
                {u.icon && <img className="upgrade-icon" src={iconUrl(u.icon)!} width={32} height={32} alt="" />}
                <span className="upgrade-name">
                  {u.name}
                  <span className="upgrade-effect">{UPGRADE_EFFECTS[u.key]?.(mods)}</span>
                </span>
                <input
                  type="number"
                  min={firstLevel(u)}
                  max={Number.isFinite(maxLevel(u)) ? maxLevel(u) + firstLevel(u) : undefined}
                  value={upgradeLevel(progress.upgrades, u) + firstLevel(u)}
                  onChange={(e) =>
                    onProgress(`Change ${u.name} level`, (p) => ({
                      ...p,
                      upgrades: {
                        ...p.upgrades,
                        [u.key]: upgradeLevel({ [u.key]: (Number(e.target.value) || 0) - firstLevel(u) }, u),
                      },
                    }))
                  }
                />
              </label>
            ))}
          </section>
          <MyDefaultsPanel defaults={myDefaults} catalog={catalog} onForget={actions.forget} />
        </aside>

        <main className="planner-main" ref={main}>
          <div className="plan-bar panel">
            <button
              className={overview ? 'plans-toggle primary' : 'plans-toggle'}
              aria-pressed={overview}
              onClick={() => setOverview((o) => !o)}
              title={overview ? `Back to “${planTitle(plan)}” (Esc)` : 'See every plan’s inputs and outputs, and switch plans'}
            >
              <span aria-hidden>▦</span> All plans <span className="pill">{plans.length}</span>
            </button>
            {overview ? (
              <>
                <span className="plan-bar-note hint-inline">Pick a plan to open it.</span>
                <button
                  onClick={() => {
                    onNewPlan()
                    closeOverview()
                  }}
                >
                  New
                </button>
              </>
            ) : (
              <>
                <span className="plan-name">
                  <input
                    value={namedAfterTargets(plan) ? '' : plan.name}
                    placeholder={targetsName(plan)}
                    title="Leave empty to name the plan after what it makes"
                    onChange={(e) => onUpdatePlan('Rename plan', (p) => ({ ...p, name: e.target.value }))}
                    aria-label="Plan name"
                  />
                  {/* A slow re-solve: what's below is from before the last change until it's back. */}
                  {slowSolve && model.result && <Spinner label="Solving the plan" />}
                </span>
                <button onClick={onNewPlan}>New</button>
                <button onClick={onDuplicatePlan}>Duplicate</button>
                <button className="danger" onClick={onDeletePlan} disabled={plans.length <= 1}>
                  Delete
                </button>
              </>
            )}
          </div>

          {overview ? (
            <PlanOverview
              plans={plans}
              openId={plan.id}
              model={model}
              progress={progress}
              saved={saved}
              myDefaults={myDefaults}
              onOpen={(id) => {
                onSelectPlan(id)
                closeOverview()
              }}
            />
          ) : (
            <>
              {result.status !== 'ok' && <div className="panel warning" data-flip="unsolved">Could not solve this plan: {result.message}</div>}
              {result.status === 'ok' && result.notice && (
                <div className="panel warning" data-flip="notice">
                  {result.notice}
                </div>
              )}

              {!model.result ? (
                // A quick first solve shows nothing in between: only a slow one says it's working.
                slowSolve && (
                  <div className="panel empty-state" aria-busy>
                    <p>
                      <Spinner /> Solving…
                    </p>
                  </div>
                )
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
                      as it makes, or more than comes in of them as inputs). Pick a different recipe for them, or raise their input supply:
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
                    onAltar={actions.altarOverflow}
                    onCap={(item, cap) => onUpdatePlan(`Change input supply of ${itemName(item)}`, (p) => setBusSupply(p, item, cap))}
                    onUseSupply={(item, consumes) => {
                      onUpdatePlan(`Use input supply of ${itemName(item)}`, (p) => addSupplyTarget(p, item, consumes))
                      showTarget(plan.targets.length)
                    }}
                    onShowTarget={showTarget}
                    onShowRow={showRow}
                    altar={altar}
                  />

                  <section className="panel tree-panel" data-flip="tree">
                    <h2 data-flip="tree-title">Production</h2>
                    <ProductionTree
                      key={plan.id}
                      planId={plan.id}
                      tree={result.tree}
                      ledger={ledger}
                      onNetworkFuel={actions.setNetworkBurn}
                      onNetworkSource={actions.setNetworkSupply}
                      catalog={catalog}
                      onProducer={actions.setProducer}
                      onResetProducer={actions.resetProducer}
                      onFindCauldron={findCauldron}
                      onOutputAltar={actions.outputAltar}
                      onLoopSource={actions.loopSource}
                      onRemember={actions.remember}
                      onForget={actions.unsave}
                      onCatalysts={actions.setCatalysts}
                      onHeight={actions.setHeight}
                      onStack={actions.setStack}
                      onSeparate={actions.setSeparate}
                      onSeparateShared={canSeparate ? actions.separateShared : undefined}
                      onMergeSingles={canMerge ? actions.mergeSingles : undefined}
                      autoOrganize={!!plan.autoOrganize}
                      onAutoOrganize={actions.setAutoOrganize}
                      logistics={logistics}
                      mods={mods}
                      roundUp={plan.roundUp ?? NO_ROWS}
                      fed={fed}
                      onUseOverflow={actions.takeOverflow}
                      altarLeft={altarLeft}
                      onAltar={actions.altarOverflow}
                      canAltar={canAltar}
                      onRoundUp={actions.roundUp}
                      onMixedFeed={actions.mixedFeed}
                      units={units}
                      onUnits={actions.units}
                      built={plan.built ?? NO_ROWS}
                      onBuilt={actions.built}
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
            </>
          )}
        </main>
      </div>
    </div>
  )
}
