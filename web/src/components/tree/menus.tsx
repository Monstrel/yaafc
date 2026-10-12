import { useId, useRef } from 'react'
import { itemsByKey } from '../../lib/gameData'
import { fmt } from '../../lib/format'
import { buildingNameFor, noun } from '../../lib/plural'
import { placePopover } from '../../lib/popover'
import type { LogisticsCheck } from '../../lib/logistics'
import { onOverflow, type TreeNode } from '../../lib/tree'
import { wholePerCopy } from '../../lib/units'

/** Unmarking a row with built rows below it: just the row, or its whole branch. */
export function UnmarkMenu({ node, below, onChoose }: { node: TreeNode; below: number; onChoose: (branch: boolean) => void }) {
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

export interface ToolbarMenuItem {
  label: string
  hint: string
  /** Absent: the item is shown, but does nothing now (the hint says why). */
  onClick?: () => void
  /** Set: the item turns something on or off, and this says whether it's on. */
  checked?: boolean
}

/** A toolbar button opening a menu of related actions below it. */
export function ToolbarMenu({ label, items, className }: { label: string; items: ToolbarMenuItem[]; className?: string }) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  // A menu with an on/off item lines every label up past its checkmark.
  const hasChecks = items.some((item) => item.checked !== undefined)
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
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              disabled={!item.onClick}
              onClick={() => {
                ref.current?.hidePopover()
                item.onClick?.()
              }}
            >
              {hasChecks && (
                <span className="tree-menu-check" aria-hidden>
                  {item.checked ? '✓' : ''}
                </span>
              )}
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

export type AnchorDecision = 'every' | 'one' | 'lift' | 'cancel'

/** Asks whether to gather an item with every row of an anchor built in several places, or this one. */
export function AnchorChoice({
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

/**
 * Choices for a row's machine count: just what the plan needs, or the next whole number of
 * machines (as built, input belt limits included), the extra output overflowing.
 */
export function MachinesMenu({
  node,
  rounded,
  byMachines,
  belts,
  onChoose,
  copiesAbove,
  unit,
  choices,
  onUnits,
}: {
  node: TreeNode
  rounded: boolean
  /** The row's target is set in machines, which it runs as they are. */
  byMachines: boolean
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
  // A target set in machines runs just those, whatever was picked here before.
  if (byMachines) rounded = false
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
      <button type="button" role="menuitemradio" aria-checked={rounded} disabled={byMachines} onClick={() => onChoose(true)}>
        <span className="tree-menu-check" aria-hidden>
          {rounded ? '✓' : ''}
        </span>
        <span>
          Round up to whole machines
          <span className="tree-menu-hint">
            {byMachines
              ? 'the target sets how many it runs'
              : fed
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
