import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { CATALYSTS, coinValue, itemsByKey } from '../lib/gameData'
import { fmt } from '../lib/format'
import { buildingNameFor, machineNameFor, noun } from '../lib/plural'
import { sanitizeStrings } from '../lib/sanitize'
import { foldKey, usePersistentState } from '../lib/store'
import type { Resource } from '../lib/ledger'
import type { LogisticsCheck } from '../lib/logistics'
import type { ProcessCatalog } from '../lib/processes'
import { branchIds, type TreeNode } from '../lib/tree'
import { rememberChanges, rowsById, type ProducerPick } from '../lib/choices'
import { parentId, rowItem } from '../lib/unfold'
import type { Separation } from '../lib/types'
import { ItemIcon, ItemLabel } from './ItemIcon'
import { Money } from './Money'
import { ProducerSelect, type ReuseOption } from './ProducerSelect'

interface Props {
  /** Fold state is remembered per plan. */
  planId: string
  tree: TreeNode[]
  catalog: ProcessCatalog
  onProducer: (pick: ProducerPick) => void
  /** Drops a row's own producer pick. */
  onResetProducer: (row: string) => void
  /** Loads catalysts into one row's machines. */
  /** Loads catalysts into a row ('inherited': what it loads without its own setting). */
  onCatalysts: (row: string, catalysts: string[], inherited: string[]) => void
  /** Use as my default: remember how this row and everything below it is made. */
  onRemember: (row: TreeNode) => void
  /** Stop using an item's saved default; this plan keeps being made that way. */
  onForget: (item: string) => void
  onSeparate: (s: Separation, on: boolean) => void
  logistics: Map<string, LogisticsCheck>
  /** Rows running on a whole number of machines, rounded up. */
  roundUp: string[]
  onRoundUp: (row: string, on: boolean) => void
  /** Per item, the share of its overflow the plan feeds back into its own heat or fertilizer. */
  fed: Map<string, { share: number; into: Resource[] }>
}

/** Where a link points: every row it matches, largest share first. */
type Jump = (n: TreeNode) => boolean
/** Renders a link from a row to the rows `match` picks out (see `ProductionTree`). */
type LinkFn = (from: TreeNode, key: string, match: Jump, label: ReactNode, title: string) => ReactNode
/** The link last followed, and which of its rows is showing. */
interface JumpState {
  link: string
  index: number
}

/** Foldable tree-table: one root per target, each ingredient a child branch with its share of machines. */
export function ProductionTree({
  planId,
  tree,
  catalog,
  onProducer,
  onResetProducer,
  onCatalysts,
  onRemember,
  onForget,
  onSeparate,
  logistics,
  roundUp,
  onRoundUp,
  fed,
}: Props) {
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

  const view = useMemo(() => viewOf(tree), [tree])
  const targets = view[0]?.id === PLAN_ROOT ? view[0].children : view
  /** What items built at the top of the plan are shown "with". */
  const topName = topAnchorName(tree)
  const separateByproducts = useMemo(() => byproductsMadeSeparately(tree), [tree])
  // Rows where "Use as my default" would change something: only those offer it.
  const savable = useMemo(() => {
    const rows = rowsById(tree)
    return new Set([...rows.values()].filter((n) => n.kind === 'produce' && rememberChanges(catalog, rows, n)).map((n) => n.id))
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
  // Forget folds on rows that left the plan (but not while it fails to solve and shows nothing).
  useEffect(() => {
    if (byId.size) setCollapsedIds((ids) => (ids.every((id) => byId.has(id)) ? ids : ids.filter((id) => byId.has(id))))
  }, [byId, setCollapsedIds])
  // Rows per item that use a producer of their own: a pick can cover one branch or all of them.
  const rowsOf = useMemo(() => {
    const counts = new Map<string, number>()
    for (const { node } of all)
      if (node.producer && node.id !== PLAN_ROOT) counts.set(node.item, (counts.get(node.item) ?? 0) + 1)
    return counts
  }, [all])

  // "Build separately" menu: where to gather this row's item.
  const [menu, setMenu] = useState<{ node: TreeNode; anchors: TreeNode[]; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (menu) menuRef.current?.showPopover()
  }, [menu])
  const openMenu = (node: TreeNode, button: HTMLElement) => {
    const rect = button.getBoundingClientRect()
    // Top-of-plan groups only sit under the target on screen: their own tree starts at the group.
    const ancestors = byId.get(node.id)?.ancestors ?? []
    const group = ancestors.findIndex(isTopGroupId)
    const anchors = ancestors
      .slice(Math.max(group, 0))
      // A lone target gathers the same uses as the top of the plan: don't offer it twice.
      .filter((id) => id !== PLAN_ROOT && !(targets.length === 1 && id === targets[0].id))
      .map((id) => byId.get(id)!.node)
      .filter((a) => a.kind === 'produce' && a.item !== node.item)
      .reverse()
    // The button sits at the right end of its row: line the 280px menu up with its right edge.
    setMenu({ node, anchors, x: Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288)), y: rect.bottom + 4 })
  }

  // Machines menu: run a row on just what it needs, or round it up to whole machines.
  const [machinesMenu, setMachinesMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null)
  const machinesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (machinesMenu) machinesRef.current?.showPopover()
  }, [machinesMenu])
  const openMachinesMenu = (node: TreeNode, button: HTMLElement) => {
    const rect = button.getBoundingClientRect()
    setMachinesMenu({ node, x: Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288)), y: rect.bottom + 4 })
  }
  const chooseRounding = (on: boolean) => {
    machinesRef.current?.hidePopover()
    if (machinesMenu) onRoundUp(machinesMenu.node.id, on)
  }

  // Picking an anchor built in several places asks whether to gather under all of them.
  const [confirm, setConfirm] = useState<{ node: TreeNode; anchor: TreeNode; count: number } | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (confirm) dialogRef.current?.showModal()
  }, [confirm])
  const chooseAnchor = (node: TreeNode, anchor: TreeNode) => {
    menuRef.current?.hidePopover()
    const count = all.filter((e) => e.node.kind === 'produce' && e.node.item === anchor.item).length
    if (count > 1) setConfirm({ node, anchor, count })
    else onSeparate({ item: node.item, anchor: anchor.item }, true)
  }
  const decide = (choice: AnchorDecision) => {
    dialogRef.current?.close()
    if (!confirm || choice === 'cancel') return
    const { node, anchor } = confirm
    if (choice === 'lift') onSeparate({ item: anchor.item }, true)
    onSeparate({ item: node.item, anchor: anchor.item, ...(choice === 'one' && { at: anchor.id }) }, true)
  }

  const [jump, setJump] = useState<JumpState | null>(null)
  // Bumped on every jump so following the same row twice pulses it again.
  const [pulse, setPulse] = useState<{ id: string; n: number } | null>(null)
  const tbody = useRef<HTMLTableSectionElement>(null)

  /** Rows a link would go to, biggest share first. */
  const targetsOf = (match: Jump, from: string) =>
    all
      .filter(({ node }) => node.id !== from && match(node))
      .sort((a, b) => b.node.machines - a.node.machines || b.node.rate - a.node.rate)

  /** Follows a link: the next of its rows (cycling), unfolded, scrolled to and pulsed. */
  const follow = (link: string, match: Jump, from: string) => {
    const targets = targetsOf(match, from)
    if (!targets.length) return
    const index = jump?.link === link ? (jump.index + 1) % targets.length : 0
    const { node, ancestors } = targets[index]
    setJump({ link, index })
    setCollapsed((c) => (ancestors.some((a) => c.has(a)) ? new Set([...c].filter((id) => !ancestors.includes(id))) : c))
    setPulse((p) => ({ id: node.id, n: (p?.n ?? 0) + 1 }))
  }

  useEffect(() => {
    if (!pulse) return
    const row = tbody.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(pulse.id)}"]`)
    if (!row) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
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

  /** A link from `from` to the rows `match` picks out; plain text when there are none. */
  const link: LinkFn = (from, key, match, label, title) => {
    const id = `${from.id}|${key}`
    const count = targetsOf(match, from.id).length
    if (!count) return label
    const active = jump?.link === id
    return (
      <button
        type="button"
        className="tree-link"
        title={count > 1 ? `${title} (${count} places, click again for the next)` : title}
        onClick={() => follow(id, match, from.id)}
      >
        {label}
        {active && count > 1 && (
          <span className="tree-link-count">
            {jump.index + 1}/{count}
          </span>
        )}
      </button>
    )
  }

  const lines = layoutLines(view, collapsed)

  return (
    <>
      <div className="tree-toolbar">
        <button className="compact-button" onClick={() => setCollapsed(new Set())}>
          Expand all
        </button>
        <button className="compact-button" onClick={() => setCollapsed(new Set(targets.flatMap((n) => branchIds(n.children))))}>
          Collapse to targets
        </button>
      </div>
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
                  className={`tree-with in-with ${line.afterBranch ? 'after-branch' : ''}`}
                  key={`${line.anchorId}/with`}
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
                  separateByproducts={separateByproducts}
                  node={line.node}
                  depth={line.depth}
                  edges={line.edges}
                  card={line.card}
                  afterBranch={line.afterBranch}
                  open={!collapsed.has(line.node.id)}
                  onToggle={() => toggle(line.node.id)}
                  catalog={catalog}
                  rows={rowsOf.get(line.node.item) ?? 1}
                  onProducer={onProducer}
                  onResetProducer={onResetProducer}
                  onCatalysts={onCatalysts}
                  onRemember={onRemember}
                  onForget={onForget}
                  savable={savable.has(line.node.id)}
                  onSeparate={onSeparate}
                  onSeparateMenu={openMenu}
                  rounded={rounded.has(line.node.id)}
                  fed={fed}
                  onMachinesMenu={openMachinesMenu}
                  logistics={logistics}
                  link={link}
                />
              ),
            )}
          </tbody>
        </table>
      </div>

      <div
        ref={menuRef}
        popover="auto"
        className="tree-menu"
        role="menu"
        style={menu ? { left: menu.x, top: menu.y } : undefined}
        onToggle={(e) => e.newState === 'closed' && setMenu(null)}
      >
        {menu && (
          <>
            <div className="tree-menu-title">Build {itemsByKey.get(menu.node.item)?.name} separately</div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                menuRef.current?.hidePopover()
                onSeparate({ item: menu.node.item }, true)
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
            {menu.anchors.length > 0 && <div className="tree-menu-title">or with</div>}
            {menu.anchors.map((a) => (
              <button type="button" role="menuitem" key={a.id} onClick={() => chooseAnchor(menu.node, a)}>
                <ItemLabel item={a.item} size={18} />
              </button>
            ))}
          </>
        )}
      </div>

      <div
        ref={machinesRef}
        popover="auto"
        className="tree-menu"
        role="menu"
        style={machinesMenu ? { left: machinesMenu.x, top: machinesMenu.y } : undefined}
        onToggle={(e) => e.newState === 'closed' && setMachinesMenu(null)}
      >
        {machinesMenu && (
          <MachinesMenu
            node={machinesMenu.node}
            rounded={rounded.has(machinesMenu.node.id)}
            belts={machinesMenu.node.run ? logistics.get(machinesMenu.node.run.key) : undefined}
            onChoose={chooseRounding}
          />
        )}
      </div>

      <dialog ref={dialogRef} className="tree-dialog" onClose={() => setConfirm(null)}>
        {confirm && (
          <AnchorChoice node={confirm.node} anchor={confirm.anchor} count={confirm.count} onDecide={decide} />
        )}
      </dialog>
    </>
  )
}

function TreeRow({
  node,
  depth,
  open,
  onToggle,
  catalog,
  rows,
  onProducer,
  onResetProducer,
  onCatalysts,
  onRemember,
  onForget,
  savable,
  onSeparate,
  onSeparateMenu,
  rounded,
  onMachinesMenu,
  fed,
  logistics,
  link,
  edges,
  card,
  afterBranch,
  topName,
  separateByproducts,
}: {
  /** What items built at the top of the plan are shown "with". */
  topName: string
  /** Per item, the rows making their own that have it as a by-product (shared only if picked). */
  separateByproducts: Map<string, string[]>
  node: TreeNode
  depth: number
  open: boolean
  onToggle: () => void
  catalog: ProcessCatalog
  /** Rows of this item using a producer of their own. */
  rows: number
  onProducer: (pick: ProducerPick) => void
  onResetProducer: (row: string) => void
  /** Loads catalysts into one row's machines. */
  /** Loads catalysts into a row ('inherited': what it loads without its own setting). */
  onCatalysts: (row: string, catalysts: string[], inherited: string[]) => void
  /** Use as my default: remember how this row and everything below it is made. */
  onRemember: (row: TreeNode) => void
  onForget: (item: string) => void
  /** Using it as my default would change something (else it's made the saved or built-in way). */
  savable: boolean
  onSeparate: (s: Separation, on: boolean) => void
  onSeparateMenu: (node: TreeNode, button: HTMLElement) => void
  /** The row runs on a whole number of machines, rounded up. */
  rounded: boolean
  onMachinesMenu: (node: TreeNode, button: HTMLElement) => void
  fed: Map<string, { share: number; into: Resource[] }>
  logistics: Map<string, LogisticsCheck>
  link: LinkFn
  edges: Edge[]
  /** Level of the "with" group card this row sits in, if any. */
  card?: number
  afterBranch?: boolean
}) {
  if (node.id === PLAN_ROOT)
    return (
      <tr data-node-id={node.id} className="kind-plan depth-0">
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

  const p = node.run?.process
  const belts = node.run ? logistics.get(node.run.key) : undefined
  const limited = !!belts && belts.utilization < 1 && node.machines > 0
  // How the numbers were worked out: behind an info icon rather than spelled out on every row.
  const details = [...(p?.notes ?? [])]
  if (belts?.outputCappedAt != null && node.kind === 'produce')
    details.push(`Output capped by its belt at ${fmt(belts.outputCappedAt)}/min per machine`)
  // Rows taking by-products, or set not to, choose between reusing them and making all of the item.
  // Rows taking by-products, set not to, or offered some by rows making their own choose between
  // reusing them and making all of the item.
  const separately = separateByproducts.get(node.item)
  const reuse: ReuseOption | undefined =
    node.fromByproduct > 0 || !node.reuse || node.reuseChosen || separately
      ? {
          on: node.reuse && (node.fromByproduct > 0 || node.reuseChosen),
          covered: node.kind === 'byproduct',
          sources:
            node.fromByproduct > 0
              ? node.byproductSources.map((s) => s.label).join(', ')
              : (separately?.map((s) => `${s} (made separately)`).join(', ') ?? ''),
        }
      : undefined
  const canChoose = !!node.producer && ((catalog.byProduct.get(node.item)?.length ?? 0) > 0 || !!reuse)
  const coin = coinValue(node.item)
  const price = coin ?? itemsByKey.get(node.item)?.buyPrice
  const name = itemsByKey.get(node.item)?.name ?? node.item
  const anchorName = node.separation?.anchor && itemsByKey.get(node.separation.anchor)?.name
  const sources = node.byproductSources.map((s, i) => (
    <span key={s.id}>
      {i > 0 && ', '}
      {link(
        node,
        `from:${s.id}`,
        (n) => n.id === s.id,
        s.label,
        `Show the ${s.label} machines`,
      )}
    </span>
  ))

  return (
    <tr
      data-node-id={node.id}
      className={`kind-${node.kind} depth-${Math.min(depth, 1)} ${node.rate === 0 ? 'idle' : ''} ${card !== undefined ? 'in-with' : ''} ${afterBranch ? 'after-branch' : ''}`}
      style={cardStyle(card)}
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
          <ItemLabel item={node.item} />
        </div>
      </td>
      <td className="num rate-cell">{fmt(node.rate)}</td>
      <td>
        {node.kind === 'loop' ? (
          <span className="leaf-note">↺ made further up this branch (loop)</span>
        ) : node.kind === 'separate' ? (
          <span className="leaf-note">
            ⇲{' '}
            {link(
              node,
              'separate',
              (n) => n.id === node.groupId,
              `with ${node.groupAnchor ? itemsByKey.get(node.groupAnchor)?.name : topName}`,
              `Show where ${name} is built`,
            )}
          </span>
        ) : node.kind === 'bus' ? (
          <span className="leaf-note">from the bus</span>
        ) : (
          <>
            {canChoose && (
              <ProducerSelect
                item={node.item}
                current={{ producer: node.producer, process: node.run?.process }}
                catalog={catalog}
                onChange={(producer, machine, everywhere, reuse) =>
                  onProducer({ item: node.item, producer, machine, row: node.id, everywhere, reuse })
                }
                branch={{ rows, own: node.ownChoice, mine: node.mine, onReset: () => onResetProducer(node.id) }}
                reuse={reuse}
                compact
              />
            )}
            {details.length > 0 && (
              <span className="info-icon" tabIndex={0} title={details.join('\n')} aria-label={details.join('. ')}>
                ⓘ
              </span>
            )}
            {node.consolidated && (
              <div className="note-line">
                ⇱{' '}
                {link(
                  node,
                  'uses',
                  (n) => n.kind === 'separate' && n.groupId === node.id,
                  node.separation?.anchor ? `uses below ${anchorName}` : 'all uses across the plan',
                  `Show the branches that use ${name}`,
                )}
              </div>
            )}
            {node.kind === 'purchase' &&
              (price != null ? (
                <span className="leaf-note">
                  {canChoose ? '' : coin !== null ? 'From the bus · ' : 'Bought · '}
                  <Money copper={node.purchased * price} suffix="/min" />
                </span>
              ) : (
                <span className="tag warn">not sold at portals</span>
              ))}
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
            {node.kind === 'byproduct' && <div className="note-line">♻ by-product of {sources}</div>}
            {node.kind !== 'byproduct' && node.fromByproduct > 0 && (
              <div className="note-line">
                ♻ {fmt(node.fromByproduct)}/min from by-product of {sources}
              </div>
            )}
            {node.kind === 'produce' && node.purchased > 0 && (
              <div className="note-line">{fmt(node.purchased)}/min bought</div>
            )}
            {node.overflow > 0 && node.kind === 'produce' && <OverflowNote item={node.item} amount={node.overflow} fed={fed} />}
            {node.byproducts.map((b) => (
              <div key={b.item} className="note-line">
                also makes <ItemLabel item={b.item} count={b.count} size={16} /> →{' '}
                {b.to.map((t, i) => (
                  <span key={t.id}>
                    {i > 0 && ', '}
                    {(b.to.length > 1 || b.overflow > 0) && `${fmt(t.amount)} `}
                    {link(
                      node,
                      `to:${t.id}`,
                      (n) => n.id === t.id,
                      destinationName(t.id, topName),
                      `Show the ${itemsByKey.get(b.item)?.name ?? b.item} row it feeds`,
                    )}
                  </span>
                ))}
                {b.overflow > 0 && (
                  <>
                    {b.to.length > 0 && ', '}
                    <OverflowNote item={b.item} amount={b.overflow} fed={fed} inline counted={b.to.length > 0} />
                  </>
                )}
              </div>
            ))}
            {p?.license && node.kind === 'produce' && <div className="note-line">needs the {p.license}</div>}
            {node.shortfall > 0 && <div className="note-line warn-text">short by {fmt(node.shortfall)}/min</div>}
            {belts && (belts.multiBelt || limited) && node.kind === 'produce' && (
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
      </td>
      <td className="num">
        {node.kind === 'produce' && p?.machine && (
          <>
            <button
              type="button"
              className={`machines-button${rounded ? ' rounded' : ''}`}
              title={rounded ? 'Rounded up to whole machines: the extra output overflows' : 'Round up to whole machines'}
              aria-haspopup="menu"
              onClick={(e) => onMachinesMenu(node, e.currentTarget)}
            >
              <span className="machines-value">{fmt(node.machines)}</span>
              {rounded && (
                <span className="rounded-mark" aria-label="rounded up">
                  ↑
                </span>
              )}
            </button>
            {limited && (
              <div className="belt-limited" title="Machines needed once conveyor limits slow them down">
                → {belts.utilization > 0 ? fmt(node.machines / belts.utilization) : '∞'} (belts)
              </div>
            )}
            <div className="machine-meta">{buildingNameFor(p.machine.key, node.machines)}</div>
          </>
        )}
      </td>
      <td className="num heat-cell">
        {node.heat > 0 && `${fmt(node.heat)} P/s`}
        {node.nutrients > 0 && <div className="machine-meta">{fmt(node.nutrients)} nutrients/s</div>}
      </td>
      <td className="row-actions">
        {/* One slot per action, kept when empty, so the icons line up down the table. */}
        <span className="row-action-slot">
          {node.separation ? (
            <button
              type="button"
              className="tree-action"
              title={`Merge back: ${mergeHint(node.separation, name)}`}
              aria-label={`Merge ${name} back into the tree`}
              onClick={() => onSeparate(node.separation!, false)}
            >
              <BoxArrowIcon inward />
            </button>
          ) : (
            node.kind === 'produce' &&
            depth > 0 && (
              <button
                type="button"
                className="tree-action"
                title={`Build separately: gather the uses of ${name} into one place, at the top of the plan or with an item above it`}
                aria-label={`Build ${name} separately`}
                aria-haspopup="menu"
                onClick={(e) => onSeparateMenu(node, e.currentTarget)}
              >
                <BoxArrowIcon />
              </button>
            )
          )}
        </span>
        <span className="row-action-slot">
          {node.kind === 'produce' &&
            (savable ? (
              <button
                type="button"
                className="tree-action"
                title={`Use as my default: remember how ${name} and everything below it is made, for every plan`}
                aria-label={`Use this way of making ${name} as my default`}
                onClick={() => onRemember(node)}
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
      </td>
    </tr>
  )
}

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
 * The tree as shown: items built at the top of the plan join the target as a "with" group, or,
 * with several targets, an "All targets" row holding the targets and the group.
 */
function viewOf(tree: TreeNode[]): TreeNode[] {
  const groups = tree.filter((n) => n.id.startsWith('separate/'))
  if (!groups.length) return tree
  const targets = tree.filter((n) => !n.id.startsWith('separate/'))
  if (targets.length === 1) return [{ ...targets[0], children: [...targets[0].children, ...groups] }]
  const plan: TreeNode = {
    id: PLAN_ROOT,
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
    purchased: 0,
    shortfall: 0,
    producer: '',
    ownChoice: false,
    mine: false,
    defaultCatalysts: [],
    reuse: true,
    reuseChosen: false,
    children: [...targets, ...groups],
  }
  return [plan]
}

/**
 * Per item, the rows making their own (taking no by-products) that make it as a by-product, as
 * "Athanors making Impure Copper Powder": they share it only with rows where reuse was picked.
 */
function byproductsMadeSeparately(tree: TreeNode[]): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const visit = (n: TreeNode) => {
    if (!n.reuse)
      for (const b of n.byproducts) {
        const machine = n.run?.process.machine?.name
        const what = itemsByKey.get(n.item)?.name ?? n.item
        found.set(b.item, [...(found.get(b.item) ?? []), machine ? `${machineNameFor(machine, n.machines)} making ${what}` : what])
      }
    n.children.forEach(visit)
  }
  tree.forEach(visit)
  return found
}

/**
 * What a row of a by-product feeds: the item of the row above it, or, at the top of the plan, the
 * target itself or the separate build gathering it.
 */
function destinationName(id: string, topName: string): string {
  const name = itemsByKey.get(rowItem(id))?.name ?? rowItem(id)
  const up = parentId(id)
  if (up === null) return `${name} target`
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
    if (line.kind === 'with') open.push({ level: line.depth, closeAt: line.depth - 1, start: k, accent: true })
    // A "with" row's own children sit inside its group's edge, which already starts at its level.
    else if (line.node.children.length && !collapsed.has(line.node.id) && !isGroupRow(line.node, line.depth))
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

/** Where a "with" card's tint starts: at its edge, so the margin outside stays clear. */
const cardStyle = (level?: number) =>
  level === undefined ? undefined : ({ '--card-x': `${edgeX(level)}px` } as CSSProperties)

/**
 * Choices for a row's machine count: just what the plan needs, or the next whole number of
 * machines (as built, input belt limits included), the extra output overflowing.
 */
function MachinesMenu({
  node,
  rounded,
  belts,
  onChoose,
}: {
  node: TreeNode
  rounded: boolean
  belts: LogisticsCheck | undefined
  onChoose: (round: boolean) => void
}) {
  const machine = node.run?.process.machine
  const utilization = belts?.utilization ?? 1
  const built = utilization > 0 ? node.machines / utilization : node.machines
  const whole = Math.ceil(built - 1e-9)
  const names = (n: number) => (machine ? buildingNameFor(machine.key, n) : noun(n, 'machine'))
  const extra = built > 0 ? node.rate * (whole / built - 1) : 0
  return (
    <>
      <div className="tree-menu-title">Machines for {itemsByKey.get(node.item)?.name}</div>
      <button type="button" role="menuitemradio" aria-checked={!rounded} onClick={() => onChoose(false)}>
        <span className="tree-menu-check" aria-hidden>
          {rounded ? '' : '✓'}
        </span>
        <span>
          As needed
          <span className="tree-menu-hint">{rounded ? 'just what the plan uses, no overflow' : `${fmt(built)} ${names(built)}`}</span>
        </span>
      </button>
      <button type="button" role="menuitemradio" aria-checked={rounded} onClick={() => onChoose(true)}>
        <span className="tree-menu-check" aria-hidden>
          {rounded ? '✓' : ''}
        </span>
        <span>
          Round up to whole machines
          <span className="tree-menu-hint">
            {rounded
              ? 'the extra output overflows'
              : whole === built || Math.abs(whole - built) < 1e-9
                ? 'already a whole number'
                : `${whole} ${names(whole)}, +${fmt(extra)}/min overflow`}
          </span>
        </span>
      </button>
    </>
  )
}

const FED_INTO: Record<Resource, string> = { heat: 'burned for heat', fertilizer: 'spread as fertilizer' }

/**
 * What a row makes of an item that nothing uses: the part the plan feeds back into its own heat or
 * fertilizer (not overflow: it's used), and the rest, overflowing.
 */
function OverflowNote({
  item,
  amount,
  fed,
  inline,
  counted,
}: {
  item: string
  amount: number
  fed: Map<string, { share: number; into: Resource[] }>
  /** Part of a by-product line rather than a line of its own. */
  inline?: boolean
  /** Show the amount even inline (the by-product also goes elsewhere). */
  counted?: boolean
}) {
  const f = fed.get(item)
  const used = amount * (f?.share ?? 0)
  const left = amount - used
  const parts: ReactNode[] = []
  if (used > 1e-9 * amount)
    parts.push(
      <span key="fed" className="fed-text">
        {fmt(used)}/min {f!.into.map((r) => FED_INTO[r]).join(' and ')}
      </span>,
    )
  if (left > 1e-9 * amount)
    parts.push(
      <span key="left" className="warn-text" title="Made by this row's machines but used nowhere in the plan">
        {inline ? `${counted || used > 0 ? `${fmt(left)} ` : ''}overflow` : `+${fmt(left)}/min overflow`}
      </span>,
    )
  const joined = parts.flatMap((p, i) => (i ? [', ', p] : [p]))
  return inline ? <>{joined}</> : <div className="note-line">{joined}</div>
}
