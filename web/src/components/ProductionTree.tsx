import { useEffect, useMemo, useRef, useState } from 'react'
import { itemsByKey } from '../lib/gameData'
import { fmt } from '../lib/format'
import { noun } from '../lib/plural'
import { sanitizeStrings } from '../lib/sanitize'
import { followScrollAnchor, releaseScrollAnchor } from '../lib/flip'
import { placePopover } from '../lib/popover'
import { foldKey, usePersistentState } from '../lib/store'
import type { FedOverflow } from '../lib/money'
import type { LogisticsCheck } from '../lib/logistics'
import { type ProcessCatalog } from '../lib/processes'
import { branchIds, type TreeNode } from '../lib/tree'
import { heatNetworks, type HeatNetwork } from '../lib/heatNetworks'
import type { ItemLedger } from '../lib/ledger'
import { rememberChanges, rowsById, type LoopSourceChoice, type ProducerPick } from '../lib/choices'
import { parentId, rowItem } from '../lib/unfold'
import type { Separation, Unitizing } from '../lib/types'
import { unitChoices, wholePerCopy, type UnitScales } from '../lib/units'
import type { Modifiers } from '../lib/upgrades'
import { ItemLabel } from './ItemIcon'
import { FlowChartView } from './FlowChartView'
import { HeatView } from './HeatView'
import { RowSearch } from './RowSearch'
import {
  mergeHint,
  PLAN_ROOT,
  isTopGroupId,
  hasMachines,
  viewOf,
  destinationName,
  topAnchorName,
  layoutLines,
  cardStyle,
  placeAll,
  checklistOf,
  type BuiltState,
  type Placed,
} from '../lib/treeView'
import { BoxArrowIcon } from './tree/icons'
import { UnmarkMenu, ToolbarMenu, type AnchorDecision, AnchorChoice, MachinesMenu } from './tree/menus'
import { type TargetSlot, type Jump, type LinkFn } from './tree/types'
import { TreeRow, Edges } from './tree/TreeRow'

interface Props {
  /** Fold state is remembered per plan. */
  planId: string
  tree: TreeNode[]
  catalog: ProcessCatalog
  onProducer: (pick: ProducerPick) => void
  /** Drops a row's own producer pick. */
  onResetProducer: (row: string) => void
  /** Looks for a new cauldron recipe for a row's item on the Cauldron page. */
  onFindCauldron: (row: TreeNode) => void
  /** Loads catalysts into one row's machines. */
  /** Loads catalysts into a row ('inherited': what it loads without its own setting). */
  onCatalysts: (row: string, catalysts: string[], inherited: string[]) => void
  /** Builds a row's machines at a height ('inherited': the height without its own setting). */
  onHeight: (row: string, height: number, inherited: number) => void
  /** Sets the coins a row's Bank Portals output per entry ('inherited': the stack without its own setting). */
  onStack: (row: string, stack: number, inherited: number) => void
  /** Use as my default: remember how this row and everything below it is made. */
  onRemember: (row: TreeNode) => void
  /** Stop using an item's saved default; this plan keeps being made that way. */
  onForget: (item: string) => void
  /** Builds an item separately or merges it back; `replacing`: where it's gathered now, when moving it. */
  onSeparate: (s: Separation, on: boolean, from?: string, replacing?: Separation) => void
  /** Builds separately every item made in several rows (absent: there's none). */
  onSeparateShared?: () => void
  /** Merges back every item built separately for a single use (absent: there's none). */
  onMergeSingles?: () => void
  /** Whether the plan keeps itself organized (see `Plan.autoOrganize`). */
  autoOrganize: boolean
  onAutoOrganize: (on: boolean) => void
  logistics: Map<string, LogisticsCheck>
  /** Belt speed and coin stacks, for how many belts a row's items need. */
  mods: Modifiers
  /** Rows running on a whole number of machines, rounded up. */
  roundUp: string[]
  onRoundUp: (row: string, on: boolean) => void
  /** Has a crucible row also refine the by-products of the row below it, or only its input ('inherited': without its own setting). */
  onMixedFeed: (row: string, on: boolean, inherited: boolean) => void
  /** Rows built in units, and how many copies of each row are built. */
  units: UnitScales
  /** Builds a row in units, or as one line (null). */
  onUnits: (row: string, unit: Unitizing | null) => void
  /** Rows marked built in the player's game (a checklist: it changes nothing the plan makes). */
  built: string[]
  onBuilt: (rows: string[], on: boolean) => void
  /** Per item, the share of its overflow the plan feeds back in place of the bus or into its money. */
  fed: Map<string, FedOverflow>
  /** Adds a target making `item` from the plan's overflow of `consumes`. */
  onUseOverflow: (item: string, consumes: string) => void
  /**
   * Per item whose overflow can go to Knowledge Altars, what's left of it per minute for them to
   * break down; null when the plan's research tier has no altar.
   */
  altarLeft: Map<string, number> | null
  /** Breaks down what's left of an item's overflow at Knowledge Altars. */
  onAltar: (item: string, on: boolean) => void
  /** Whether an item can go on a Knowledge Altar; null when the plan's research tier has no altar. */
  canAltar: ((item: string) => boolean) | null
  /** Sends one of a row's other outputs to Knowledge Altars as it comes out, or stops. */
  onOutputAltar: (row: string, item: string, on: boolean) => void
  /** Where a row of a target's item in its own chain gets it: the target, fed back, or the plan input. */
  onLoopSource: (row: TreeNode, source: LoopSourceChoice) => void
  /** The plan's targets in order: each is set in its own row at the top of the tree. */
  targets: TargetSlot[]
  onAddTarget: () => void
  /** A target to show (unfolded, scrolled to and pulsed); `n` is bumped for every request. */
  shownTarget: { index: number; n: number } | null
  /** A row to show (unfolded, scrolled to and pulsed); `n` is bumped for every request. */
  shownRow?: { id: string; n: number } | null
  /** What the plan's rows take from the bus, for the heat view's fuel off it. */
  ledger: ItemLedger[]
  /** Picks what every machine on a heat network burns. */
  onNetworkFuel: (net: HeatNetwork, producer: string, machine?: string) => void
  /** Picks where a heat network's fuel comes from, for all its machines at once. */
  onNetworkSource: (net: HeatNetwork, producer: string, machine?: string) => void
}

/** Foldable tree-table: one root per target, each ingredient a child branch with its share of machines. */
export function ProductionTree({
  planId,
  tree,
  catalog,
  onProducer,
  onResetProducer,
  onFindCauldron,
  onCatalysts,
  onHeight,
  onStack,
  onRemember,
  onForget,
  onSeparate,
  onSeparateShared,
  onMergeSingles,
  autoOrganize,
  onAutoOrganize,
  logistics,
  mods,
  roundUp,
  onRoundUp,
  onMixedFeed,
  units,
  onUnits,
  built,
  onBuilt,
  fed,
  onUseOverflow,
  altarLeft,
  onAltar,
  canAltar,
  onOutputAltar,
  onLoopSource,
  targets: slots,
  onAddTarget,
  shownTarget,
  shownRow = null,
  ledger,
  onNetworkFuel,
  onNetworkSource,
}: Props) {
  // The production tree, or the plan's heat by network: a layer of its own, as in the game.
  const [layer, setLayer] = useState<'items' | 'heat'>('items')
  const networks = useMemo(() => heatNetworks(tree), [tree])
  const rounded = useMemo(() => new Set(roundUp), [roundUp])
  // Folded rows survive leaving the planner and reloads (row ids are stable paths).
  const [collapsedIds, setCollapsedIds] = usePersistentState<string[]>(foldKey(planId), [], sanitizeStrings)
  const collapsed = useMemo(() => new Set(collapsedIds), [collapsedIds])
  const setCollapsed = (next: Set<string> | ((c: Set<string>) => Set<string>)) =>
    setCollapsedIds((ids) => {
      const prev = new Set(ids)
      const out = typeof next === 'function' ? next(prev) : next
      return out === prev ? ids : [...out]
    })
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // The slots' controls are new every render: lay out the view only when their rows change.
  const rootIds = JSON.stringify(slots.map((s) => s.rootId))
  const { view, slotRows } = useMemo(() => viewOf(tree, JSON.parse(rootIds)), [tree, rootIds])
  const slotByRow = new Map(slots.map((s, i) => [slotRows[i], s]))
  const targets = view[0]?.id === PLAN_ROOT ? view[0].children : view  /** What items built at the top of the plan are shown "with". */
  const topName = topAnchorName(tree)
  // Rows where "Use as my default" would change something: only those offer it.
  const savable = useMemo(() => {
    const rows = rowsById(tree)
    return new Set([...rows.values()].filter((n) => n.kind === 'produce' && !n.recovery && rememberChanges(catalog, rows, n)).map((n) => n.id))
  }, [tree, catalog])

  const all = useMemo(() => placeAll(view), [view])
  const byId = useMemo(() => new Map(all.map((e) => [e.node.id, e])), [all])
  // Fuel, fertilizer and coins taken off the bus, shown on the row they're for: the row it is.
  const drawnOn = useMemo(
    () => new Map(all.flatMap(({ node }) => (node.folded ?? []).flatMap((f) => f.children.map((d) => [d.id, node.id] as const)))),
    [all],
  )
  // Forget folds on rows that left the plan (but not while it fails to solve and shows nothing).
  useEffect(() => {
    if (byId.size) setCollapsedIds((ids) => (ids.every((id) => byId.has(id)) ? ids : ids.filter((id) => byId.has(id))))
  }, [byId, setCollapsedIds])
  // Rows per item that use a producer of their own: a pick can cover one branch or all of them.
  const rowsOf = useMemo(() => {
    const counts = new Map<string, number>()
    for (const { node } of all)
      for (const n of [node, ...(node.folded ?? []).flatMap((f) => [f, ...f.children])])
        if (n.producer && n.id !== PLAN_ROOT) counts.set(n.item, (counts.get(n.item) ?? 0) + 1)
    return counts
  }, [all])

  // "Build separately" menu: where to gather this row's item (or move it to, when it's gathered already).
  const [menu, setMenu] = useState<{
    node: TreeNode
    anchors: TreeNode[]
    moving?: Separation
    /** The button it opened from. */
    at: DOMRect
  } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu || !menuRef.current) return
    menuRef.current.showPopover()
    // The button sits at the right end of its row: line the menu up with its right edge.
    placePopover(menuRef.current, menu.at, 'right')
  }, [menu])
  const openMenu = (node: TreeNode, button: HTMLElement) => {
    // Top-of-plan groups only sit under the target on screen: their own tree starts at the group.
    const above = (id: string) => {
      const ancestors = byId.get(id)?.ancestors ?? []
      return ancestors.slice(Math.max(ancestors.findIndex(isTopGroupId), 0))
    }
    // A gathered row can move to any row above all its uses, but a target's own row stays put.
    const moving = node.separation
    const targetRow = !!moving && !moving.anchor && !isTopGroupId(node.id)
    const uses = !moving
      ? [node.id]
      : targetRow
        ? []
        : all.filter((e) => e.node.kind === 'separate' && e.node.groupId === node.id).map((e) => e.node.id)
    const common = uses.length ? above(uses[0]).filter((id) => uses.every((u) => above(u).includes(id))) : []
    const here = (a: TreeNode) => !!moving?.anchor && a.item === moving.anchor && (!moving.at || a.id === moving.at)
    const anchors = common
      .filter((id) => id !== PLAN_ROOT)
      .map((id) => byId.get(id)!.node)
      .filter((a) => a.kind === 'produce' && a.item !== node.item && !here(a))
      .reverse()
    setMenu({
      node,
      anchors,
      moving,
      at: button.getBoundingClientRect(),
    })
  }

  // Machines menu: run a row on just what it needs, or round it up to whole machines.
  const [machinesMenu, setMachinesMenu] = useState<{ node: TreeNode; at: DOMRect } | null>(null)
  const machinesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!machinesMenu || !machinesRef.current) return
    machinesRef.current.showPopover()
    placePopover(machinesRef.current, machinesMenu.at, 'right')
  }, [machinesMenu])
  const openMachinesMenu = (node: TreeNode, button: HTMLElement) => {
    setMachinesMenu({ node, at: button.getBoundingClientRect() })
  }
  const chooseRounding = (on: boolean) => {
    machinesRef.current?.hidePopover()
    if (machinesMenu) onRoundUp(machinesMenu.node.id, on)
  }
  const utilization = (n: TreeNode) => logistics.get(n.run!.key)?.utilization ?? 1
  /** Copies built of the line a row sits in (not counting its own units). */
  const copiesAbove = (id: string) => (units.copies.get(id) ?? 1) / (units.own.get(id) ?? 1)
  const chooseUnits = (count: number | null) => {
    machinesRef.current?.hidePopover()
    if (!machinesMenu) return
    const { node } = machinesMenu
    const of = wholePerCopy(node, copiesAbove(node.id), utilization)
    onUnits(node.id, count && of ? { count, of } : null)
  }

  // Build checklist: only rows with machines are built; marking one marks the rows with machines
  // in its branch, and unmarking one with marked rows below it asks whether they go too. Rows
  // pointing to machines elsewhere show as built once those are.
  const builtRows = useMemo(() => new Set(built), [built])
  const checklist = useMemo(() => checklistOf(view, byId, builtRows), [view, byId, builtRows])
  /** The rows with machines in a branch. */
  const branchOf = (n: TreeNode): string[] => [...(hasMachines(n) ? [n.id] : []), ...n.children.flatMap(branchOf)]
  const checkState = (n: TreeNode): BuiltState =>
    hasMachines(n)
      ? builtRows.has(n.id) || (checklist.below.get(n.id)?.built ? 'mixed' : false)
      : checklist.auto.has(n.id)
        ? 'auto'
        : null
  const [unmarkMenu, setUnmarkMenu] = useState<{ node: TreeNode; at: DOMRect } | null>(null)
  const unmarkRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!unmarkMenu || !unmarkRef.current) return
    unmarkRef.current.showPopover()
    placePopover(unmarkRef.current, unmarkMenu.at)
  }, [unmarkMenu])
  const checkRow = (node: TreeNode, box: HTMLElement) => {
    if (!builtRows.has(node.id)) return onBuilt(branchOf(node), true)
    if (!checklist.below.get(node.id)?.built) return onBuilt([node.id], false)
    setUnmarkMenu({ node, at: box.getBoundingClientRect() })
  }
  const unmark = (branch: boolean) => {
    unmarkRef.current?.hidePopover()
    if (unmarkMenu) onBuilt(branch ? branchOf(unmarkMenu.node) : [unmarkMenu.node.id], false)
  }
  /** Folds every branch built all the way down, leaving what's still to build in view. */
  const foldBuilt = () => {
    const fold: string[] = []
    const visit = (n: TreeNode) => {
      const b = checklist.below.get(n.id)
      if (n.children.length && builtRows.has(n.id) && b && b.built === b.rows) fold.push(n.id)
      else n.children.forEach(visit)
    }
    view.forEach(visit)
    setCollapsed((c) => new Set([...c, ...fold]))
  }
  const clearRef = useRef<HTMLDialogElement>(null)
  // The flow chart overlay, opened from a row.
  const [flowRoot, setFlowRoot] = useState<string | null>(null)

  // A unit's ×N badge shows its branch's totals while hovered, or from a click until the next one.
  const [hovered, setHovered] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  const revealed = hovered ?? pinned
  const inRevealed = (id: string) => !!revealed && (id === revealed || !!byId.get(id)?.ancestors.includes(revealed))
  /** Copies a row's numbers are split over: each copy's share, unless its unit's totals are showing. */
  const shownCopies = (id: string) => (inRevealed(id) ? 1 : (units.copies.get(id) ?? 1))
  const reveal = (id: string, how: 'enter' | 'leave' | 'pin') => {
    if (how === 'enter') setHovered(id)
    else if (how === 'leave') setHovered((h) => (h === id ? null : h))
    else setPinned((p) => (p === id ? null : id))
  }

  // Picking an anchor built in several places asks whether to gather under all of them.
  const [confirm, setConfirm] = useState<{
    node: TreeNode
    anchor: TreeNode
    count: number
    moving?: Separation
  } | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (confirm) dialogRef.current?.showModal()
  }, [confirm])
  const chooseAnchor = (node: TreeNode, anchor: TreeNode, moving?: Separation) => {
    menuRef.current?.hidePopover()
    const count = all.filter((e) => e.node.kind === 'produce' && e.node.item === anchor.item).length
    if (count > 1) setConfirm({ node, anchor, count, moving })
    else {
      followGathered(node.item, anchor)
      onSeparate({ item: node.item, anchor: anchor.item }, true, node.id, moving)
    }
  }
  const decide = (choice: AnchorDecision) => {
    dialogRef.current?.close()
    if (!confirm || choice === 'cancel') return
    const { node, anchor, moving } = confirm
    followGathered(node.item, anchor)
    if (choice === 'lift') onSeparate({ item: anchor.item }, true, anchor.id)
    onSeparate({ item: node.item, anchor: anchor.item, ...(choice === 'one' && { at: anchor.id }) }, true, node.id, moving)
  }

  // Bumped on every jump so following the same row twice pulses it again.
  const [pulse, setPulse] = useState<{ id: string; n: number } | null>(null)
  const tbody = useRef<HTMLTableSectionElement>(null)

  /** Rows a link would go to, in tree order. */
  const targetsOf = (match: Jump, from: string) => all.filter(({ node }) => node.id !== from && match(node))

  /** Goes to a row: unfolded, scrolled to and pulsed. */
  const goTo = ({ node, ancestors }: Placed) => {
    setCollapsed((c) => (ancestors.some((a) => c.has(a)) ? new Set([...c].filter((id) => !ancestors.includes(id))) : c))
    setPulse((p) => ({ id: node.id, n: (p?.n ?? 0) + 1 }))
  }

  // A link to several rows lists them to choose from.
  const [places, setPlaces] = useState<{ title: string; rows: Placed[]; at: DOMRect } | null>(null)
  const placesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!places || !placesRef.current) return
    placesRef.current.showPopover()
    placePopover(placesRef.current, places.at)
  }, [places])
  const openPlaces = (title: string, rows: Placed[], button: HTMLElement) => {
    setPlaces({ title, rows, at: button.getBoundingClientRect() })
  }

  useEffect(() => {
    if (!pulse) return
    const row = tbody.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(pulse.id)}"]`)
    if (!row) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    releaseScrollAnchor()
    row.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
    row.classList.remove('pulse')
    void row.offsetWidth // restart the animation
    row.classList.add('pulse')
    const done = () => row.classList.remove('pulse')
    row.addEventListener('animationend', done, { once: true })
    // Only the latest jump pulses.
    return () => {
      row.removeEventListener('animationend', done)
      done()
    }
  }, [pulse])

  // Showing a target (from a link elsewhere on the page, or just added): unfold its row and pulse
  // it, once per request rather than whenever the tree changes under it.
  const show = (shown: string | null | undefined) => {
    const id = (shown && drawnOn.get(shown)) ?? shown
    const ancestors = id ? byId.get(id)?.ancestors : undefined
    if (id && ancestors) {
      setLayer('items')
      setCollapsed((c) => (ancestors.some((a) => c.has(a)) ? new Set([...c].filter((x) => !ancestors.includes(x))) : c))
      setPulse((p) => ({ id, n: (p?.n ?? 0) + 1 }))
    }
  }
  const [shown, setShown] = useState(shownTarget)
  if (shown !== shownTarget) {
    setShown(shownTarget)
    show(shownTarget && slotRows[shownTarget.index])
  }
  // Showing a row the same way (from the bus panel's overflow sources).
  const [shownAt, setShownAt] = useState(shownRow)
  if (shownAt !== shownRow) {
    setShownAt(shownRow)
    show(shownRow?.id)
  }

  /** A link from `from` to the rows `match` picks out; plain text when there are none. */
  const link: LinkFn = (from, match, label, title) => {
    const rows = targetsOf(match, from.id)
    if (!rows.length) return label
    const several = rows.length > 1
    return (
      <button
        type="button"
        className="tree-link"
        title={several ? `${title} (${rows.length} places: choose one)` : title}
        aria-haspopup={several ? 'menu' : undefined}
        onClick={(e) => (several ? openPlaces(title, rows, e.currentTarget) : goTo(rows[0]))}
      >
        {label}
        {several && <span className="tree-link-count">({rows.length})</span>}
      </button>
    )
  }

  const lines = layoutLines(view, collapsed)

  return (
    <>
      <div className="tree-toolbar" data-flip="tree-toolbar">
        <button className="compact-button primary" onClick={onAddTarget}>
          + Add target
        </button>
        <div className="layer-toggle" role="tablist" aria-label="Show">
          <button type="button" role="tab" aria-selected={layer === 'items'} onClick={() => setLayer('items')}>
            Items
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={layer === 'heat'}
            title="The plan's heat by network: the machines heated by one fuel from one place"
            onClick={() => setLayer('heat')}
          >
            🔥 Heat
          </button>
        </div>
        {layer === 'items' && (
          <>
            <ToolbarMenu
              label="View"
              items={[
                { label: 'Expand all', hint: 'show every row', onClick: () => setCollapsed(new Set()) },
                {
                  label: 'Collapse to targets',
                  hint: 'show just the targets and what’s built at the top of the plan',
                  onClick: () => setCollapsed(new Set(targets.flatMap((n) => branchIds(n.children)))),
                },
              ]}
            />
            <ToolbarMenu
              label={autoOrganize ? 'Organize: auto' : 'Organize'}
              items={[
                {
                  label: 'Auto organize',
                  hint: autoOrganize
                    ? 'with every change, shared items are built separately and single uses merged back; choosing where an item is built turns this off'
                    : 'keep the plan organized as it changes: build shared items separately and merge single uses, every time',
                  checked: autoOrganize,
                  onClick: () => onAutoOrganize(!autoOrganize),
                },
                {
                  label: 'Build shared separately',
                  hint: autoOrganize
                    ? 'auto organize does this with every change'
                    : onSeparateShared
                      ? 'gather every item made in more than one row, with the nearest item above all its uses (or at the top of the plan)'
                      : 'nothing is made in more than one row that could be gathered',
                  onClick: onSeparateShared,
                },
                {
                  label: 'Merge single uses',
                  hint: autoOrganize
                    ? 'auto organize does this with every change'
                    : onMergeSingles
                      ? 'merge back every item built separately that has only one use'
                      : 'everything built separately has more than one use',
                  onClick: onMergeSingles,
                },
              ]}
            />
            {checklist.done > 0 && (
              <ToolbarMenu
                label={`${checklist.done} of ${checklist.rows} built`}
                className="built-progress"
                items={[
                  {
                    label: 'Fold built branches',
                    hint: 'fold every branch built all the way down, leaving what’s still to build',
                    onClick: foldBuilt,
                  },
                  {
                    label: 'Clear all marks',
                    hint: 'mark every row of this plan as not built yet',
                    onClick: () => clearRef.current?.showModal(),
                  },
                ]}
              />
            )}
            <RowSearch rows={all} onGo={goTo} />
          </>
        )}
      </div>
      {layer === 'heat' ? (
        <HeatView
          networks={networks}
          ledger={ledger}
          catalog={catalog}
          mods={mods}
          onProducer={onProducer}
          onResetProducer={onResetProducer}
          rowsOf={rowsOf}
          onShow={show}
          onNetworkFuel={onNetworkFuel}
          onNetworkSource={onNetworkSource}
        />
      ) : (
        <div className="tree-scroll">
          <table className="production tree">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Rate /min</th>
                <th>Recipe</th>
                <th className="num">Machines</th>
                <th className="num">Heat</th>
                <th className="row-actions" aria-label="Row actions" />
              </tr>
            </thead>
            <tbody ref={tbody}>
              {lines.map((line) =>
                line.kind === 'with' ? (
                  <tr
                    className={`tree-with in-with band band-start ${line.afterBranch ? 'after-branch' : ''}`}
                    key={`${line.anchorId}/with`}
                    data-flip={`with:${line.anchorId}`}
                    style={cardStyle(line.depth)}
                  >
                    <td colSpan={6}>
                      <Edges edges={line.edges} />
                      <div className="tree-with-label" style={{ marginLeft: line.depth * 20 + 4 }}>
                        with
                        <span className="hint-inline">
                          {line.anchorId === PLAN_ROOT
                            ? 'uses gathered from all targets'
                            : `uses gathered from below ${itemsByKey.get(line.anchor)?.name}`}
                        </span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <TreeRow
                    key={line.node.id}
                    topName={topName}
                    node={line.node}
                    depth={line.depth}
                    edges={line.edges}
                    card={line.card}
                    afterBranch={line.afterBranch}
                    open={!collapsed.has(line.node.id)}
                    onToggle={() => toggle(line.node.id)}
                    catalog={catalog}
                    rows={rowsOf.get(line.node.item) ?? 1}
                    rowsOf={rowsOf}
                    onProducer={onProducer}
                    onResetProducer={onResetProducer}
                    onFindCauldron={onFindCauldron}
                    onCatalysts={onCatalysts}
                    onHeight={onHeight}
                    onStack={onStack}
                    onMixedFeed={onMixedFeed}
                    onRemember={onRemember}
                    onForget={onForget}
                    savable={savable.has(line.node.id)}
                    onSeparateMenu={openMenu}
                    onFlowChart={setFlowRoot}
                    rounded={rounded.has(line.node.id)}
                    copies={shownCopies(line.node.reusedBy ?? line.node.id)}
                    unit={units.own.get(line.node.id)}
                    allCopies={units.copies.get(line.node.reusedBy ?? line.node.id) ?? 1}
                    totals={
                      inRevealed(line.node.reusedBy ?? line.node.id) && (units.copies.get(line.node.reusedBy ?? line.node.id) ?? 1) > 1
                    }
                    pinned={pinned === line.node.id}
                    onReveal={reveal}
                    fed={fed}
                    onUseOverflow={onUseOverflow}
                    altarLeft={altarLeft}
                    onAltar={onAltar}
                    canAltar={canAltar}
                    onOutputAltar={onOutputAltar}
                    onLoopSource={onLoopSource}
                    onMachinesMenu={openMachinesMenu}
                    logistics={logistics}
                    mods={mods}
                    link={link}
                    target={slotByRow.get(line.node.id)}
                    built={checkState(line.node)}
                    onCheck={checkRow}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      <div
        ref={menuRef}
        popover="auto"
        className="tree-menu"
        role="menu"
        onToggle={(e) => e.newState === 'closed' && setMenu(null)}
      >
        {menu && (
          <>
            <div className="tree-menu-title">
              {menu.moving
                ? `Move ${itemsByKey.get(menu.node.item)?.name} to`
                : `Build ${itemsByKey.get(menu.node.item)?.name} separately`}
            </div>
            {(!menu.moving || menu.moving.anchor) && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  menuRef.current?.hidePopover()
                  followGathered(menu.node.item)
                  onSeparate({ item: menu.node.item }, true, menu.node.id, menu.moving)
                }}
              >
                <span className="tree-menu-top" aria-hidden>
                  <BoxArrowIcon />
                </span>
                <span>
                  Top of the plan
                  <span className="tree-menu-hint">every use, gathered with {topName}</span>
                </span>
              </button>
            )}
            {menu.anchors.length > 0 && (
              <div className="tree-menu-title">{menu.moving && !menu.moving.anchor ? 'with' : 'or with'}</div>
            )}
            {menu.anchors.map((a) => (
              <button type="button" role="menuitem" key={a.id} onClick={() => chooseAnchor(menu.node, a, menu.moving)}>
                <ItemLabel item={a.item} size={18} />
              </button>
            ))}
            {menu.moving && (
              <>
                {(menu.moving.anchor || menu.anchors.length > 0) && <div className="tree-menu-title">or</div>}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    menuRef.current?.hidePopover()
                    onSeparate(menu.moving!, false)
                  }}
                >
                  <span className="tree-menu-top" aria-hidden>
                    <BoxArrowIcon inward />
                  </span>
                  <span>
                    Merge back
                    <span className="tree-menu-hint">
                      {mergeHint(menu.moving, itemsByKey.get(menu.node.item)?.name ?? menu.node.item)}
                    </span>
                  </span>
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div
        ref={placesRef}
        popover="auto"
        className="tree-menu"
        role="menu"
        aria-label={places?.title}
        onToggle={(e) => e.newState === 'closed' && setPlaces(null)}
      >
        {places && (
          <>
            <div className="tree-menu-title">{places.title}</div>
            {places.rows.map((row) => {
              const up = parentId(row.node.id)
              // The branches above the row it feeds, from its target (or where it's gathered) down.
              const trail = row.ancestors
                .filter((id) => id !== PLAN_ROOT && id !== up)
                .map((id) => itemsByKey.get(byId.get(id)?.node.item ?? '')?.name)
                .filter(Boolean)
                .join(' › ')
              return (
                <button
                  type="button"
                  role="menuitem"
                  key={row.node.id}
                  onClick={() => {
                    placesRef.current?.hidePopover()
                    goTo(row)
                  }}
                >
                  <span>
                    {up ? <ItemLabel item={rowItem(up)} size={18} /> : destinationName(row.node.id, topName)}
                    <span className="tree-menu-hint">
                      {trail ? `in ${trail} · ` : ''}
                      {fmt(row.node.rate)}/min
                    </span>
                  </span>
                </button>
              )
            })}
          </>
        )}
      </div>

      <div
        ref={machinesRef}
        popover="auto"
        className="tree-menu"
        role="menu"
        onToggle={(e) => e.newState === 'closed' && setMachinesMenu(null)}
      >
        {machinesMenu && (
          <MachinesMenu
            node={machinesMenu.node}
            rounded={rounded.has(machinesMenu.node.id)}
            byMachines={!!slotByRow.get(machinesMenu.node.id)?.byMachines}
            belts={machinesMenu.node.run ? logistics.get(machinesMenu.node.run.key) : undefined}
            onChoose={chooseRounding}
            copiesAbove={copiesAbove(machinesMenu.node.id)}
            unit={units.own.get(machinesMenu.node.id)}
            choices={unitChoices(tree, machinesMenu.node, copiesAbove(machinesMenu.node.id), utilization)}
            onUnits={chooseUnits}
          />
        )}
      </div>

      <div
        ref={unmarkRef}
        popover="auto"
        className="tree-menu"
        role="menu"
        onToggle={(e) => e.newState === 'closed' && setUnmarkMenu(null)}
      >
        {unmarkMenu && (
          <UnmarkMenu
            node={unmarkMenu.node}
            below={checklist.below.get(unmarkMenu.node.id)?.built ?? 0}
            onChoose={unmark}
          />
        )}
      </div>

      {flowRoot && (
        <FlowChartView
          tree={tree}
          rootId={flowRoot}
          built={builtRows}
          onClose={() => setFlowRoot(null)}
          onShow={show}
        />
      )}

      <dialog ref={clearRef} className="tree-dialog">
        <h3>Clear all built marks?</h3>
        <p>
          The {checklist.done} {noun(checklist.done, 'row')} marked built in this plan will be marked as not built
          yet. The plan itself stays as it is.
        </p>
        <div className="tree-dialog-actions">
          <button
            type="button"
            className="primary"
            onClick={() => {
              clearRef.current?.close()
              onBuilt(built, false)
            }}
          >
            Clear marks
          </button>
          <button type="button" autoFocus onClick={() => clearRef.current?.close()}>
            Cancel
          </button>
        </div>
      </dialog>

      <dialog ref={dialogRef} className="tree-dialog" onClose={() => setConfirm(null)}>
        {confirm && (
          <AnchorChoice node={confirm.node} anchor={confirm.anchor} count={confirm.count} onDecide={decide} />
        )}
      </dialog>
    </>
  )
}

/**
 * Building `item` separately (or moving it) with `anchor`, or at the top of the plan: the page
 * follows the row to the one that gathers it, under the anchor row picked if it's there, else under
 * the first row of the anchor's item (it's built under each of them, or lifted to the top).
 */
function followGathered(item: string, anchor?: TreeNode) {
  followScrollAnchor((fresh) => {
    const rows = fresh.filter((k) => k.startsWith('row:')).map((k) => k.slice(4))
    const gathers = rows.filter((id) => {
      const above = parentId(id)
      return anchor
        ? id.endsWith(`/with:${item}`) && above !== null && rowItem(above) === anchor.item
        : id === `separate/${item}`
    })
    const row = gathers.find((id) => parentId(id) === anchor?.id) ?? gathers[0]
    return row && `row:${row}`
  })
}
