import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { itemName } from '../lib/gameData'
import { fmt, fmtMachines, wholeMachines } from '../lib/format'
import {
  buildFlowChart,
  defaultLevels,
  type FlowBox,
  type FlowChart,
  type FlowEdge,
  type FlowEdgeKind,
  type FlowHeat,
  type FlowPort,
} from '../lib/flowChart'
import { buildingNameFor } from '../lib/plural'
import type { TreeNode } from '../lib/tree'
import { CheckIcon } from './CheckIcon'
import { ItemIcon, ItemLabel } from './ItemIcon'
import { MIN_ZOOM, usePanZoom, type Camera } from './usePanZoom'

interface Props {
  tree: TreeNode[]
  /** The row the chart was opened from. */
  rootId: string
  /** Rows marked built in the player's game. */
  built: ReadonlySet<string>
  onClose: () => void
  /** Shows a row in the production tree (the chart closes first). */
  onShow: (row: string) => void
}

const PAD = 28

const PORT_TEXT: Record<FlowPort, string> = {
  main: 'Gold: a machine’s product, from its gold output',
  side: 'Blue: what else it makes, as an Athanor’s failed products, from its blue outputs',
  none: 'Grey: from the bus',
}

const KIND_TEXT: Record<Exclude<FlowEdgeKind, 'feed'>, { glyph: string; name: string; hint: string }> = {
  byproduct: { glyph: '♻', name: 'Dashed', hint: 'a by-product taken by a row in another branch' },
  loop: { glyph: '↺', name: 'Long dashes', hint: 'a loop, back to a row using what it makes further up' },
  separate: { glyph: '⧉', name: 'Dotted', hint: 'from where an item built separately is gathered' },
}

/**
 * A flow chart of a branch of the production tree, in an overlay: the row it was opened from on the
 * right, what feeds it to the left, and the lines crossing branches (by-products, loops) in lanes
 * of their own, so a branch with loops still reads.
 */
export function FlowChartView({ tree, rootId, built, onClose, onShow }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  // Open before the chart is fitted to it.
  useLayoutEffect(() => {
    const d = dialogRef.current
    if (d && !d.open) d.showModal()
  }, [])

  // Boxes cut off by the level limit open the chart from there: the way back is the trail.
  const [trail, setTrail] = useState<string[]>([rootId])
  const current = trail[trail.length - 1]
  // A few levels to start with, as many as stay narrow: a whole chain from raw materials is too big
  // to read at once. The player's own pick lasts until the chart opens from another row.
  const [picked, setPicked] = useState<{ root: string; levels: number | null } | null>(null)
  const auto = useMemo(() => defaultLevels(tree, current), [tree, current])
  const levels = picked?.root === current ? picked.levels : auto
  const setLevels = (n: number | null) => setPicked({ root: current, levels: n })
  const chart = useMemo(() => buildFlowChart(tree, current, levels ?? undefined), [tree, current, levels])
  /** Levels shown, at most all of them. */
  const shown = chart ? Math.min(levels ?? chart.depth, chart.depth) : 0
  const rows = useMemo(() => {
    const m = new Map<string, TreeNode>()
    const index = (n: TreeNode) => {
      m.set(n.id, n)
      n.children.forEach(index)
    }
    tree.forEach(index)
    return m
  }, [tree])

  const [hover, setHover] = useState<{ box?: string; edge?: string; loop?: number } | null>(null)
  const lit = useMemo(() => litBy(chart, hover), [chart, hover])

  const W = (chart?.width ?? 0) + PAD * 2
  const H = (chart?.height ?? 0) + PAD * 2
  const size = useMemo(() => ({ w: W, h: H }), [W, H])
  const { zoom, pz, viewport, stage } = usePanZoom(size)
  const viewportEl = useRef<HTMLDivElement | null>(null)
  const viewportRef = useCallback(
    (el: HTMLDivElement | null) => {
      viewportEl.current = el
      viewport(el)
    },
    [viewport],
  )
  /** The whole chart in view, or as much as fits at the smallest zoom, its own row in view. */
  const fitView = useCallback((): Camera | null => {
    const v = viewportEl.current
    if (!v || !chart) return null
    const vw = v.clientWidth
    const vh = v.clientHeight
    const want = Math.min(1, (vw - 32) / W, (vh - 32) / H)
    if (want >= MIN_ZOOM) return { z: want, x: (vw - W * want) / 2, y: (vh - H * want) / 2 }
    return { z: MIN_ZOOM, x: vw - W * MIN_ZOOM - 16, y: vh / 2 - (PAD - chart.top + chart.root.y) * MIN_ZOOM }
  }, [chart, W, H])
  const fit = () => {
    const view = fitView()
    if (view) pz.moveTo(view)
  }
  // Each new chart (not every change to the plan under it) is fitted to the window: at once when
  // the overlay opens, easing there after that.
  const fitted = useRef('')
  useLayoutEffect(() => {
    const key = `${current}|${levels}`
    if (fitted.current === key) return
    const view = fitView()
    if (!view) return
    if (fitted.current) pz.moveTo(view)
    else pz.jumpTo(view)
    fitted.current = key
  }, [current, levels, fitView, pz])

  // The page behind stays put while the overlay is open.
  useEffect(() => {
    const html = document.documentElement.style
    const before = { overflow: html.overflow, gutter: html.scrollbarGutter }
    html.overflow = 'hidden'
    html.scrollbarGutter = 'stable'
    return () => {
      html.overflow = before.overflow
      html.scrollbarGutter = before.gutter
    }
  }, [])

  const keys = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === '+' || e.key === '=') pz.zoomBy(1.25)
    else if (e.key === '-') pz.zoomBy(0.8)
    else if (e.key === '0') fit()
    else return
    e.preventDefault()
  }

  const close = () => dialogRef.current?.close()
  const show = (row: string) => {
    close()
    onShow(row)
  }

  const maxRate = Math.max(1e-9, ...(chart?.edges.map((e) => e.rate) ?? []))
  const width = (rate: number) => 1.5 + 5 * Math.sqrt(Math.max(0, rate) / maxRate)
  const crossKinds = new Set(chart?.edges.filter((e) => e.kind !== 'feed').map((e) => e.kind))
  const ports = new Set(chart?.edges.map((e) => e.port))
  // Only machines get built: the boxes drawn from rows running some.
  const isBuilt = (b: FlowBox) => b.kind === 'machines' && built.has(b.id)
  const fade = (on: boolean) => (lit && !on ? ' faded' : '')

  return (
    <dialog ref={dialogRef} className="flow-dialog" onClose={onClose} onKeyDown={keys} aria-label="Flow chart">
      <div className="flow-head">
        <h3>Flow chart</h3>
        <nav className="flow-trail" aria-label="Opened from">
          {trail.map((id, i) => (
            <span key={id}>
              {i > 0 && <span className="flow-trail-sep">›</span>}
              <button type="button" disabled={i === trail.length - 1} onClick={() => setTrail(trail.slice(0, i + 1))}>
                <ItemLabel item={rows.get(id)?.item ?? ''} size={16} />
              </button>
            </span>
          ))}
        </nav>
        <div className="flow-controls">
          {chart && chart.depth > 1 && (
            <div className="flow-levels" role="group" aria-label="Levels shown">
              <span className="flow-control-label">Levels</span>
              <button
                type="button"
                aria-label="Fewer levels"
                disabled={shown <= 1}
                onClick={() => setLevels(shown - 1)}
              >
                −
              </button>
              <span className="flow-levels-value">
                {shown} of {chart.depth}
              </span>
              <button
                type="button"
                aria-label="More levels"
                disabled={shown >= chart.depth}
                onClick={() => setLevels(shown + 1 >= chart.depth ? null : shown + 1)}
              >
                +
              </button>
              <button type="button" disabled={shown >= chart.depth} onClick={() => setLevels(null)}>
                All
              </button>
            </div>
          )}
          <div className="flow-zoom" role="group" aria-label="Zoom">
            <button type="button" aria-label="Zoom out" onClick={() => pz.zoomBy(0.8)}>
              −
            </button>
            <button type="button" title="Fit the chart to the window (0)" onClick={fit}>
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" aria-label="Zoom in" onClick={() => pz.zoomBy(1.25)}>
              +
            </button>
          </div>
          <button type="button" className="flow-close" aria-label="Close" onClick={close}>
            ✕
          </button>
        </div>
      </div>

      {!chart ? (
        <p className="flow-gone">This row is no longer in the plan.</p>
      ) : (
        <div className="flow-body">
          <div ref={viewportRef} className="flow-viewport">
            <div ref={stage} className="flow-stage" style={{ width: W, height: H }}>
              <svg width={W} height={H} className="flow-lines" aria-hidden>
                <defs>
                  {(['main', 'side', 'none'] as const).map((k) => (
                    <marker
                      key={k}
                      id={`flow-arrow-${k}`}
                      className={`flow-arrow port-${k}`}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="9"
                      markerHeight="9"
                      markerUnits="userSpaceOnUse"
                      orient="auto"
                    >
                      <path d="M0,1 L10,5 L0,9 z" />
                    </marker>
                  ))}
                </defs>
                <g transform={`translate(${PAD},${PAD - chart.top})`}>
                  {chart.edges.map((e) => (
                    <path
                      key={e.id}
                      d={e.path}
                      className={`flow-edge ${e.kind} port-${e.port}${fade(!!lit?.edges.has(e.id))}`}
                      strokeWidth={width(e.rate)}
                      markerEnd={`url(#flow-arrow-${e.port})`}
                    />
                  ))}
                  {/* Wide, invisible copies to hover. */}
                  {chart.edges.map((e) => (
                    <path
                      key={`${e.id}:hit`}
                      d={e.path}
                      className="flow-edge-hit"
                      onPointerEnter={() => setHover({ edge: e.id })}
                      onPointerLeave={() => setHover(null)}
                    >
                      <title>{edgeTitle(e, chart)}</title>
                    </path>
                  ))}
                </g>
              </svg>
              {chart.edges
                .filter((e) => e.label)
                .map((e) => (
                  <span
                    key={`${e.id}:label`}
                    className={`flow-edge-label port-${e.port}${fade(!!lit?.edges.has(e.id))}`}
                    style={{ left: PAD + e.label!.x, top: PAD - chart.top + e.label!.y }}
                    title={edgeTitle(e, chart)}
                  >
                    {e.kind !== 'feed' && KIND_TEXT[e.kind].glyph} <ItemIcon item={e.item} size={14} />
                    {fmt(e.rate)}/min
                  </span>
                ))}
              {[...chart.boxes.values()].map((b) => (
                <Box
                  key={b.id}
                  box={b}
                  built={isBuilt(b)}
                  style={{ left: PAD + b.x, top: PAD - chart.top + b.y - b.h / 2, width: b.w, height: b.h }}
                  faded={!!lit && !lit.boxes.has(b.id)}
                  onHover={(on) => setHover(on ? { box: b.id } : null)}
                  onShow={b.row ? () => show(b.row!) : undefined}
                  onOpen={() => setTrail([...trail, b.id])}
                />
              ))}
            </div>
          </div>

          <aside className="flow-side">
            {chart.loops.length > 0 && (
              <section>
                <h4>Loops</h4>
                {chart.loops.map((loop, i) => (
                  <div
                    key={loop.boxes.join()}
                    className={`flow-loop${hover?.loop === i ? ' lit' : ''}`}
                    onPointerEnter={() => setHover({ loop: i })}
                    onPointerLeave={() => setHover(null)}
                  >
                    <div className="flow-loop-title">
                      <span className="flow-loop-badge">↻{i + 1}</span>
                      {loop.boxes.map((id) => (
                        <span key={id} className="flow-loop-member">
                          <ItemIcon item={chart.boxes.get(id)!.item} size={16} />
                          {itemName(chart.boxes.get(id)!.item)}
                        </span>
                      ))}
                    </div>
                    <Flows label="takes in" flows={loop.inputs} />
                    <Flows label="gives out" flows={loop.outputs} />
                  </div>
                ))}
              </section>
            )}
            <section className="flow-key">
              <h4>Key</h4>
              <p className="flow-key-note">Coloured as the game colours a machine's output arrows:</p>
              {(['main', 'side', 'none'] as const)
                .filter((k) => ports.has(k))
                .map((k) => (
                  <div key={k}>
                    <KeyLine kind="feed" port={k} /> {PORT_TEXT[k]}
                  </div>
                ))}
              <div>
                <KeyLine kind="feed" /> Solid: feeds the row it leads to
              </div>
              {(['byproduct', 'loop', 'separate'] as const)
                .filter((k) => crossKinds.has(k))
                .map((k) => (
                  <div key={k}>
                    <KeyLine kind={k} /> {KIND_TEXT[k].name}: {KIND_TEXT[k].hint}
                  </div>
                ))}
              {[...chart.boxes.values()].some((b) => b.heat) && (
                <div>
                  <span className="flow-key-heat" aria-hidden>
                    🔥
                  </span>
                  Under a box: the furnaces or Steam Heating Pads its machines sit on, and the fuel they burn. Fuel
                  made in the plan feeds into it.
                </div>
              )}
              {[...chart.boxes.values()].some(isBuilt) && (
                <div>
                  <span className="flow-built-check key" aria-hidden>
                    <CheckIcon />
                  </span>
                  Built in your game, as ticked in the tree
                </div>
              )}
              <p className="flow-tip">
                Thicker lines carry more. Hover a box or line to follow it; click a box to show its row in the tree.
              </p>
            </section>
          </aside>
        </div>
      )}
    </dialog>
  )
}

function Box({
  box: b,
  built,
  style,
  faded,
  onHover,
  onShow,
  onOpen,
}: {
  box: FlowBox
  built: boolean
  style: CSSProperties
  faded: boolean
  onHover: (on: boolean) => void
  onShow?: () => void
  onOpen: () => void
}) {
  const p = b.node?.run?.process
  const machines = b.node?.machines ?? 0
  const short = b.kind === 'machines' && (b.node?.shortfall ?? 0) > 1e-9
  const tagged = b.more > 0 || !!b.elsewhere
  return (
    <div
      className={`flow-box ${b.kind}${b.group ? ' group' : ''}${b.loop !== undefined ? ' in-loop' : ''}${b.heat ? ' heated' : ''}${built ? ' built' : ''}${tagged ? ' tagged' : ''}${faded ? ' faded' : ''}`}
      style={style}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      <button
        type="button"
        className="flow-box-main"
        onClick={onShow}
        disabled={!onShow}
        title="Show this row in the tree"
      >
        <span className="flow-box-item">
          <ItemIcon item={b.item} size={b.kind === 'machines' ? 22 : 18} />
          <span className="flow-box-name">{itemName(b.item)}</span>
          <span className="flow-box-rate">{fmt(b.rate)}/min</span>
        </span>
        {b.kind === 'machines' && (
          <span className="flow-box-meta">
            {p?.machine
              ? `${fmtMachines(machines)} ${buildingNameFor(p.machine.key, wholeMachines(machines))}`
              : p?.label}
            {short && <span className="warn-text"> · short {fmt(b.node!.shortfall)}/min</span>}
          </span>
        )}
        {b.kind === 'machines' && p?.machine && (
          <span
            className="flow-box-recipe"
            title={b.node?.recovery ? 'Recovers what other machines output and nothing else uses' : undefined}
          >
            {b.node?.recovery && '♻ '}
            {p.label}
          </span>
        )}
        {b.kind === 'bus' && <span className="flow-box-meta">from the bus</span>}
        {b.kind === 'outside' && <span className="flow-box-meta">{b.note}</span>}
      </button>
      {b.heat && <HeatSlab heat={b.heat} />}
      {built && (
        <span className="flow-built-check" role="img" aria-label="Built" title="Built in your game">
          <CheckIcon />
        </span>
      )}
      {b.loop !== undefined && (
        <span className="flow-loop-badge on-box" title={`Part of loop ${b.loop + 1}`}>
          ↻{b.loop + 1}
        </span>
      )}
      {b.elsewhere && (
        <span
          className="flow-box-elsewhere"
          title={`Built separately: it also goes to ${b.elsewhere.uses} ${b.elsewhere.uses === 1 ? 'use' : 'uses'} elsewhere in the plan`}
        >
          ⧉ +{fmt(b.elsewhere.rate)}/min to {b.elsewhere.uses} more
        </span>
      )}
      {b.more > 0 && (
        <button type="button" className="flow-box-more" onClick={onOpen} title="Open the chart from this row">
          ‹ {b.more} more {b.more === 1 ? 'row' : 'rows'}
        </button>
      )}
    </div>
  )
}

/** The furnaces or Steam Heating Pads a box's machines sit on, with the fuel they burn. */
function HeatSlab({ heat }: { heat: FlowHeat }) {
  const on = heat.pads ? 'Steam Heating Pads' : 'Furnaces'
  return (
    <div
      className="flow-box-heat"
      title={
        heat.item
          ? `${on} under these machines: ${fmt(heat.rate)} ${itemName(heat.item)}/min for ${fmt(heat.heat)} P/s`
          : `${on} under these machines: ${fmt(heat.heat)} P/s`
      }
    >
      <span aria-hidden>🔥</span>
      {heat.item ? (
        <>
          <ItemIcon item={heat.item} size={14} />
          <span className="flow-box-heat-name">{itemName(heat.item)}</span>
          <span className="flow-box-heat-rate">{fmt(heat.rate)}/min</span>
        </>
      ) : (
        <>
          <span className="flow-box-heat-name">Heat</span>
          <span className="flow-box-heat-rate">{fmt(heat.heat)} P/s</span>
        </>
      )}
    </div>
  )
}

/** A sample of a line in the key, drawn as the chart draws it. */
function KeyLine({ kind, port = 'none' }: { kind: FlowEdgeKind; port?: FlowPort }) {
  return (
    <svg className="flow-key-line" width="28" height="8" aria-hidden>
      <path d="M1,4 H27" className={`flow-edge ${kind} port-${port}`} strokeWidth={port === 'none' ? 2 : 3} />
    </svg>
  )
}

function Flows({ label, flows }: { label: string; flows: { item: string; rate: number }[] }) {
  if (!flows.length) return null
  return (
    <div className="flow-loop-flows">
      <span className="flow-loop-label">{label}</span>
      {flows.map((f) => (
        <span key={f.item} className="flow-loop-flow">
          <ItemIcon item={f.item} size={14} />
          {fmt(f.rate)} {itemName(f.item)}
        </span>
      ))}
    </div>
  )
}

/** What a line is, for its tooltip. */
const KIND_TITLE: Record<FlowEdgeKind, string> = {
  feed: '',
  byproduct: 'By-product',
  loop: 'Loop',
  separate: 'Built separately',
}
/** Which output it leaves its machine by. */
const PORT_TITLE: Record<FlowPort, string> = { main: ' (product: gold output)', side: ' (blue output)', none: '' }

function edgeTitle(e: FlowEdge, chart: FlowChart): string {
  const from = chart.boxes.get(e.from)
  const to = chart.boxes.get(e.to)
  const what = `${fmt(e.rate)} ${itemName(e.item)}/min`
  const source = from?.kind === 'machines' ? ` from ${itemName(from.item)}` : ''
  const into = to ? ` into ${itemName(to.item)}` : ''
  const kind = KIND_TITLE[e.kind]
  return `${kind ? `${kind}: ` : ''}${what}${source}${PORT_TITLE[e.port ?? 'none']}${into}`
}

/** What hovering a box, line or loop highlights: the boxes and lines it touches. */
function litBy(chart: FlowChart | null, hover: { box?: string; edge?: string; loop?: number } | null) {
  if (!chart || !hover) return null
  const boxes = new Set<string>()
  const edges = new Set<string>()
  if (hover.box) {
    boxes.add(hover.box)
    for (const e of chart.edges)
      if (e.from === hover.box || e.to === hover.box) {
        edges.add(e.id)
        boxes.add(e.from)
        boxes.add(e.to)
      }
  } else if (hover.edge) {
    const e = chart.edges.find((x) => x.id === hover.edge)
    if (e) {
      edges.add(e.id)
      boxes.add(e.from)
      boxes.add(e.to)
    }
  } else if (hover.loop !== undefined) {
    const members = new Set(chart.loops[hover.loop]?.boxes)
    members.forEach((id) => boxes.add(id))
    for (const e of chart.edges) if (members.has(e.from) && members.has(e.to)) edges.add(e.id)
  }
  return { boxes, edges }
}
