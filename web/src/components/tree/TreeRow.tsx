import { type CSSProperties, useState } from 'react'
import { CATALYSTS, coinValue, heightMultiplier, isCauldronTarget, itemName, itemsByKey } from '../../lib/gameData'
import { fmt, fmtMachines, wholeMachines } from '../../lib/format'
import { buildingNameFor, noun } from '../../lib/plural'
import type { FedOverflow } from '../../lib/money'
import type { LogisticsCheck } from '../../lib/logistics'
import { COIN_STACK, itemsPerSlot, onBelt } from '../../lib/machineRate'
import { MAX_BANK_STACK, clampBankStack, type ProcessCatalog } from '../../lib/processes'
import { type TreeNode } from '../../lib/tree'
import { type LoopSourceChoice, type ProducerPick } from '../../lib/choices'
import { BUS, isTargetRow, parentId, rowItem } from '../../lib/unfold'
import type { Modifiers } from '../../lib/upgrades'
import { ItemIcon, ItemLabel, SeedNote } from '../ItemIcon'
import { AltarDetail } from '../Exp'
import { Money } from '../Money'
import { OverflowTargetForm } from '../OverflowTargetForm'
import { BusDraw, FoldedPick } from '../FuelPick'
import { CheckIcon } from '../CheckIcon'
import { ProducerSelect } from '../ProducerSelect'
import { choosable, reuseInfo } from '../rowPicks'
import { NumberInput } from '../NumberInput'
import {
  recovers,
  mergeHint,
  PLAN_ROOT,
  autoBuiltHint,
  FOLDED_VERB,
  destinationName,
  edgeX,
  bandStyle,
  cardStyle,
  endsCard,
  shareOf,
  type BuiltState,
  type Edge,
} from '../../lib/treeView'
import { BookmarkIcon, FlowIcon, BoxArrowIcon } from './icons'
import { OverflowNote } from './OverflowNote'

import type { LinkFn, TargetSlot } from './types'

export function TreeRow({
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
  onLoopSource,
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
  onLoopSource: (row: TreeNode, source: LoopSourceChoice) => void
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
  const canChoose = !node.recovery && node.loopTarget === undefined && choosable(node, catalog, reuse)
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
        {node.kind === 'gather' ? (
          <span className="leaf-note" title="What the row above takes of it in all, from the rows below">
            ⇉ from {node.children.length} sources
          </span>
        ) : node.loopTarget !== undefined ? (
          <>
            <select
              value={node.kind === 'loop' ? 'fed' : node.producer === BUS ? 'input' : ''}
              onChange={(e) => onLoopSource(node, e.target.value as LoopSourceChoice)}
              aria-label={`Where this ${name} comes from`}
              title={`The ${name} target's own chain uses it: it takes what the target makes when the target is fed back, else the plan input`}
            >
              {node.kind !== 'loop' && node.producer !== BUS && (
                <option value="" disabled>
                  Not chosen: short
                </option>
              )}
              <option value="fed">↺ From the {name} target, fed back</option>
              <option value="input">From the plan input</option>
            </select>
            {node.shortfall > 0 && (
              <div className="note-line warn-text">
                short by {fmt(node.shortfall)}/min
                {node.kind === 'loop' ? ': the target makes less than its own chain uses' : ': pick where it comes from'}
              </div>
            )}
          </>
        ) : node.reusedBy ? (
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
            {/* A recovery row runs its recipe as it is: it has none of these settings. */}
            {p?.acceptsCatalysts && node.kind === 'produce' && !node.recovery && (
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
            {p?.acceptsHeight && node.kind === 'produce' && !node.recovery && (
              <label
                className="build-height"
                title={`The Height its inspect panel shows. The higher up it's built, the greater its output.`}
              >
                Height
                <NumberInput
                  min={0}
                  step={1}
                  value={p.height}
                  onValue={(text) => onHeight(node.id, Math.max(0, Math.round(Number(text) || 0)), node.defaultHeight)}
                  aria-label={`Height the ${p.machine?.name ?? 'machines'} are built at`}
                />
                <span className="hint-inline">
                  ×{heightMultiplier(p.height).toLocaleString(undefined, { maximumFractionDigits: 3 })} output
                </span>
              </label>
            )}
            {p?.stack !== undefined && node.kind === 'produce' && !node.recovery && (
              <label
                className="bank-stack"
                title={`The Conversion Amount its panel shows: coins in each stack it puts on the belt (1–${MAX_BANK_STACK}). Bigger stacks move more coins per belt.`}
              >
                Conversion amount
                <NumberInput
                  min={1}
                  max={MAX_BANK_STACK}
                  step={1}
                  value={p.stack}
                  onValue={(text) => onStack(node.id, clampBankStack(Number(text)), node.defaultStack)}
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

/** The card edges passing through a row, one per branch it sits in. */
export function Edges({ edges }: { edges: Edge[] }) {
  return edges.map((e) => (
    <span
      key={e.level}
      className={`edge ${e.piece}${e.accent ? ' accent' : ''}`}
      style={{ left: edgeX(e.level) }}
      aria-hidden
    />
  ))
}
