import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { fmt, fmtSeconds } from '../lib/format'
import { HEAT, coinValue, iconUrl, itemName, itemsByKey, machinesByKey, tierIcon, tierName, type Item, type Stack } from '../lib/gameData'
import { itemNameFor } from '../lib/plural'
import { placePopover } from '../lib/popover'
import {
  DEFAULT_PARADOX_INPUT,
  PARADOX_CRUCIBLE,
  processLabel,
  processTitle,
  type Process,
  type ProcessCatalog,
} from '../lib/processes'
import { ItemIcon, SeedNote } from './ItemIcon'
import { ItemPicker } from './ItemPicker'
import { Money } from './Money'

const CRUCIBLE = 'crucible'
/** Taking the item from the bus. */
const BUS = 'bus'
/** Menu value of reusing other rows' by-products. */
const REUSE = 'reuse'
/** Menus with more options than this get a search box (fuels, many saved mixes). */
const SEARCH_FROM = 10
const NONE = new Set<string>()

/** The item a single-input process consumes (heat aside). */
const inputOf = (p: Process) => p.inputs.find((s) => s.item !== HEAT)?.item ?? ''
const materials = (p: Process) => p.inputs.filter((s) => s.item !== HEAT)
const stackKey = (s: Stack) => `${s.item}×${s.count}`
const describe = (stacks: Stack[]) => stacks.map((s) => `${fmt(s.count)} ${itemNameFor(s.item, s.count)}`).join(' + ')

/**
 * One menu entry: a process on one of its machines (buying at a Purchasing Portal among them), the
 * Paradox Crucible (input picked alongside), or taking the item from the bus.
 */
interface Choice {
  value: string
  /** The process behind the entry, as run on `machine`; for the crucible, the current (or default) input's. */
  process?: Process
  /** Machine to set with the process, when it can run on several. */
  machine?: string
  /** Taking coins off the bus: copper per coin. */
  coin?: number
  /** Research tier the entry needs, when the plan hasn't reached it. */
  needs?: number
}

/** Where a pick made on a tree row applies. */
export interface BranchScope {
  /** Rows of the item in the plan that use a producer of their own (not loops or separate builds). */
  rows: number
  /** The row has its own pick. */
  own: boolean
  /** The row follows one of the player's saved defaults. */
  mine?: boolean
  onReset: () => void
}

/** A tree row other rows' by-products of its item cover part of: it takes them before making the rest. */
export interface ReuseInfo {
  /** By-products cover the whole row: nothing of its own runs. */
  covered: boolean
  /** The rows the by-products come from. */
  sources: string
}

/** Menu value of a process on a given machine. */
const onMachineValue = (id: string, machine: string) => `${id}@${machine}`

/**
 * Chooses which process makes an item (game recipe, nursery, saved ★ cauldron recipe, buying it at
 * a Purchasing Portal), or whether it's taken from the bus,
 * and the machine that runs it: a recipe several machines can run is offered once per machine.
 * A button showing the machine opens a menu previewing each option's ingredients and products;
 * ingredients the current choice also uses are dimmed so the differences stand out.
 * Everything the Paradox Crucible makes — refining any item, or the fixed Oblivion ↔ Vitality
 * recipes — collapses into a single entry plus an input picker.
 */
export function ProducerSelect({
  item,
  current: { producer: current, process: currentProcess },
  catalog,
  onChange,
  compact,
  link,
  noImport,
  exclude,
  oneLine,
  branch,
  reuse,
  onFind,
}: {
  item: string
  /** The producer in use (a process id, 'import' or 'bus') and its process on the machine it runs on. */
  current: { producer: string; process?: Process }
  catalog: ProcessCatalog
  onChange: (producer: string, machine?: string, everywhere?: boolean) => void
  compact?: boolean
  /** Shown as a link (icon and name, underlined) rather than a button, inside a line of text. */
  link?: boolean
  /** Offers only ways of making it: not buying it or taking it from the bus (heat, nutrients). */
  noImport?: boolean
  /** Processes not to offer here (Steam for a boiler's own heat). */
  exclude?: string[]
  /** Short lists of items with one yield each (fuels, fertilizers): an option per line, yield on the right, no search. */
  oneLine?: boolean
  /** On a tree row: picks cover the row's branch, or every row of the item when asked. */
  branch?: BranchScope
  /** On a row other rows' by-products cover part of: where they come from. */
  reuse?: ReuseInfo
  /** For an item cauldrons make: looks for a new cauldron recipe on the Cauldron page. */
  onFind?: () => void
}) {
  const all = catalog.byProduct.get(item) ?? []
  const isCrucible = (p: Process) => p.machine?.key === PARADOX_CRUCIBLE && p.product === item
  const options = all.filter((p) => !isCrucible(p) && !exclude?.includes(p.id))
  const crucible = new Map(all.filter(isCrucible).map((p) => [inputOf(p), p]))
  const onCrucible = !!currentProcess && isCrucible(currentProcess)
  const crucibleDefault = crucible.get(DEFAULT_PARADOX_INPUT) ?? [...crucible.values()][0]
  const inputs = [...crucible.keys()].map((k) => itemsByKey.get(k)).filter((i): i is Item => !!i)

  /**
   * The research tier an entry's own recipe and machine (or buying) need, if the plan hasn't reached
   * it yet; locked ingredients show on their own rows.
   */
  const needs = (c: Choice) => {
    const tier = c.process ? c.process.tier : 1
    return tier > catalog.tier ? tier : undefined
  }
  const entries: Choice[] = [
    ...options.flatMap((p) =>
      p.machineOptions.length > 1
        ? p.machineOptions.map((m) => ({
            value: onMachineValue(p.id, m.key),
            process: catalog.variant(p, { machine: m.key }),
            machine: m.key,
          }))
        : [{ value: p.id, process: p }],
    ),
    ...(crucible.size > 0 ? [{ value: CRUCIBLE, process: onCrucible ? currentProcess : crucibleDefault }] : []),
    ...(noImport ? [] : [{ value: BUS, coin: coinValue(item) ?? undefined }]),
  ]
  // What the plan's research tier can't run yet goes last.
  const choices = entries.map((c) => ({ ...c, needs: needs(c) })).sort((a, b) => Number(!!a.needs) - Number(!!b.needs))
  const producerValue = onCrucible
    ? CRUCIBLE
    : currentProcess && currentProcess.machineOptions.length > 1 && currentProcess.machine
      ? onMachineValue(current, currentProcess.machine.key)
      : current
  const producing = choices.find((c) => c.value === producerValue) ?? {
    value: producerValue,
    process: currentProcess,
    needs: currentProcess && needs({ value: producerValue, process: currentProcess }),
  }
  // The button shows reusing by-products when they cover the whole row, else the producer making
  // the rest (or all of it).
  const value = producerValue
  const selected: Choice = reuse?.covered ? { value: REUSE } : producing
  // Ingredients the current producer also uses in the same amount: dimmed in the other options, so
  // what switching would change stands out.
  const shared = new Set(producing.process && producerValue !== CRUCIBLE ? materials(producing.process).map(stackKey) : [])
  // Several options on one machine: the button also shows the chosen one's ingredients.
  const ambiguous = choices.filter((c) => choiceTitle(c) === choiceTitle(selected)).length > 1

  const popoverId = useId()
  const pop = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [everywhere, setEverywhere] = useState(false)
  const showScope = !!branch && (branch.rows > 1 || branch.own)

  // A fixed popover doesn't follow the page: close it when anything outside it scrolls.
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (!(e.target instanceof Node && pop.current?.contains(e.target))) pop.current?.hidePopover()
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  /**
   * Places the popover by the button, at least as wide. The button opens it (as its popover target)
   * after the click, so this waits for it to show, then places it before it's drawn.
   */
  const place = (button: HTMLElement) =>
    requestAnimationFrame(() => {
      const el = pop.current
      if (!el?.matches(':popover-open')) return
      const r = button.getBoundingClientRect()
      el.style.width = `${Math.max(r.width, oneLine ? 240 : 360)}px`
      placePopover(el, r)
    })

  const choose = (c: Choice) => {
    pop.current?.hidePopover()
    if (c.value === value) return
    if (c.value === CRUCIBLE) onChange(crucibleDefault!.id, undefined, everywhere)
    else onChange(c.process?.id ?? c.value, c.machine, everywhere)
  }

  // Arrow keys move between options (and back up to the search box).
  const onKeyDown = (e: KeyboardEvent) => {
    const list = [...(pop.current?.querySelectorAll<HTMLElement>('[role=option], .recipe-find') ?? [])]
    const at = list.indexOf(document.activeElement as HTMLElement)
    const inSearch = e.target instanceof HTMLInputElement
    const next =
      e.key === 'ArrowDown'
        ? at + 1
        : e.key === 'ArrowUp'
          ? at - 1
          : e.key === 'Home' && !inSearch
            ? 0
            : e.key === 'End' && !inSearch
              ? list.length - 1
              : null
    if (next === null) return
    e.preventDefault()
    if (next < 0) pop.current?.querySelector<HTMLElement>('.recipe-search')?.focus()
    else list[Math.min(next, list.length - 1)]?.focus()
  }

  const q = query.trim().toLowerCase()
  const shown = q
    ? choices.filter((c) =>
        [choiceTitle(c), c.process ? processLabel(c.process, item) : '', ...(c.process?.inputs ?? []).map((s) => itemName(s.item))]
          .join(' ')
          .toLowerCase()
          .includes(q),
      )
    : choices

  return (
    <span className="producer-select">
      <button
        type="button"
        className={link ? 'recipe-link' : `recipe-button ${compact ? 'compact' : ''}`}
        popoverTarget={popoverId}
        aria-haspopup="listbox"
        title={selected.process ? processLabel(selected.process, item) : choiceTitle(selected)}
        onClick={(e) => {
          if (!open) place(e.currentTarget)
          setOpen(true)
        }}
      >
        <ChoiceIcon choice={selected} size={link ? 18 : compact ? 20 : 24} />
        <span className="recipe-title">
          {choiceTitle(selected)}
          {selected.process && <SeedNote seed={selected.process.seed} plant={selected.process.product} size={link ? 14 : 16} />}
        </span>
        <ChoiceTags choice={selected} item={item} />
        {reuse && !reuse.covered && (
          <span className="tag reuse-tag" title={`Takes by-products from ${reuse.sources} first; this makes the rest`}>
            ♻
          </span>
        )}
        {branch?.mine && (
          <span className="tag mine-tag" title="Your default way of making this, saved from a plan">
            mine
          </span>
        )}
        {ambiguous && selected.process && selected.value !== CRUCIBLE && (
          <span className="recipe-mini" aria-hidden>
            {materials(selected.process).map((s) => (
              <ItemIcon key={s.item} item={s.item} size={16} />
            ))}
          </span>
        )}
        <span className="chevron" aria-hidden>
          ▾
        </span>
      </button>
      <div
        ref={pop}
        id={popoverId}
        popover="auto"
        className="recipe-menu"
        onKeyDown={onKeyDown}
        onToggle={(e) => {
          const isOpen = e.newState === 'open'
          setOpen(isOpen)
          if (isOpen) pop.current?.querySelector<HTMLElement>('.recipe-search, [aria-selected=true]')?.focus()
          else {
            setQuery('')
            setEverywhere(false)
          }
        }}
      >
        {open && (
          <>
            {!oneLine && choices.length > SEARCH_FROM && (
              <input
                className="recipe-search"
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && shown[0] && choose(shown[0])}
              />
            )}
            {showScope && (
              <div className="recipe-scope">
                {branch!.rows > 1 && (
                  <div className="scope-toggle" role="radiogroup" aria-label="Apply the pick to">
                    <button type="button" role="radio" aria-checked={!everywhere} onClick={() => setEverywhere(false)}>
                      This branch
                    </button>
                    <button type="button" role="radio" aria-checked={everywhere} onClick={() => setEverywhere(true)}>
                      All {branch!.rows} rows
                    </button>
                  </div>
                )}
                {branch!.own && (
                  <button
                    type="button"
                    className="tree-link"
                    title="Follow the pick above this row (or the plan's) again"
                    onClick={() => {
                      pop.current?.hidePopover()
                      branch!.onReset()
                    }}
                  >
                    ↺ Clear this branch&apos;s pick
                  </button>
                )}
              </div>
            )}
            {reuse && !q && (
              <div className="recipe-reuse-note">
                ♻ By-products of {reuse.sources} come first; {reuse.covered ? 'this makes the rest if they fall short' : 'this makes the rest'}
              </div>
            )}
            <div role="listbox" aria-label={`Producer for ${itemName(item)}`}>
              {shown.map((c) =>
                oneLine ? (
                  <button
                    type="button"
                    key={c.value}
                    role="option"
                    aria-selected={c.value === value}
                    aria-label={choiceDescription(c, item)}
                    className="recipe-option one-line"
                    onClick={() => choose(c)}
                  >
                    <ChoiceIcon choice={c} size={24} />
                    <span className="recipe-title">{choiceTitle(c)}</span>
                    <ChoiceTags choice={c} item={item} />
                    {c.process?.outputs[0] && (
                      <span className="recipe-yield" aria-hidden>
                        <Amount stack={c.process.outputs[0]} className="" />
                      </span>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    key={c.value}
                    role="option"
                    aria-selected={c.value === value}
                    aria-label={choiceDescription(c, item)}
                    className="recipe-option"
                    onClick={() => choose(c)}
                  >
                    <ChoiceIcon choice={c} size={32} />
                    <span className="recipe-body">
                      <span className="recipe-head">
                        <span className="recipe-title">
                          {choiceTitle(c)}
                          {c.process && <SeedNote seed={c.process.seed} plant={c.process.product} size={16} />}
                        </span>
                        <ChoiceTags choice={c} item={item} machine />
                        <ChoiceMeta choice={c} />
                      </span>
                      <ChoicePreview choice={c} item={item} shared={c.value === value ? NONE : shared} />
                    </span>
                  </button>
                ),
              )}
              {shown.length === 0 && <div className="picker-empty">No matches</div>}
            </div>
            {onFind && (
              <button
                type="button"
                className="recipe-option recipe-find"
                onClick={() => {
                  pop.current?.hidePopover()
                  onFind()
                }}
              >
                <FindIcon size={32} />
                <span className="recipe-body">
                  <span className="recipe-head">
                    <span className="recipe-title">Find a new Cauldron recipe</span>
                  </span>
                  <span className="recipe-preview muted">
                    Search mixes that make {itemName(item)} on the Cauldron page; Use there puts one in this plan
                  </span>
                </span>
              </button>
            )}
          </>
        )}
      </div>
      {onCrucible && (
        <ItemPicker
          value={inputOf(currentProcess)}
          options={inputs}
          onChange={(key) => key && crucible.has(key) && onChange(crucible.get(key)!.id)}
          placeholder="Crucible input…"
          detail={(i) => fmtSeconds(crucible.get(i.key)?.seconds ?? 0)}
          compact={compact}
        />
      )}
    </span>
  )
}

function choiceTitle(c: Choice): string {
  if (c.value === REUSE) return 'Reuse by-products'
  if (c.value === BUS) return 'Plan input'
  if (c.value === CRUCIBLE) return 'Paradox Crucible'
  return c.process ? processTitle(c.process) : c.value
}

function choiceDescription(c: Choice, item: string): string {
  const p = c.process
  if (c.value === BUS) return c.coin ? 'Plan input: coins brought in' : 'Plan input: made outside this plan, for every row of it'
  if (!p) return choiceTitle(c)
  if (c.value === CRUCIBLE) return `${choiceTitle(c)}: refine any item`
  return `${processLabel(p, item)}: ${describe(materials(p))} → ${describe(p.outputs)}`
}

/**
 * The building that runs the option (the fuel itself for burning), as the game draws it.
 * The bus has no building in game, so it gets an abstract arrow into a crate.
 */
function ChoiceIcon({ choice, size }: { choice: Choice; size: number }) {
  const p = choice.process
  if (choice.value === REUSE)
    return (
      <span className="item-icon glyph" style={{ width: size, height: size, fontSize: size * 0.7 }} aria-hidden>
        ♻
      </span>
    )
  if (p && (p.kind === 'fuel' || p.kind === 'fertilizer' || p.kind === 'spend')) return <ItemIcon item={inputOf(p)} size={size} />
  if (choice.value === BUS) return <ImportIcon size={size} />
  const icon = p?.machine?.icon
  const src = iconUrl(icon)
  const img = src ? (
    <img className="item-icon" src={src} width={size} height={size} alt="" />
  ) : (
    <span className="item-icon missing" style={{ width: size, height: size }} aria-hidden />
  )
  if (p?.kind !== 'cauldron') return img
  return (
    <span className="recipe-icon-saved" title="Saved cauldron recipe">
      {img}
      <span className="star" aria-hidden>
        ★
      </span>
    </span>
  )
}

/** The Cauldron with a magnifying glass over it: looking for a new mix. */
function FindIcon({ size }: { size: number }) {
  const src = iconUrl(machinesByKey.get('Cauldron')?.icon)
  return (
    <span className="recipe-icon-saved" aria-hidden>
      {src ? (
        <img className="item-icon" src={src} width={size} height={size} alt="" />
      ) : (
        <span className="item-icon missing" style={{ width: size, height: size }} />
      )}
      <span className="find-badge">
        <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="6.5" cy="6.5" r="4" />
          <path d="M9.5 9.5 14 14" />
        </svg>
      </span>
    </span>
  )
}

/** An arrow dropping into an open crate: brought in on the bus, from outside the plan. */
function ImportIcon({ size }: { size: number }) {
  return (
    <span className="item-icon recipe-import-icon" style={{ width: size, height: size }} aria-hidden>
      <svg
        viewBox="0 0 16 16"
        width={size * 0.8}
        height={size * 0.8}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.5 8.5v4.5a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V8.5" />
        <path d="M1.5 8.5h3M11.5 8.5h3" />
        <path d="M8 1.5v8M5.5 7 8 9.5 10.5 7" />
      </svg>
    </span>
  )
}

/** A research tier badge: the game's tier icon and numeral. */
export function TierTag({ tier, title }: { tier: number; title?: string }) {
  const icon = iconUrl(tierIcon(tier))
  return (
    <span className="tag tier-tag" title={title ?? `Needs research tier ${tierName(tier)}`}>
      {icon && <img src={icon} width={14} height={14} alt="" />}
      {tierName(tier)}
    </span>
  )
}

function ChoiceTags({ choice, item, machine }: { choice: Choice; item: string; machine?: boolean }) {
  const p = choice.process
  const tier = choice.needs !== undefined && <TierTag tier={choice.needs} />
  if (!p || choice.value === CRUCIBLE) return tier || null
  return (
    <>
      {tier}
      {machine && p.license && (
        <span className="tag" title={`Unlocked by the ${p.license}, not research`}>
          {p.license}
        </span>
      )}
      {p.alternate && <span className="tag">alt</span>}
      {p.product !== item && <span className="tag">by-product</span>}
      {machine && choice.machine && p.machine && p.machine.speed !== 1 && <span className="tag">×{p.machine.speed} speed</span>}
      {machine && choice.machine && p.acceptsHeight && (
        <span className="tag" title="Set the height it's built at on its row">
          output by height
        </span>
      )}
      {machine && choice.machine && p.acceptsCatalysts && <span className="tag">catalysts</span>}
    </>
  )
}

/** Time per craft and heat draw. */
function ChoiceMeta({ choice }: { choice: Choice }) {
  const p = choice.process
  if (!p || choice.value === CRUCIBLE || !p.seconds) return null
  const heat = p.inputs.find((s) => s.item === HEAT)?.count ?? 0
  return (
    <span className="recipe-meta">
      {fmtSeconds(p.seconds)}
      {heat > 0 && ` · ${fmt(heat / p.seconds)} P/s`}
    </span>
  )
}

/** Ingredients → products of one craft, the wanted item first among the products. */
function ChoicePreview({ choice, item, shared }: { choice: Choice; item: string; shared: Set<string> }) {
  const p = choice.process
  if (choice.value === BUS)
    return choice.coin ? (
      <span className="recipe-preview">
        <Money copper={choice.coin} suffix=" each, as an input" />
      </span>
    ) : (
      <span className="recipe-preview muted">Made outside this plan, brought in for every row of it</span>
    )
  if (p?.kind === 'buy')
    return (
      <span className="recipe-preview">
        <Money copper={p.inputs[0]?.count ?? 0} suffix=" each" />
      </span>
    )
  if (choice.value === CRUCIBLE) return <span className="recipe-preview muted">Refines any item; pick the input alongside</span>
  if (!p) return null
  const ins = materials(p)
  const outs = [...p.outputs].sort((a, b) => Number(b.item === item) - Number(a.item === item))
  return (
    <span className="recipe-preview" aria-hidden>
      {ins.map((s) => (
        <Amount key={s.item} stack={s} className={shared.has(stackKey(s)) ? 'shared' : ''} />
      ))}
      {ins.length > 0 && <span className="recipe-arrow">→</span>}
      {outs.map((s) => (
        <Amount key={s.item} stack={s} className={s.item === item ? '' : 'byproduct'} />
      ))}
    </span>
  )
}

function Amount({ stack, className }: { stack: Stack; className: string }) {
  return (
    <span className={`recipe-amount ${className}`} title={`${fmt(stack.count)} × ${itemName(stack.item)}`}>
      {fmt(stack.count)}
      <ItemIcon item={stack.item} size={20} />
    </span>
  )
}
