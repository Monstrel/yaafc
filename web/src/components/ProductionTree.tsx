import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { CATALYSTS, itemsByKey } from '../lib/gameData'
import { fmt } from '../lib/format'
import type { LogisticsCheck } from '../lib/logistics'
import type { ProcessCatalog } from '../lib/processes'
import { branchIds, type TreeNode } from '../lib/tree'
import type { Plan } from '../lib/types'
import { ItemIcon, ItemLabel } from './ItemIcon'
import { Money } from './Money'
import { ProducerSelect } from './ProducerSelect'

interface Props {
  tree: TreeNode[]
  plan: Plan
  catalog: ProcessCatalog
  onProducer: (item: string, producer: string) => void
  onMachine: (processId: string, machine: string) => void
  onCatalysts: (processId: string, catalysts: string[]) => void
  /** Plan-wide unused amount per item (per minute), to flag overflowing by-products. */
  unused: Map<string, number>
  logistics: Map<string, LogisticsCheck>
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
export function ProductionTree({ tree, plan, catalog, onProducer, onMachine, onCatalysts, unused, logistics }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Every node with the ids of the branches above it, folded or not.
  const all = useMemo(() => {
    const out: { node: TreeNode; ancestors: string[] }[] = []
    const visit = (nodes: TreeNode[], ancestors: string[]) => {
      for (const node of nodes) {
        out.push({ node, ancestors })
        visit(node.children, [...ancestors, node.id])
      }
    }
    visit(tree, [])
    return out
  }, [tree])

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
    return () => row.removeEventListener('animationend', done)
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

  const rows: { node: TreeNode; depth: number }[] = []
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth })
      if (!collapsed.has(node.id)) walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)

  return (
    <>
      <div className="tree-toolbar">
        <button className="compact-button" onClick={() => setCollapsed(new Set())}>
          Expand all
        </button>
        <button className="compact-button" onClick={() => setCollapsed(new Set(tree.flatMap((n) => branchIds(n.children))))}>
          Collapse to targets
        </button>
      </div>
      <div className="table-scroll">
        <table className="production tree">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Rate /min</th>
              <th>Recipe</th>
              <th className="num">Machines</th>
              <th className="num">Heat</th>
            </tr>
          </thead>
          <tbody ref={tbody}>
            {rows.map(({ node, depth }) => (
              <TreeRow
                key={node.id}
                node={node}
                depth={depth}
                open={!collapsed.has(node.id)}
                onToggle={() => toggle(node.id)}
                plan={plan}
                catalog={catalog}
                onProducer={onProducer}
                onMachine={onMachine}
                onCatalysts={onCatalysts}
                unused={unused}
                logistics={logistics}
                link={link}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function TreeRow({
  node,
  depth,
  open,
  onToggle,
  plan,
  catalog,
  onProducer,
  onMachine,
  onCatalysts,
  unused,
  logistics,
  link,
}: {
  node: TreeNode
  depth: number
  open: boolean
  onToggle: () => void
  plan: Plan
  catalog: ProcessCatalog
  onProducer: (item: string, producer: string) => void
  onMachine: (processId: string, machine: string) => void
  onCatalysts: (processId: string, catalysts: string[]) => void
  unused: Map<string, number>
  logistics: Map<string, LogisticsCheck>
  link: LinkFn
}) {
  const p = node.run?.process
  const belts = p ? logistics.get(p.id) : undefined
  const limited = !!belts && belts.utilization < 1 && node.machines > 0
  const canChoose = node.kind !== 'bus' && (catalog.byProduct.get(node.item)?.length ?? 0) > 0
  const price = itemsByKey.get(node.item)?.buyPrice
  const sources = node.byproductSources.map((s, i) => (
    <span key={s.id}>
      {i > 0 && ', '}
      {link(
        node,
        `from:${s.id}`,
        (n) => n.kind === 'produce' && n.run?.process.id === s.id && n.machines > 0,
        s.label,
        `Show the ${s.label} machines`,
      )}
    </span>
  ))

  return (
    <tr data-node-id={node.id} className={`kind-${node.kind} depth-${Math.min(depth, 1)} ${node.rate === 0 ? 'idle' : ''}`}>
      <td className="tree-item">
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
        ) : node.kind === 'bus' ? (
          <span className="leaf-note">from the bus</span>
        ) : (
          <>
            {canChoose && <ProducerSelect item={node.item} plan={plan} catalog={catalog} onChange={onProducer} compact />}
            {node.kind === 'purchase' &&
              (price != null ? (
                <span className="leaf-note">
                  {canChoose ? '' : 'Bought · '}
                  <Money copper={node.purchased * price} suffix="/min" />
                </span>
              ) : (
                <span className="tag warn">not sold at portals</span>
              ))}
            {p && p.machineOptions.length > 1 && (
              <select className="compact" value={p.machine?.key} onChange={(e) => onMachine(p.id, e.target.value)}>
                {p.machineOptions.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.name}
                    {m.speed !== 1 ? ` (×${m.speed} speed)` : ''}
                    {m.outputMultiplier !== 1 ? ` (${m.outputMultiplier}× output)` : ''}
                  </option>
                ))}
              </select>
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
                        onCatalysts(p.id, on ? p.catalysts.filter((k) => k !== c.key) : [...p.catalysts, c.key])
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
            {node.byproducts.length > 0 && (
              <div className="note-line">
                also makes{' '}
                {node.byproducts.map((b) => (
                  <span key={b.item} className="byproduct">
                    {link(
                      node,
                      `uses:${b.item}`,
                      (n) => n.item === b.item && n.rate > 0 && (n.kind === 'byproduct' || n.fromByproduct > 0),
                      <ItemLabel item={b.item} count={fmt(b.count)} size={16} />,
                      `Show where ${itemsByKey.get(b.item)?.name ?? b.item} is used`,
                    )}
                    {(unused.get(b.item) ?? 0) > 0 && (
                      <span className="warn-text"> ({fmt(unused.get(b.item)!)}/min unused overall)</span>
                    )}
                  </span>
                ))}
              </div>
            )}
            {p?.notes.map((n) => (
              <div className="note-line" key={n}>
                {n}
              </div>
            ))}
            {node.shortfall > 0 && <div className="note-line warn-text">short by {fmt(node.shortfall)}/min</div>}
            {belts?.outputCappedAt != null && node.kind === 'produce' && (
              <div className="note-line">output capped by its belt at {fmt(belts.outputCappedAt)}/min per machine</div>
            )}
            {belts && (belts.multiBelt || limited) && node.kind === 'produce' && (
              <div className="note-line">
                belts per machine:{' '}
                {belts.inputs.map((f) => (
                  <span key={f.item} className={f.belts > 1 ? 'belt-chip multi' : 'belt-chip'}>
                    {itemsByKey.get(f.item)?.name ?? f.item} ×{f.belts}
                  </span>
                ))}
                <span className={limited ? 'belt-limited' : ''}>
                  ({belts.inputBeltsNeeded} of {belts.beltIn} inputs)
                </span>
              </div>
            )}
          </>
        )}
      </td>
      <td className="num">
        {node.kind === 'produce' && p?.machine && (
          <>
            <span className="machines-value">{fmt(node.machines)}</span>
            {limited && (
              <div className="belt-limited" title="Machines needed once conveyor limits slow them down">
                → {belts.utilization > 0 ? fmt(node.machines / belts.utilization) : '∞'} (belts)
              </div>
            )}
            <div className="machine-meta">{p.machine.name}</div>
          </>
        )}
      </td>
      <td className="num heat-cell">
        {node.heat > 0 && `${fmt(node.heat)} P/s`}
        {node.nutrients > 0 && <div className="machine-meta">{fmt(node.nutrients)} nutrients/s</div>}
      </td>
    </tr>
  )
}
