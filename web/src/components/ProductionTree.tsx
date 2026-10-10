import { type CSSProperties, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { CATALYSTS, HEAT, MONEY, NUTRIENTS, coinValue, heightMultiplier, isCauldronTarget, itemName, itemsByKey } from '../lib/gameData'
import { fmt, fmtMachines, wholeMachines } from '../lib/format'
import { buildingNameFor, noun } from '../lib/plural'
import { sanitizeStrings } from '../lib/sanitize'
import { followScrollAnchor, releaseScrollAnchor } from '../lib/flip'
import { placePopover } from '../lib/popover'
import { foldKey, usePersistentState } from '../lib/store'
import type { BusUse, FedOverflow } from '../lib/money'
import type { LogisticsCheck } from '../lib/logistics'
import { COIN_STACK, itemsPerSlot, onBelt } from '../lib/machineRate'
import { DEFAULT_BANK_STACK, MAX_BANK_STACK, clampBankStack, type ProcessCatalog } from '../lib/processes'
import { branchIds, onOverflow, type TreeNode } from '../lib/tree'
import { heatNetworks, type HeatNetwork } from '../lib/heatNetworks'
import type { ItemLedger } from '../lib/ledger'
import { rememberChanges, rowsById, type ProducerPick } from '../lib/choices'
import { isTargetRow, parentId, rowItem } from '../lib/unfold'
import type { Separation, Unitizing } from '../lib/types'
import { unitChoices, wholePerCopy, type UnitScales } from '../lib/units'
import type { Modifiers } from '../lib/upgrades'
import { ItemIcon, ItemLabel, SeedNote } from './ItemIcon'
import { AltarDetail } from './Exp'
import { Money } from './Money'
import { OverflowTargetForm } from './OverflowTargetForm'
import { BusDraw, FoldedPick } from './FuelPick'
import { CheckIcon } from './CheckIcon'
import { FlowChartView } from './FlowChartView'
import { HeatView } from './HeatView'
import { ProducerSelect } from './ProducerSelect'
import { RowSearch } from './RowSearch'
import { choosable, reuseInfo } from './rowPicks'

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

/** A target's controls, laid into the tree row that meets it. */
export interface TargetSlot {
  /** The root row meeting the target, once it has one (none without an item). */
  rootId: string | null
  /** In the item column: which item. */
  item: ReactNode
  /** In the rate column: how much of it. */
  amount: ReactNode
  /** Under the recipe: what the amount comes to, and feeding it back. */
  notes: ReactNode
  /** Before the row actions: move up and down. */
  move: ReactNode
  /** In the first row action slot, in line with "build separately" below it. */
  remove: ReactNode
}

/** Where a link points: every row it matches, in tree order. */
type Jump = (n: TreeNode) => boolean
/** Renders a link from a row to the rows `match` picks out (see `ProductionTree`). */
type LinkFn = (from: TreeNode, match: Jump, label: ReactNode, title: string) => ReactNode
/** A row, with the ids of the branches above it. */
interface Placed {
  node: TreeNode
  ancestors: string[]
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

  // Every node with the ids of the branches above it, folded or not.
  const all = useMemo(() => {
    const out: { node: TreeNode; ancestors: string[] }[] = []
    const visit = (nodes: TreeNode[], ancestors: string[]) => {
      for (const node of nodes) {
        out.push({ node, ancestors })
        visit(node.children, [...ancestors, node.id])
      }
    }
    visit(view, [])
    return out
  }, [view])
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
  const checklist = useMemo(() => {
    const isBuilt = (n: TreeNode) => hasMachines(n) && builtRows.has(n.id)
    const builtId = (id: string | undefined) => {
      const n = id === undefined ? undefined : byId.get(id)?.node
      return !!n && isBuilt(n)
    }
    /** Per row: rows with machines below it, and how many of them are marked built. */
    const below = new Map<string, { rows: number; built: number }>()
    /** Rows pointing to machines elsewhere that are built. */
    const auto = new Set<string>()
    let rows = 0
    let done = 0
    const visit = (n: TreeNode): { rows: number; built: number } => {
      const sum = { rows: 0, built: 0 }
      for (const c of n.children) {
        const s = visit(c)
        sum.rows += s.rows + (hasMachines(c) ? 1 : 0)
        sum.built += s.built + (isBuilt(c) ? 1 : 0)
      }
      below.set(n.id, sum)
      if (hasMachines(n)) {
        rows++
        if (isBuilt(n)) done++
      } else if (
        (n.kind === 'separate' && builtId(n.groupId)) ||
        // A loop is made by the nearest row of its item further up the branch.
        (n.kind === 'loop' && builtId(byId.get(n.id)?.ancestors.findLast((a) => byId.get(a)?.node.item === n.item))) ||
        (n.kind === 'byproduct' && n.byproductSources.length > 0 && n.byproductSources.every((s) => builtId(s.id)))
      )
        auto.add(n.id)
      return sum
    }
    view.forEach(visit)
    return { below, auto, rows, done }
  }, [view, byId, builtRows])
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
              label="Organize"
              items={[
                {
                  label: 'Build shared separately',
                  hint: onSeparateShared
                    ? 'gather every item made in more than one row, with the nearest item above all its uses (or at the top of the plan)'
                    : 'nothing is made in more than one row that could be gathered',
                  onClick: onSeparateShared,
                },
                {
                  label: 'Merge single uses',
                  hint: onMergeSingles
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

function TreeRow({
  node: whole,
  depth,
  open,
  onToggle,
  catalog,
  rows,
  rowsOf,
  onProducer,
  onResetProducer,
  onFindCauldron,
  onCatalysts,
  onHeight,
  onStack,
  onMixedFeed,
  onRemember,
  onForget,
  savable,
  onSeparateMenu,
  onFlowChart,
  rounded,
  copies,
  unit,
  allCopies,
  totals,
  pinned,
  onReveal,
  onMachinesMenu,
  fed,
  onUseOverflow,
  altarLeft,
  onAltar,
  canAltar,
  onOutputAltar,
  logistics,
  mods,
  link,
  edges,
  card,
  afterBranch,
  topName,
  target,
  built,
  onCheck,
}: {
  /** The controls of the target the row meets, for a target's own row. */
  target?: TargetSlot
  built: BuiltState
  onCheck: (node: TreeNode, box: HTMLElement) => void
  /** What items built at the top of the plan are shown "with". */
  topName: string
  node: TreeNode
  depth: number
  open: boolean
  onToggle: () => void
  catalog: ProcessCatalog
  /** Rows of this item using a producer of their own. */
  rows: number
  /** Rows per item using a producer of their own (for what the row burns or spreads). */
  rowsOf: Map<string, number>
  onProducer: (pick: ProducerPick) => void
  onResetProducer: (row: string) => void
  onFindCauldron: (row: TreeNode) => void
  /** Loads catalysts into one row's machines. */
  /** Loads catalysts into a row ('inherited': what it loads without its own setting). */
  onCatalysts: (row: string, catalysts: string[], inherited: string[]) => void
  /** Builds a row's machines at a height ('inherited': the height without its own setting). */
  onHeight: (row: string, height: number, inherited: number) => void
  /** Sets the coins a row's Bank Portals output per entry ('inherited': the stack without its own setting). */
  onStack: (row: string, stack: number, inherited: number) => void
  onMixedFeed: (row: string, on: boolean, inherited: boolean) => void
  /** Use as my default: remember how this row and everything below it is made. */
  onRemember: (row: TreeNode) => void
  onForget: (item: string) => void
  /** Using it as my default would change something (else it's made the saved or built-in way). */
  savable: boolean
  onSeparateMenu: (node: TreeNode, button: HTMLElement) => void
  /** Opens the flow chart of the row's branch. */
  onFlowChart: (row: string) => void
  /** The row runs on a whole number of machines, rounded up. */
  rounded: boolean
  /** Copies of the row its numbers are split over (1 = the whole row, as when its unit's totals show). */
  copies: number
  /** The units the row is built in, if it is. */
  unit?: number
  /** Copies of the row built in all. */
  allCopies: number
  /** Its unit's totals are showing (rather than each copy's share). */
  totals: boolean
  /** Its own unit's totals stay showing (clicked). */
  pinned: boolean
  onReveal: (id: string, how: 'enter' | 'leave' | 'pin') => void
  onMachinesMenu: (node: TreeNode, button: HTMLElement) => void
  fed: Map<string, FedOverflow>
  onUseOverflow: (item: string, consumes: string) => void
  altarLeft: Map<string, number> | null
  onAltar: (item: string, on: boolean) => void
  canAltar: ((item: string) => boolean) | null
  onOutputAltar: (row: string, item: string, on: boolean) => void
  logistics: Map<string, LogisticsCheck>
  mods: Modifiers
  link: LinkFn
  edges: Edge[]
  /** Level of the "with" group card this row sits in, if any. */
  card?: number
  afterBranch?: boolean
}) {
  const node = copies === 1 ? whole : shareOf(whole, copies)
  // The overflowing item a target is being picked to use, from this row's overflow note.
  const [using, setUsing] = useState<string | null>(null)
  const picking = (item: string) => ({
    using: using === item,
    onUse: () => setUsing((u) => (u === item ? null : item)),
  })
  if (node.id === PLAN_ROOT)
    return (
      <tr data-node-id={node.id} data-flip={`row:${node.id}`} className="kind-plan depth-0 band band-start" style={bandStyle(edgeX(0))}>
        <td className="tree-item">
          <Edges edges={edges} />
          <div className="tree-cell">
            <button className="fold" onClick={onToggle} aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'}>
              {open ? '▾' : '▸'}
            </button>
            <span className="plan-root-name">All targets</span>
          </div>
        </td>
        <td colSpan={5} />
      </tr>
    )
  // A target with no row of its own yet: just its controls.
  if (target && !node.item)
    return (
      <tr
        data-node-id={node.id}
        data-flip={`row:${node.id}`}
        className={`kind-target target band band-start depth-${Math.min(depth, 1)} ${afterBranch ? 'after-branch' : ''}`}
        style={bandStyle(edgeX(depth))}
      >
        <td className="tree-item">
          <Edges edges={edges} />
          <div className="tree-cell" style={{ paddingLeft: depth * 20 }}>
            <span className="fold-spacer" />
            <div className="target-head">
              {target.item}
              {target.amount}
            </div>
          </div>
        </td>
        <td className="num rate-cell" />
        <td>{target.notes}</td>
        <td colSpan={2} />
        <td className="row-actions">
          <span className="target-actions">{target.move}</span>
          <span className="row-action-slot">{target.remove}</span>
          <span className="row-action-slot" />
          <span className="row-action-slot" />
        </td>
      </tr>
    )

  const p = node.run?.process
  const belts = node.run ? logistics.get(node.run.key) : undefined
  const limited = !!belts && belts.utilization < 1 && node.machines > 0
  // How the numbers were worked out: behind an info icon rather than spelled out on every row.
  const details = [...(p?.notes ?? [])]
  if (belts?.outputCappedAt != null && node.kind === 'produce')
    details.push(`Output capped by its belt at ${fmt(belts.outputCappedAt)}/min per machine`)
  const reuse = reuseInfo(node)
  // Belts it takes to carry this row's items (liquids go by pipe).
  const beltsNeeded = onBelt(node.item)
    ? Math.ceil(node.rate / itemsPerSlot(node.item, node.run?.process.stack) / mods.beltSpeed - 1e-9)
    : 0
  // A recovery row runs the recipe that turns what it recovers into its item: no other pick fits.
  const canChoose = !node.recovery && choosable(node, catalog, reuse)
  const coin = coinValue(node.item)
  const name = itemName(node.item)
  // A fuel, fertilizer or coin row, under the row whose Heat, Nutrients or Money it supplies (folded into it).
  const above = parentId(node.id)
  const burned = above === null ? null : FOLDED_VERB[rowItem(above)] ?? null
  const anchorName = node.separation?.anchor && itemsByKey.get(node.separation.anchor)?.name
  const sources = node.byproductSources.map((s, i) => (
    <span key={s.id}>
      {i > 0 && ', '}
      {link(
        node,
        (n) => n.id === s.id,
        s.label,
        `Show the ${s.label} machines`,
      )}
    </span>
  ))

  // A target's own row is tinted from its edge; rows of a "with" card share the card's tint, its
  // top-level items a deeper one from their own edge so they stand apart like targets.
  const band = target
    ? 'target band band-start'
    : card !== undefined
      ? `in-with ${depth === card ? 'with-top' : ''} band ${endsCard(edges, card) ? 'band-end' : ''}`
      : ''

  const separateAction = node.separation ? (
    <button
      type="button"
      className="tree-action"
      title={`Move ${name} elsewhere in the plan, or merge it back (${mergeHint(node.separation, name)})`}
      aria-label={`Move or merge back ${name}`}
      aria-haspopup="menu"
      onClick={(e) => onSeparateMenu(whole, e.currentTarget)}
    >
      <BoxArrowIcon inward />
    </button>
  ) : (
    node.kind === 'produce' &&
    !node.recovery &&
    depth > 0 && (
      <button
        type="button"
        className="tree-action"
        title={`Build separately: gather the uses of ${name} into one place, at the top of the plan or with an item above it`}
        aria-label={`Build ${name} separately`}
        aria-haspopup="menu"
        onClick={(e) => onSeparateMenu(whole, e.currentTarget)}
      >
        <BoxArrowIcon />
      </button>
    )
  )

  return (
    <tr
      data-node-id={node.id}
      data-flip={`row:${node.id}`}
      className={`kind-${node.kind} depth-${Math.min(depth, 1)} ${node.rate === 0 ? 'idle' : ''} ${totals ? 'unit-totals' : ''} ${built === true ? 'built' : ''} ${band} ${afterBranch ? 'after-branch' : ''}`}
      style={
        target
          ? bandStyle(edgeX(depth))
          : depth === card
            ? ({ ...cardStyle(card), '--top-x': `${edgeX(depth)}px` } as CSSProperties)
            : cardStyle(card)
      }
    >
      <td className="tree-item">
        <Edges edges={edges} />
        <div className="tree-cell" style={{ paddingLeft: depth * 20 }}>
          {node.children.length > 0 ? (
            <button className="fold" onClick={onToggle} aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'}>
              {open ? '▾' : '▸'}
            </button>
          ) : (
            <span className="fold-spacer" />
          )}
          {built === null ? (
            <span className="built-spacer" />
          ) : built === 'auto' ? (
            <span className="built-check auto" role="img" aria-label={`${name} built`} title={autoBuiltHint(node.kind)}>
              <CheckIcon />
            </span>
          ) : (
            <button
              type="button"
              role="checkbox"
              className="built-check"
              aria-checked={built}
              aria-label={`Built ${name}`}
              title={
                built === true
                  ? 'Built in your game. Click to mark it not built yet'
                  : `Mark as built in your game${node.children.length ? ', with everything below it' : ''}${
                      built === 'mixed' ? ' (some rows below it are)' : ''
                    }`
              }
              onClick={(e) => onCheck(whole, e.currentTarget)}
            >
              {built === true ? <CheckIcon /> : built === 'mixed' ? <span className="built-mixed" aria-hidden /> : null}
            </button>
          )}
          {target ? (
            // Its amount sits under the item, not in the Rate column, so it doesn't widen that column.
            <div className="target-head">
              {target.item}
              {target.amount}
            </div>
          ) : (
            <ItemLabel item={node.item} />
          )}
          {unit && (
            <button
              type="button"
              className={`unit-badge${totals ? ' on' : ''}`}
              aria-pressed={pinned}
              title={`${
                allCopies > unit
                  ? `Built ${unit} times over in each copy of the line above (${allCopies} in all)`
                  : `Built ${unit} times over`
              }: the numbers here and below are for one copy. Hover to see the totals, click to keep them showing.`}
              onPointerEnter={(e) => e.pointerType === 'mouse' && onReveal(whole.id, 'enter')}
              onPointerLeave={(e) => e.pointerType === 'mouse' && onReveal(whole.id, 'leave')}
              onClick={() => onReveal(whole.id, 'pin')}
            >
              ×{unit}
            </button>
          )}
        </div>
      </td>
      <td className="num rate-cell">
        {fmt(node.rate)}
        {beltsNeeded > 1 && (
          <div className="machine-meta" title={`${fmt(mods.beltSpeed)} items/min per belt`}>
            {beltsNeeded} belts
          </div>
        )}
      </td>
      <td>
        {node.reusedBy ? (
          <span className="leaf-note">♻ by-product of {sources}</span>
        ) : node.kind === 'loop' ? (
          <span className="leaf-note">↺ made further up this branch (loop)</span>
        ) : node.kind === 'separate' ? (
          <span className="leaf-note">
            ⇲{' '}
            {link(
              node,
              (n) => n.id === node.groupId,
              `with ${node.groupAnchor ? itemsByKey.get(node.groupAnchor)?.name : topName}`,
              `Show where ${name} is built`,
            )}
          </span>
        ) : node.kind === 'overflow' ? (
          <span className="leaf-note" title="What the rest of the plan makes of it and nothing else uses">
            ↪ from the plan&apos;s overflow
          </span>
        ) : (
          <>
            {node.recovery && (
              <span
                className="leaf-note recovery-note"
                title={`Machines make all of their outputs, and each has to go somewhere. These recover what other machines output and nothing else uses (${recovers(node)}), and what they make goes where the ${name} beside them goes`}
              >
                ♻ {p?.label ?? name} · recovers {recovers(node)}
              </span>
            )}
            {canChoose && (
              <ProducerSelect
                item={node.item}
                current={{ producer: node.producer, process: node.run?.process }}
                catalog={catalog}
                onChange={(producer, machine, everywhere) =>
                  onProducer({ item: node.item, producer, machine, row: node.id, everywhere })
                }
                // What a row burns or spreads follows its branch only: plan-wide picks are for ingredients.
                branch={{ rows: burned ? 1 : rows, own: node.ownChoice, mine: node.mine, onReset: () => onResetProducer(node.id) }}
                reuse={reuse}
                // A target's own row always makes it: plan inputs are for the rows using it.
                noImport={isTargetRow(node.id)}
                onFind={isCauldronTarget(node.item) ? () => onFindCauldron(node) : undefined}
                compact
              />
            )}
            {burned && (
              <span className="leaf-note" title={burned.title}>
                {burned.glyph} {burned.done}
              </span>
            )}
            {node.kind === 'bus' &&
              (coin !== null ? (
                <span className="leaf-note">
                  {canChoose ? '' : 'Plan input · '}
                  <Money copper={node.fromBus * coin} suffix="/min" />
                </span>
              ) : (
                !canChoose && <span className="leaf-note">plan input</span>
              ))}
            {details.length > 0 && (
              <span className="info-icon" tabIndex={0} title={details.join('\n')} aria-label={details.join('. ')}>
                ⓘ
              </span>
            )}
            {node.folded?.map((f) => (
              <div key={f.id} className="note-line fuel-pick">
                {FOLDED_VERB[f.item].glyph} {FOLDED_VERB[f.item].does}
                <FoldedPick
                  row={f}
                  host={node.item}
                  rows={rowsOf.get(f.item) ?? 1}
                  catalog={catalog}
                  onProducer={onProducer}
                  onResetProducer={onResetProducer}
                />
                {f.children.map((d) => (
                  <BusDraw
                    key={d.id}
                    node={copies === 1 ? d : shareOf(d, copies)}
                    catalog={catalog}
                    reuse={reuseInfo(d)}
                    onProducer={onProducer}
                    onResetProducer={onResetProducer}
                  />
                ))}
              </div>
            ))}
            {node.consolidated && (
              <div className="note-line">
                ⇱{' '}
                {link(
                  node,
                  (n) => n.kind === 'separate' && n.groupId === node.id,
                  node.separation?.anchor ? `uses below ${anchorName}` : 'all uses across the plan',
                  `Show the branches that use ${name}`,
                )}
              </div>
            )}
            {p?.acceptsCatalysts && node.kind === 'produce' && (
              <div className="catalysts" role="group" aria-label="Catalysts">
                {CATALYSTS.map((c) => {
                  const on = p.catalysts.includes(c.key)
                  return (
                    <button
                      type="button"
                      key={c.key}
                      className={on ? 'catalyst on' : 'catalyst'}
                      aria-pressed={on}
                      title={`${itemsByKey.get(c.key)?.name}: ${c.description} (${c.charges.toLocaleString()} charges)`}
                      onClick={() =>
                        onCatalysts(
                          node.id,
                          on ? p.catalysts.filter((k) => k !== c.key) : [...p.catalysts, c.key],
                          node.defaultCatalysts,
                        )
                      }
                    >
                      <ItemIcon item={c.key} size={16} />
                      {c.effect[0].toUpperCase() + c.effect.slice(1)}
                    </button>
                  )
                })}
              </div>
            )}
            {p?.acceptsHeight && node.kind === 'produce' && (
              <label
                className="build-height"
                title={`The Height its inspect panel shows. The higher up it's built, the greater its output.`}
              >
                Height
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={p.height}
                  onChange={(e) =>
                    onHeight(node.id, Math.max(0, Math.round(Number(e.target.value) || 0)), node.defaultHeight)
                  }
                  aria-label={`Height the ${p.machine?.name ?? 'machines'} are built at`}
                />
                <span className="hint-inline">
                  ×{heightMultiplier(p.height).toLocaleString(undefined, { maximumFractionDigits: 3 })} output
                </span>
              </label>
            )}
            {p?.stack !== undefined && node.kind === 'produce' && (
              <label
                className="bank-stack"
                title={`The Conversion Amount its panel shows: coins in each stack it puts on the belt (1–${MAX_BANK_STACK}). Bigger stacks move more coins per belt.`}
              >
                Conversion amount
                <input
                  type="number"
                  min={1}
                  max={MAX_BANK_STACK}
                  step={1}
                  value={p.stack}
                  onChange={(e) => onStack(node.id, clampBankStack(Number(e.target.value)), node.defaultStack)}
                  aria-label={`Coins the ${p.machine?.name ?? 'machines'} output per belt entry`}
                />
                <span className="hint-inline">
                  up to {fmt(p.stack * mods.beltSpeed)}/min per portal
                </span>
              </label>
            )}
            {node.mixable && node.kind === 'produce' && (
              <div className="catalysts" role="group" aria-label="Crucible feed">
                <button
                  type="button"
                  className={node.mixed ? 'catalyst on' : 'catalyst'}
                  aria-pressed={!!node.mixed}
                  title={`The ${node.mixable.map(itemName).join(' and ')} made below come up the same belt: the crucibles refine them too, each at its own speed, and the machines below run only for what's left`}
                  onClick={() => onMixedFeed(node.id, !node.mixed, node.defaultMixed)}
                >
                  {node.mixable.map((i) => (
                    <ItemIcon key={i} item={i} size={16} />
                  ))}
                  Also refine {node.mixable.map(itemName).join(' and ')}
                </button>
              </div>
            )}
            {node.mixParts && node.mixParts.filter((m) => m.rate > 0).length > 1 && (
              <div className="note-line" title="How the crucibles split up, if each item gets crucibles of its own">
                {node.mixParts.map((m, i) => (
                  <span key={m.item}>
                    {i > 0 && ' · '}
                    <ItemLabel item={m.item} count={m.rate} size={16} /> in {fmtMachines(m.machines)}{' '}
                    {buildingNameFor(p!.machine!.key, wholeMachines(m.machines))}
                  </span>
                ))}
              </div>
            )}
            {node.kind === 'byproduct' && <div className="note-line">♻ by-product of {sources}</div>}
            {node.kind !== 'byproduct' && node.fromByproduct > 0 && !node.reusedApart && (
              <div className="note-line">
                ♻ {fmt(node.fromByproduct)}/min from by-product of {sources}
              </div>
            )}
            {node.overflow > 0 && node.kind === 'produce' && (
              <OverflowNote item={node.item} amount={node.overflow} fed={fed} {...picking(node.item)} />
            )}
            {node.byproducts.map((b) => (
              <div key={b.item} className="note-line">
                also makes <ItemLabel item={b.item} count={b.count} size={16} /> →{' '}
                {b.to.map((t, i) => (
                  <span key={t.id}>
                    {i > 0 && ', '}
                    {(b.to.length > 1 || b.overflow > 0) && `${fmt(t.amount)} `}
                    {link(
                      node,
                      // The line for the by-products, where the row taking them shows one.
                      (n) => n.reusedBy === t.id || (n.id === t.id && !n.reusedApart),
                      t.direct ? `${itemName(rowItem(t.id))} crucibles` : destinationName(t.id, topName),
                      `Show the ${t.direct ? 'crucibles refining it' : `${itemsByKey.get(b.item)?.name ?? b.item} row it feeds`}`,
                    )}
                  </span>
                ))}
                {b.overflow > 0 && (
                  <>
                    {b.to.length > 0 && ', '}
                    <OverflowNote
                      item={b.item}
                      amount={b.overflow}
                      fed={fed}
                      inline
                      counted={b.to.length > 0}
                      {...picking(b.item)}
                    />
                  </>
                )}
                {b.toAltar && (
                  <>
                    {b.to.length > 0 && ', '}
                    <span className="fed-text">{fmt(b.altar)}/min broken down at Knowledge Altars</span>
                  </>
                )}
                {node.kind === 'produce' && !node.recovery && (b.toAltar || canAltar?.(b.item)) && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="tree-link"
                      title={
                        b.toAltar
                          ? 'Let the rest of the plan take it again'
                          : 'Break it down at Knowledge Altars as it comes out: nothing else takes it, so rows using it make their own'
                      }
                      onClick={() => onOutputAltar(node.id, b.item, !b.toAltar)}
                    >
                      {b.toAltar ? 'Route it instead' : 'Send to Knowledge Altars'}
                    </button>
                  </>
                )}
              </div>
            ))}
            {using && (
              <OverflowTargetForm
                item={using}
                altar={
                  altarLeft?.has(using)
                    ? {
                        detail: <AltarDetail item={using} perMinute={altarLeft.get(using)!} mods={mods} />,
                        onPick: () => {
                          onAltar(using, true)
                          setUsing(null)
                        },
                      }
                    : undefined
                }
                onAdd={(item) => {
                  onUseOverflow(item, using)
                  setUsing(null)
                }}
                onCancel={() => setUsing(null)}
              />
            )}
            {p?.license && node.kind === 'produce' && <div className="note-line">needs the {p.license}</div>}
            {node.shortfall > 0 && (
              <div className="note-line warn-text">
                short by {fmt(node.shortfall)}/min
                {node.kind === 'bus' && !node.producer && (
                  <>
                    {': nothing in the plan makes it · '}
                    <button
                      type="button"
                      className="tree-link"
                      title="Bring it in from outside the plan, for every row of it"
                      onClick={() => onProducer({ item: node.item, producer: 'bus', row: node.id })}
                    >
                      Take it in as a plan input
                    </button>
                  </>
                )}
              </div>
            )}
            {node.kind === 'produce' &&
              Object.entries(p?.inputStacks ?? {}).map(([item, stack]) => (
                <div key={item} className="note-line">
                  {itemsByKey.get(item)?.name ?? item} comes from its Bank Portals in stacks of {stack}: a belt carries{' '}
                  {fmt(stack * mods.beltSpeed)}/min of it, not {fmt(COIN_STACK * mods.beltSpeed)}
                </div>
              ))}
            {belts && (belts.multiBelt || limited || belts.inputs.some((f) => f.stack)) && node.kind === 'produce' && (
              <div className="note-line">
                belts per machine:{' '}
                {belts.inputs.map((f) => (
                  <span key={f.item} className={f.belts > 1 ? 'belt-chip multi' : 'belt-chip'}>
                    {itemsByKey.get(f.item)?.name ?? f.item} ×{f.belts}
                  </span>
                ))}
                <span className={limited ? 'belt-limited' : ''}>
                  ({belts.inputBeltsNeeded} of {belts.beltIn} {noun(belts.beltIn, 'input')})
                </span>
              </div>
            )}
          </>
        )}
        {target?.notes}
      </td>
      <td className="num">
        {node.kind === 'produce' && p?.machine && (
          <>
            <button
              type="button"
              className={`machines-button${rounded ? ' rounded' : ''}`}
              title={
                rounded
                  ? 'Rounded up to whole machines: the extra output overflows'
                  : 'Round up to whole machines, or build in units'
              }
              aria-haspopup="menu"
              onClick={(e) => onMachinesMenu(whole, e.currentTarget)}
            >
              <span className="machines-value">{fmt(wholeMachines(node.machines))}</span>
              {fmt(node.machines) !== fmt(wholeMachines(node.machines)) && (
                <span className="machines-used" title="Machines' worth of work this row uses">
                  {' '}
                  ({fmt(node.machines)})
                </span>
              )}
              {rounded && (
                <span className="rounded-mark" aria-label="rounded up">
                  ↑
                </span>
              )}
            </button>
            {limited && (
              <div className="belt-limited" title="Machines needed once conveyor limits slow them down">
                → {belts.utilization > 0 ? fmtMachines(node.machines / belts.utilization) : '∞'} (belts)
              </div>
            )}
            <div className="machine-meta">
              {buildingNameFor(p.machine.key, wholeMachines(node.machines))}
              <SeedNote seed={p.seed} plant={p.product} />
              {copies > 1 && ' per copy'}
            </div>
          </>
        )}
      </td>
      <td className="num heat-cell">
        {node.heat > 0 && `${fmt(node.heat)} P/s`}
        {node.nutrients > 0 && <div className="machine-meta">{fmt(node.nutrients)} nutrients/s</div>}
      </td>
      <td className="row-actions">
        {/* A target's remove button takes the first slot: its own build-separately action moves out front. */}
        {target && (
          <span className="target-actions">
            {separateAction}
            {target.move}
          </span>
        )}
        {/* One slot per action, kept when empty, so the icons line up down the table. */}
        <span className="row-action-slot">{target ? target.remove : separateAction}</span>
        <span className="row-action-slot">
          {node.kind === 'produce' &&
            (savable ? (
              <button
                type="button"
                className="tree-action"
                title={`Use as my default: remember how ${name} and everything below it is made, for every plan`}
                aria-label={`Use this way of making ${name} as my default`}
                onClick={() => onRemember(whole)}
              >
                <BookmarkIcon />
              </button>
            ) : (
              node.mine && (
                <button
                  type="button"
                  className="tree-action saved-default"
                  title={`Made your saved way, in every plan. Click to stop using it as your default: this plan stays as it is`}
                  aria-label={`Stop using this way of making ${name} as my default`}
                  aria-pressed
                  onClick={() => onForget(node.item)}
                >
                  <BookmarkIcon filled />
                </button>
              )
            ))}
        </span>
        <span className="row-action-slot">
          {node.kind === 'produce' && whole.children.length > 0 && (
            <button
              type="button"
              className="tree-action"
              title={`Flow chart: ${name} and what goes into it, loops and by-products included`}
              aria-label={`Show the flow chart of ${name}`}
              aria-haspopup="dialog"
              onClick={() => onFlowChart(whole.id)}
            >
              <FlowIcon />
            </button>
          )}
        </span>
      </td>
    </tr>
  )
}

/** What a recovery row takes in from other machines' outputs: "Impure Gold Dust". */
const recovers = (n: TreeNode) => (n.recovers ?? []).map(itemName).join(' and ')

/** A bookmark: use this row's setup as my default. */
/** A bookmark: outlined, or filled for a saved default. */
export function BookmarkIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ verticalAlign: '-2px' }}
    >
      <path d="M4 2.5h8a.5.5 0 0 1 .5.5v10.5L8 10.5l-4.5 3V3a.5.5 0 0 1 .5-.5Z" />
    </svg>
  )
}

/** Boxes joined left to right: a row's flow chart. */
function FlowIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ verticalAlign: '-2px' }}
    >
      <rect x="1.5" y="2" width="4" height="3.5" rx="1" />
      <rect x="1.5" y="10.5" width="4" height="3.5" rx="1" />
      <rect x="10.5" y="6.25" width="4" height="3.5" rx="1" />
      <path d="M5.5 3.75h1.5a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H5.5M8.5 8h2" />
    </svg>
  )
}

/** Unmarking a row with built rows below it: just the row, or its whole branch. */
function UnmarkMenu({ node, below, onChoose }: { node: TreeNode; below: number; onChoose: (branch: boolean) => void }) {
  return (
    <>
      <div className="tree-menu-title">Mark {itemsByKey.get(node.item)?.name ?? node.item} not built</div>
      <button type="button" role="menuitem" onClick={() => onChoose(false)}>
        <span>
          Just this row
          <span className="tree-menu-hint">
            {below === 1 ? 'the row below it stays' : `the ${below} rows below it stay`} marked built
          </span>
        </span>
      </button>
      <button type="button" role="menuitem" onClick={() => onChoose(true)}>
        <span>
          This row and everything below
          <span className="tree-menu-hint">
            clears {below + 1} {noun(below + 1, 'mark')}
          </span>
        </span>
      </button>
    </>
  )
}

/** A box with an arrow leaving it (build separately), or coming back in (merge back). */
function BoxArrowIcon({ inward = false }: { inward?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11.5 9.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3.5" />
      <path d="M13.5 2.5 7.5 8.5" />
      <path d={inward ? 'M7.5 4.5v4h4' : 'M9.5 2.5h4v4'} />
    </svg>
  )
}

interface ToolbarMenuItem {
  label: string
  hint: string
  /** Absent: the item is shown, but does nothing now (the hint says why). */
  onClick?: () => void
}

/** A toolbar button opening a menu of related actions below it. */
function ToolbarMenu({ label, items, className }: { label: string; items: ToolbarMenuItem[]; className?: string }) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  // The button toggles the menu itself (as its popover target), after the click; this lines it up
  // with the button once it's open, before it's drawn.
  const place = (button: HTMLElement) =>
    requestAnimationFrame(() => {
      const menu = ref.current
      if (menu?.matches(':popover-open')) placePopover(menu, button.getBoundingClientRect())
    })
  return (
    <>
      <button
        type="button"
        className={`compact-button${className ? ` ${className}` : ''}`}
        aria-haspopup="menu"
        popoverTarget={id}
        onClick={(e) => place(e.currentTarget)}
      >
        {label} <span aria-hidden>▾</span>
      </button>
      <div id={id} ref={ref} popover="auto" className="tree-menu" role="menu" aria-label={label}>
        {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={!item.onClick}
              onClick={() => {
                ref.current?.hidePopover()
                item.onClick?.()
              }}
            >
              <span>
                {item.label}
                <span className="tree-menu-hint">{item.hint}</span>
              </span>
            </button>
          ))}
      </div>
    </>
  )
}

type AnchorDecision = 'every' | 'one' | 'lift' | 'cancel'

/** Asks whether to gather an item with every row of an anchor built in several places, or this one. */
function AnchorChoice({
  node,
  anchor,
  count,
  onDecide,
}: {
  node: TreeNode
  anchor: TreeNode
  count: number
  onDecide: (choice: AnchorDecision) => void
}) {
  const item = itemsByKey.get(node.item)?.name ?? node.item
  const at = itemsByKey.get(anchor.item)?.name ?? anchor.item
  return (
    <>
      <h3>
        Gather {item} with which {at}?
      </h3>
      <p>
        {at} is built in {count} places in this plan. Each one can gather the {item} used below it, or just
        this one.
      </p>
      <div className="tree-dialog-actions">
        <button type="button" className="primary" autoFocus onClick={() => onDecide('every')}>
          Every {at} ({count})
        </button>
        <button type="button" onClick={() => onDecide('one')}>
          Only this one
        </button>
        <button type="button" onClick={() => onDecide('cancel')}>
          Cancel
        </button>
      </div>
      {!anchor.consolidated && (
        <p className="tree-dialog-tip">
          Or build {at} separately as well, so there&apos;s a single {at} to gather {item} with:{' '}
          <button type="button" className="tree-link" onClick={() => onDecide('lift')}>
            build {at} separately
          </button>
        </p>
      )}
    </>
  )
}

/** What merging a separated item back undoes. */
function mergeHint(s: Separation, name: string) {
  if (!s.anchor) return `show ${name} under each branch that uses it again`
  const at = itemsByKey.get(s.anchor)?.name ?? s.anchor
  return s.at ? `stop gathering ${name} with this ${at}` : `stop gathering ${name} with every ${at}`
}

/** One row's piece of a branch's card edge: its rounded top, the side, or its rounded bottom. */
interface Edge {
  level: number
  piece: 'top' | 'mid' | 'bottom'
  /** The highlighted edge around a "with" group. */
  accent: boolean
}

/** A table line: an item row, or the divider above an anchor's "with" rows. */
type Line =
  | { kind: 'row'; node: TreeNode; depth: number; card?: number; edges: Edge[]; afterBranch?: boolean }
  | { kind: 'with'; anchor: string; anchorId: string; depth: number; edges: Edge[]; afterBranch?: boolean }

const PLAN_ROOT = 'plan'
/** The root of an item built at the top of the plan (not a row inside it). */
const isTopGroupId = (id: string) => /^separate\/[^/]+$/.test(id)

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

/** A row whose own machines get built in the game: only these can be marked built. */
const hasMachines = (n: TreeNode) => n.kind === 'produce' && !!n.run?.process.machine

/**
 * A row's place on the build checklist: marked built or not ('mixed': only rows below it are),
 * 'auto' for a row pointing to built machines elsewhere, null for a row with nothing to build.
 */
type BuiltState = boolean | 'mixed' | 'auto' | null

/** Why a row pointing to machines elsewhere shows as built. */
function autoBuiltHint(kind: TreeNode['kind']): string {
  if (kind === 'separate') return 'Built: the machines that make it, where it’s built separately, are marked built'
  if (kind === 'loop') return 'Built: the machines further up this branch that make it are marked built'
  return 'Built: the machines whose by-product it is are marked built'
}

/** The row of a target that has none in the tree yet (no item, or not solved yet). */
const pendingId = (index: number) => `target/${index}`

/**
 * The tree as shown: one row per target, in the plan's order (a bare one for a target the tree
 * has no row for yet). Items built at the top of the plan join the target as a "with" group, or,
 * with several targets, an "All targets" row holding the targets and the group. Also the row each
 * target sits in. Rows partly covered by by-products show them on a line of their own.
 */
function viewOf(tree: TreeNode[], rootIds: (string | null)[]): { view: TreeNode[]; slotRows: string[] } {
  const roots = new Map(tree.map((n) => [n.id, withReused(n)]))
  // Rows of targets that have since moved or gone wait for the next solve.
  const targets = rootIds.map((id, i) => (id && roots.get(id)) || blankRow(pendingId(i)))
  const slotRows = targets.map((n) => n.id)
  const groups = tree.filter((n) => n.id.startsWith('separate/')).map(withReused)
  if (!groups.length) return { view: targets, slotRows }
  const made = targets.filter((n) => n.item)
  if (made.length === 1)
    return { view: targets.map((n) => (n === made[0] ? { ...n, children: [...n.children, ...groups] } : n)), slotRows }
  return { view: [blankRow(PLAN_ROOT, [...targets, ...groups])], slotRows }
}

/** Line id suffix for the by-products covering part of a row. */
const REUSED_LINE = '#reused'

/** Heat, Nutrients and Money rows: shown as a pick on the row they heat, feed or pay for, not rows of their own. */
const isFolded = (n: TreeNode) => n.item === HEAT || n.item === NUTRIENTS || n.item === MONEY

/**
 * A fuel, fertilizer or coin taken whole off the bus: nothing to build or follow below it, so it
 * reads on the line picking what the row burns, spreads or pays with rather than as a row.
 */
const isDraw = (n: TreeNode) => n.kind === 'bus' && !n.children.length && n.fromByproduct <= 1e-9 && !n.consolidated

/** How a folded row reads: on the row it's folded into, and on the fuel, fertilizer or coin row below it. */
const FOLDED_VERB: Record<string, { glyph: string; does: string; done: string; title: string }> = {
  [HEAT]: { glyph: '🔥', does: 'burns', done: 'burned', title: 'Burned for the heat of the machines above' },
  [NUTRIENTS]: { glyph: '🌱', does: 'spreads', done: 'spread', title: 'Spread on the nurseries above' },
  [MONEY]: { glyph: '🪙', does: 'pays with', done: 'spent', title: 'Paid into the Purchasing Portals above' },
}

/**
 * A row as shown. Its Heat and Nutrients rows fold into it: what it burns or spreads is picked on
 * its own row, the fuel or fertilizer rows sitting with its ingredients. Each ingredient partly
 * covered by other rows' by-products shows as the two feeds its machines get: the by-products, on a
 * line of their own, then what the ingredient's row makes (or buys) itself. A row gathering an
 * item built separately stays whole.
 */
function withReused(n: TreeNode): TreeNode {
  const partly = (c: TreeNode) =>
    (c.kind === 'produce' || c.kind === 'bus') &&
    !c.consolidated &&
    c.fromByproduct > 1e-9 &&
    c.rate - c.fromByproduct > 1e-9
  const folded = n.children.filter(isFolded)
  // Each child with the by-product line shown above it, if any, and the rows recovering outputs into
  // its supply after it: they stay together. The recovery rows feed this row alongside the child,
  // not the child's machines, so they sit beside it (a row gathering an item built separately
  // keeps them: what it feeds isn't the row above it).
  const feeds = n.children.flatMap((c) => (isFolded(c) ? c.children.filter((f) => !isDraw(f)) : [c])).map((child) => {
    const whole = withReused(child)
    // Only the rows recovering into this one: those it shows beside it came from further down.
    const joining = new Set(child.consolidated ? [] : child.children.filter((r) => r.recovery).map((r) => r.id))
    if (!joining.size) return withByproductLine(whole)
    const recovered = whole.children.filter((r) => joining.has(r.id))
    const c = { ...whole, rate: whole.rate - whole.fromRecovery, children: whole.children.filter((r) => !joining.has(r.id)) }
    // A row taking only other rows' outputs, all of which come recovered: just the recovery rows.
    const empty = c.kind === 'byproduct' && !c.producer && c.rate <= 1e-9 && !c.children.length
    return [...(empty ? [] : withByproductLine(c)), ...recovered]
  })
  // Smallest branches first, so a leaf (a fuel off the bus, say) sits right under the row it feeds
  // rather than below a deep sibling. Rows gathered "with" it stay last, under their divider.
  const key = (f: TreeNode[]) => {
    const c = f.find((r) => !r.reusedBy && !r.recovery) ?? f[f.length - 1]
    return isGroupRow(c, 1) ? Number.MAX_SAFE_INTEGER : f.reduce((t, r) => t + rowCount(r), 0)
  }
  return {
    ...n,
    // Each with what it takes off the bus, if that's all it takes.
    ...(folded.length > 0 && { folded: folded.map((f) => ({ ...f, children: f.children.filter(isDraw) })) }),
    children: feeds
      .map((f) => ({ f, size: key(f) }))
      .sort((a, b) => a.size - b.size)
      .flatMap(({ f }) => f),
  }

  /** A row, after the line for the part of it other rows' by-products cover, if any. */
  function withByproductLine(c: TreeNode): TreeNode[] {
    if (!partly(c)) return [c]
    const line: TreeNode = {
      ...blankRow(`${c.id}${REUSED_LINE}`),
      item: c.item,
      kind: 'byproduct',
      rate: c.fromByproduct,
      fromByproduct: c.fromByproduct,
      byproductSources: c.byproductSources,
      reusedBy: c.id,
    }
    return [line, { ...c, rate: c.rate - c.fromByproduct, reusedApart: true }]
  }
}

/** Rows shown in a branch, its own included. */
const rowCount = (n: TreeNode): number => 1 + n.children.reduce((sum, c) => sum + rowCount(c), 0)

/** A row standing for something other than an item: all targets, or a target with no item. */
function blankRow(id: string, children: TreeNode[] = []): TreeNode {
  return {
    id,
    item: '',
    kind: 'produce',
    rate: 0,
    machines: 0,
    heat: 0,
    nutrients: 0,
    overflow: 0,
    byproducts: [],
    fromByproduct: 0,
    byproductSources: [],
    fromBus: 0,
    shortfall: 0,
    fromRecovery: 0,
    producer: '',
    ownChoice: false,
    mine: false,
    defaultCatalysts: [],
    defaultHeight: 0,
    defaultStack: DEFAULT_BANK_STACK,
    defaultMixed: false,
    children,
  }
}

/**
 * What a row of a by-product feeds: the item of the row above it, or, at the top of the plan, the
 * target itself or the separate build gathering it.
 */
function destinationName(id: string, topName: string): string {
  const name = itemsByKey.get(rowItem(id))?.name ?? rowItem(id)
  const up = parentId(id)
  // A target's own row sits under its place in the targets (`0/Sol`).
  if (up === null || /^\d+$/.test(up)) return `${name} target`
  if (up === 'separate') return `${name} (gathered with ${topName})`
  return itemsByKey.get(rowItem(up))?.name ?? rowItem(up)
}

function topAnchorName(tree: TreeNode[]) {
  const targets = tree.filter((n) => !n.id.startsWith('separate/'))
  return targets.length === 1 ? (itemsByKey.get(targets[0].item)?.name ?? targets[0].item) : 'all targets'
}

/** A row gathering separated uses: a top-of-plan group, or one under an anchor. */
const isGroupRow = (node: TreeNode, depth: number) =>
  depth > 0 && (isTopGroupId(node.id) || !!node.separation?.anchor)

/**
 * Lays out the visible lines. Each open branch gets a card edge from its row down to its last
 * descendant, and each anchor's "with" rows get a highlighted one from their divider.
 */
function layoutLines(tree: TreeNode[], collapsed: Set<string>): Line[] {
  const lines: Line[] = []
  const walk = (nodes: TreeNode[], depth: number, card?: number, parent?: TreeNode) => {
    let divided = false
    for (const node of nodes) {
      const group = isGroupRow(node, depth)
      if (group && !divided && parent) {
        divided = true
        lines.push({ kind: 'with', anchor: parent.item, anchorId: parent.id, depth, edges: [] })
      }
      const inCard = group ? depth : card
      lines.push({ kind: 'row', node, depth, card: inCard, edges: [] })
      if (!collapsed.has(node.id)) walk(node.children, depth + 1, inCard, node)
    }
  }
  walk(tree, 0)

  // Edges open at a line and close before the first line at `closeAt` depth or shallower.
  const open: { level: number; closeAt: number; start: number; accent: boolean }[] = []
  const draw = (span: (typeof open)[number], end: number) => {
    for (let k = span.start; k <= end; k++) {
      const piece = k === span.start ? 'top' : k === end ? 'bottom' : 'mid'
      lines[k].edges.push({ level: span.level, piece, accent: span.accent })
    }
  }
  lines.forEach((line, k) => {
    while (open.length && open.at(-1)!.closeAt >= line.depth) draw(open.pop()!, k - 1)
    if (line.kind === 'with') open.push({ level: cardLevel(line.depth), closeAt: line.depth - 1, start: k, accent: true })
    else if (line.node.children.length && !collapsed.has(line.node.id))
      open.push({ level: line.depth, closeAt: line.depth, start: k, accent: false })
  })
  while (open.length) draw(open.pop()!, lines.length - 1)
  // Breathing room after a branch closes, above the line that follows it.
  lines.forEach((line, k) => {
    if (k > 0 && lines[k - 1].edges.some((e) => e.piece === 'bottom')) line.afterBranch = true
  })
  return lines
}

const edgeX = (level: number) => level * 20 + 4 // just left of that level's fold arrow
/** A "with" card's edge: half a level out, leaving room inside it for its rows' own branch edges. */
const cardLevel = (depth: number) => depth - 0.5

/** The card edges passing through a row, one per branch it sits in. */
function Edges({ edges }: { edges: Edge[] }) {
  return edges.map((e) => (
    <span
      key={e.level}
      className={`edge ${e.piece}${e.accent ? ' accent' : ''}`}
      style={{ left: edgeX(e.level) }}
      aria-hidden
    />
  ))
}

/** Where a tinted row's tint starts: at its edge, so the margin outside stays clear. */
const bandStyle = (x: number) => ({ '--band-x': `${x}px` }) as CSSProperties

/** Where a "with" card's tint starts. */
const cardStyle = (level?: number) => (level === undefined ? undefined : bandStyle(edgeX(cardLevel(level))))

/**
 * Whether a row is the last of its "with" card (its edge rounds off there), with no card around it
 * going on below, whose tint would then be cut short.
 */
const endsCard = (edges: Edge[], card: number) =>
  edges.some((e) => e.accent && e.piece === 'bottom' && e.level === cardLevel(card)) &&
  !edges.some((e) => e.accent && e.piece !== 'bottom' && e.level < cardLevel(card))

/**
 * Choices for a row's machine count: just what the plan needs, or the next whole number of
 * machines (as built, input belt limits included), the extra output overflowing.
 */
function MachinesMenu({
  node,
  rounded,
  belts,
  onChoose,
  copiesAbove,
  unit,
  choices,
  onUnits,
}: {
  node: TreeNode
  rounded: boolean
  belts: LogisticsCheck | undefined
  onChoose: (round: boolean) => void
  /** Copies built of the line the row sits in. */
  copiesAbove: number
  /** The units the row is built in, if it is. */
  unit?: number
  /** The units it can be built in. */
  choices: number[]
  onUnits: (count: number | null) => void
}) {
  const machine = node.run?.process.machine
  const utilization = belts?.utilization ?? 1
  const copies = copiesAbove * (unit ?? 1)
  // Rounding is per copy of the row.
  const built = (utilization > 0 ? node.machines / utilization : node.machines) / copies
  const whole = Math.ceil(built - 1e-9)
  const names = (n: number) => (machine ? buildingNameFor(machine.key, n) : noun(n, 'machine'))
  const extra = built > 0 ? (node.rate / copies) * (whole / built - 1) : 0
  const perCopy = copies > 1 ? ' per copy' : ''
  // Units split the row's whole machines (in each copy of the line above), or a row's below it, evenly.
  const splits = wholePerCopy(node, copiesAbove, () => utilization)
  const each = (d: number) => wholePerCopy(node, copiesAbove * d, () => utilization)!
  const rate = node.rate / copiesAbove
  // A row running on overflow can't run faster than it comes: rounded up, its machines run underfed.
  const fed = onOverflow(node)
  return (
    <>
      <div className="tree-menu-title">Machines for {itemsByKey.get(node.item)?.name}</div>
      <button type="button" role="menuitemradio" aria-checked={!rounded} onClick={() => onChoose(false)}>
        <span className="tree-menu-check" aria-hidden>
          {rounded ? '' : '✓'}
        </span>
        <span>
          As needed
          <span className="tree-menu-hint">
            {rounded ? 'just what the plan uses, no overflow' : `${fmt(built)} ${names(built)}${perCopy}`}
          </span>
        </span>
      </button>
      <button type="button" role="menuitemradio" aria-checked={rounded} onClick={() => onChoose(true)}>
        <span className="tree-menu-check" aria-hidden>
          {rounded ? '✓' : ''}
        </span>
        <span>
          Round up to whole machines
          <span className="tree-menu-hint">
            {fed
              ? `${whole} ${names(whole)}${perCopy}, running underfed on the overflow below`
              : rounded
              ? 'the extra output overflows'
              : whole === built || Math.abs(whole - built) < 1e-9
                ? 'already a whole number'
                : `${whole} ${names(whole)}${perCopy}, +${fmt(extra)}/min overflow`}
          </span>
        </span>
      </button>
      {choices.length > 0 && (
        <>
          <div className="tree-menu-title">Build in units</div>
          <button type="button" role="menuitemradio" aria-checked={!unit} onClick={() => onUnits(null)}>
            <span className="tree-menu-check" aria-hidden>
              {unit ? '' : '✓'}
            </span>
            <span>
              One line
              <span className="tree-menu-hint">
                {splits} {names(splits!)} together
              </span>
            </span>
          </button>
          {choices.map((d) => (
            <button type="button" role="menuitemradio" aria-checked={unit === d} key={d} onClick={() => onUnits(d)}>
              <span className="tree-menu-check" aria-hidden>
                {unit === d ? '✓' : ''}
              </span>
              <span>
                ×{d}: {each(d)} {names(each(d))} each{each(d) * d !== splits && `, ${each(d) * d} in all`}
                <span className="tree-menu-hint">
                  everything below built {d} times over, {fmt(rate / d)}/min per copy
                </span>
              </span>
            </button>
          ))}
        </>
      )}
    </>
  )
}

/** A row's share in one of `copies` copies of it: every amount divided among them. */
function shareOf(n: TreeNode, copies: number): TreeNode {
  const k = 1 / copies
  return {
    ...n,
    rate: n.rate * k,
    machines: n.machines * k,
    heat: n.heat * k,
    nutrients: n.nutrients * k,
    overflow: n.overflow * k,
    fromByproduct: n.fromByproduct * k,
    fromBus: n.fromBus * k,
    shortfall: n.shortfall * k,
    byproducts: n.byproducts.map((b) => ({
      ...b,
      count: b.count * k,
      overflow: b.overflow * k,
      altar: b.altar * k,
      to: b.to.map((t) => ({ ...t, amount: t.amount * k })),
    })),
    mixParts: n.mixParts?.map((m) => ({ ...m, rate: m.rate * k, machines: m.machines * k })),
  }
}

const FED_INTO: Record<BusUse, string> = { plan: 'used in the plan in place of the input', money: 'spent in the plan' }

/**
 * What a row makes of an item that nothing uses: the part the plan feeds back in place of the bus
 * or into its money, or breaks down at Knowledge Altars (not overflow: it's dealt with), and the
 * rest, overflowing.
 */
function OverflowNote({
  item,
  amount,
  fed,
  inline,
  counted,
  using,
  onUse,
}: {
  item: string
  amount: number
  fed: Map<string, FedOverflow>
  /** Picking a target to use the overflow is open. */
  using: boolean
  /** Opens or closes picking a target to use the overflow. */
  onUse: () => void
  /** Part of a by-product line rather than a line of its own. */
  inline?: boolean
  /** Show the amount even inline (the by-product also goes elsewhere). */
  counted?: boolean
}) {
  const f = fed.get(item)
  const used = amount * (f?.share ?? 0)
  const left = amount - used
  const parts: ReactNode[] = []
  if (used > 1e-9 * amount) {
    const into = [
      ...(f!.taken?.length ? [`taken by ${f!.taken.map((i) => `Target ${i + 1}`).join(' and ')}`] : []),
      ...f!.into.map((r) => FED_INTO[r]),
      ...(f!.altar ? ['broken down at Knowledge Altars'] : []),
    ]
    parts.push(
      <span key="fed" className="fed-text">
        {fmt(used)}/min {into.join(' and ')}
      </span>,
    )
  }
  if (left > 1e-9 * amount)
    parts.push(
      <button
        key="left"
        className="tree-link warn-text"
        title="Made by this row's machines but used nowhere in the plan: click to add a target that uses it, or break it down at Knowledge Altars"
        aria-expanded={using}
        onClick={onUse}
      >
        {inline ? `${counted || used > 0 ? `${fmt(left)} ` : ''}overflow` : `+${fmt(left)}/min overflow`}
      </button>,
    )
  const joined = parts.flatMap((p, i) => (i ? [', ', p] : [p]))
  return inline ? <>{joined}</> : <div className="note-line">{joined}</div>
}
