import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { ItemIcon } from '../components/ItemIcon'
import { Money } from '../components/Money'
import { PageLink } from '../components/PageLink'
import { SidebarIcon } from '../components/planner/PlanPanels'
import { UpgradesPanel } from '../components/UpgradesPanel'
import { altarYield } from '../lib/altar'
import { contractFor, dispatchTerms, licenseName } from '../lib/dispatch'
import { fmt, fmtSeconds, fmtTenth } from '../lib/format'
import {
  buildingsByKey,
  buyTier,
  cauldronIngredients,
  coinValue,
  HEAT,
  iconUrl,
  itemName,
  isCauldronTarget,
  itemsByKey,
  machinesByKey,
  MAX_TIER,
  MONEY,
  NUTRIENTS,
  STEAM,
  targetItems,
  tierIcon,
  tierName,
  type Building,
  type Item,
  type Stack,
} from '../lib/gameData'
import { itemNameFor, noun } from '../lib/plural'
import { craftsPerMachine, outputCap } from '../lib/machineRate'
import { paradoxInputs, paradoxSeconds, PURCHASING_PORTAL, type Process, type ProcessCatalog } from '../lib/processes'
import {
  BASE_MODS,
  buildingTier,
  catalystFor,
  craftSeconds,
  entryReach,
  catalogSections,
  fertilizers,
  fuels,
  hasOwnTime,
  heatPerSecond,
  isListedItem,
  itemShown,
  isListedMachine,
  itemSections,
  itemRelations,
  MACHINE_GROUPS,
  machineGroup,
  groupRelations,
  machineRelations,
  machineShown,
  mirrorOf,
  onMachine,
  processShown,
  referenceCatalog,
  referenceMachines,
  referenceSearch,
  relics,
  newReferenceView,
  TAB_NAMES,
  type CatalogSection,
  type CatalogTab,
  type ReferenceScope,
  type ReferenceView,
  type Role,
} from '../lib/reference'
import { noteFor, type Block, type Inline, type Note } from '../lib/notes'
import { entryOf, groupByKey, type ItemGroup } from '../lib/referenceGroups'
import type { Page } from '../lib/router'
import { STEAM_HEAT } from '../lib/steamBoiler'
import type { Progress, SavedRecipe } from '../lib/types'
import type { Modifiers } from '../lib/upgrades'

interface Props {
  /** The page's query string: which entry it shows. */
  search: string
  onNavigate: (page: Page, search?: string) => void
  view: ReferenceView
  onView: (update: (v: ReferenceView) => ReferenceView) => void
  saved: SavedRecipe[]
  /** The player's game: research tier and upgrade levels, which every figure follows. */
  progress: Progress
  mods: Modifiers
  onProgress: (label: string, update: (p: Progress) => Progress) => void
  /** Whether what's past the research tier stays hidden. */
  hideLocked: boolean
  onHideLocked: (on: boolean) => void
  /** Whether the upgrades sidebar is open. */
  sideOpen: boolean
  onSideOpen: (open: boolean) => void
  /** The open plan's name, and whether it already aims for an item. */
  planName: string
  planTargets: (item: string) => boolean
  onPlan: (item: string, how: 'new' | 'add') => void
  onFindCauldron: (item: string) => void
}

export function ReferencePage(props: Props) {
  const { search, saved, mods, progress, hideLocked } = props
  const tier = progress.tier ?? MAX_TIER
  const catalog = useMemo(() => referenceCatalog(saved, mods, tier), [saved, mods, tier])
  const scope = useMemo(() => ({ catalog, mods, tier, hideLocked }), [catalog, mods, tier, hideLocked])
  const params = new URLSearchParams(search)
  const item = params.get('item')
  const machine = params.get('machine')
  const nav = (entry: { item?: string; machine?: string }) => props.onNavigate('reference', referenceSearch(entry))
  const links = { onNavigate: props.onNavigate, scope }

  return (
    <div className="page reference">
      <div className={props.sideOpen ? 'planner-layout' : 'planner-layout side-closed'}>
        <aside className="planner-side" id="reference-side">
          <button
            className="icon-button side-toggle"
            onClick={() => props.onSideOpen(!props.sideOpen)}
            aria-controls="reference-side"
            aria-expanded={props.sideOpen}
            title={props.sideOpen ? 'Hide upgrades' : 'Show upgrades'}
          >
            <SidebarIcon open={props.sideOpen} />
          </button>
          <UpgradesPanel
            progress={progress}
            mods={mods}
            tier={tier}
            onProgress={props.onProgress}
            hint="Your game’s progress, shared with the Planner. Every figure here follows it."
          >
            <label className="ref-hide-locked">
              <input type="checkbox" checked={hideLocked} onChange={(e) => props.onHideLocked(e.target.checked)} />
              <span className="upgrade-name">
                Hide what&apos;s past research tier {tierName(tier)}
                <span className="upgrade-effect">
                  {tier === MAX_TIER ? 'every tier is reached: nothing to hide' : 'items, machines and recipes you haven’t reached'}
                </span>
              </span>
            </label>
          </UpgradesPanel>
        </aside>
        <main className="planner-main">
          {item !== null || machine !== null ? (
            <Entry {...props} item={item} machine={machine} catalog={catalog} links={links} />
          ) : (
            <ReferenceIndex {...props} links={links} onOpen={nav} />
          )}
        </main>
      </div>
    </div>
  )
}

/** An item's or a machine's page, unless it's past the research tier and the player keeps those hidden. */
function Entry({
  item,
  machine,
  ...props
}: Props & { item: string | null; machine: string | null; catalog: ProcessCatalog; links: Links }) {
  const { catalog, links } = props
  // An entry past the research tier the player chose to see anyway.
  const [revealed, setRevealed] = useState<string | null>(null)
  const group = item !== null ? groupByKey(entryOf(item)) : undefined
  // Machines the Reference leaves out (ones players can't build) have no page; mirrored copies do.
  const found =
    group ??
    (item !== null
      ? itemsByKey.get(item)
      : isListedMachine(machine!) || mirrorOf(machine!)
        ? buildingsByKey.get(machine!)
        : undefined)
  const key = group?.key ?? item ?? machine!
  const shown = item !== null ? itemShown(links.scope, key) : machineShown(links.scope, key)
  const needs = item !== null ? entryReach(catalog, key) : buildingTier(key)
  return (
    <>
      <nav className="ref-crumbs">
        <PageLink page="reference" onNavigate={props.onNavigate}>
          ← All items and machines
        </PageLink>
      </nav>
      {!found && machine !== null && buildingsByKey.has(machine) ? (
        <div className="panel empty-state">
          <h2>Not a machine you can build</h2>
          <p>{buildingsByKey.get(machine)!.name} is in the game&apos;s data, but the game doesn&apos;t let players build it.</p>
        </div>
      ) : !found ? (
        <div className="panel empty-state">
          <h2>Not in the game data</h2>
          <p>
            No {item !== null ? 'item' : 'machine'} is called “{key}”. It may have been renamed or removed in a game
            update.
          </p>
        </div>
      ) : !shown && revealed !== key ? (
        <div className="panel empty-state">
          <h2>Past your research tier</h2>
          <p>
            This {item !== null ? 'item' : 'machine'}{' '}
            {Number.isFinite(needs) ? `comes with research tier ${tierName(needs)}` : 'is out of reach'}, and you&apos;ve
            chosen to hide what&apos;s past tier {tierName(links.scope.tier)}.
          </p>
          <p>
            <button type="button" onClick={() => setRevealed(key)}>
              Show it anyway
            </button>
          </p>
        </div>
      ) : group ? (
        <GroupEntry key={group.key} group={group} {...props} catalog={catalog} links={links} />
      ) : item !== null ? (
        <ItemEntry key={item} item={found as Item} {...props} catalog={catalog} links={links} />
      ) : (
        <MachineEntry key={machine} building={found as Building} {...props} catalog={catalog} links={links} />
      )}
    </>
  )
}

// ---- Index ----

const SHOW: [ReferenceView['show'], string][] = [
  ['all', 'All'],
  ['materials', 'Materials'],
  ['goods', 'Goods'],
  ['machines', 'Machines'],
]

/** The Catalog tabs each choice shows. */
const tabsShown = (show: ReferenceView['show']): CatalogTab[] =>
  show === 'all' ? ['materials', 'goods', 'other'] : show === 'machines' ? [] : [show]

function ReferenceIndex({
  view,
  onView,
  links,
  onOpen,
}: Props & { links: Links; onOpen: (entry: { item?: string; machine?: string }) => void }) {
  const { scope } = links
  const query = view.query.trim().toLowerCase()
  const matches = (name: string) => !query || name.toLowerCase().includes(query)
  const tabs = tabsShown(view.show)
  const offered = catalogSections.filter((s) => tabs.includes(s.tab))
  const sections = offered
    .filter((s) => !view.section || s.id === view.section)
    .map((s) => ({
      ...s,
      items: s.items.filter((i) => matches(i.name) || !!groupByKey(i.key)?.members.some((m) => matches(itemName(m)))),
    }))
  // What the search finds past the research tier, when those are hidden.
  const lockedItems = new Set(sections.flatMap((s) => s.items.filter((i) => !itemShown(scope, i.key)).map((i) => i.key)))
  const shownSections = sections
    .map((s) => ({ ...s, items: s.items.filter((i) => !lockedItems.has(i.key)) }))
    .filter((s) => s.items.length)
  const machinesShown = (view.show === 'all' || view.show === 'machines') && !view.section
  const found = machinesShown ? referenceMachines.filter((b) => matches(b.name)) : []
  const lockedMachines = found.filter((b) => !machineShown(scope, b.key)).length
  const machineGroups = MACHINE_GROUPS.map((g) => ({
    group: g,
    machines: found.filter((b) => machineGroup(b) === g && machineShown(scope, b.key)),
  })).filter((g) => g.machines.length)
  const firstItem = shownSections[0]?.items[0]
  const firstMachine = machineGroups[0]?.machines[0]
  const first = firstItem ? { item: firstItem.key } : firstMachine ? { machine: firstMachine.key } : null

  return (
    <>
      <section className="panel ref-index-bar">
        <input
          type="search"
          className="ref-search"
          placeholder="Search items and machines…"
          aria-label="Search items and machines"
          value={view.query}
          onChange={(e) => onView((v) => ({ ...v, query: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && first) onOpen(first)
          }}
        />
        <div className="ref-toggle" role="group" aria-label="Show">
          {SHOW.map(([s, label]) => (
            <button
              key={s}
              type="button"
              aria-pressed={view.show === s}
              onClick={() =>
                onView((v) => ({
                  ...v,
                  show: s,
                  // A section stays picked while the tab showing it does.
                  section: catalogSections.some((c) => c.id === v.section && tabsShown(s).includes(c.tab)) ? v.section : null,
                }))
              }
            >
              {label}
            </button>
          ))}
        </div>
        {offered.length > 0 && (
          <div className="ref-sections" role="group" aria-label="Catalog section">
            <button type="button" className="chip" aria-pressed={!view.section} onClick={() => onView((v) => ({ ...v, section: null }))}>
              Every section
            </button>
            {tabs.map((t) => (
              <Fragment key={t}>
                {offered.some((s) => s.tab === t) && tabs.length > 1 && <span className="ref-sections-tab">{TAB_NAMES[t]}</span>}
                {offered
                  .filter((s) => s.tab === t)
                  .map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="chip"
                      aria-pressed={view.section === s.id}
                      onClick={() => onView((v) => ({ ...v, section: v.section === s.id ? null : s.id }))}
                    >
                      {s.name}
                    </button>
                  ))}
              </Fragment>
            ))}
          </div>
        )}
        <p className="hint">
          Every item and machine in the game, and the recipes between them. Items are filed as in the game&apos;s Item
          Catalog, where some are both a material and goods. Figures follow your upgrades. Press
          Enter to open the first match.
        </p>
      </section>

      {tabs.map((t) => {
        const list = shownSections.filter((s) => s.tab === t)
        const hidden = new Set(
          sections.filter((s) => s.tab === t).flatMap((s) => s.items.filter((i) => lockedItems.has(i.key)).map((i) => i.key)),
        ).size
        if (!list.length && !hidden) return null
        const count = new Set(list.flatMap((s) => s.items.map((i) => i.key))).size
        return (
          <section key={t} className="panel">
            <h2>
              {TAB_NAMES[t]} <span className="pill">{count}</span>
            </h2>
            <HiddenNote count={hidden} what="item" scope={scope} />
            {t === 'other' && <p className="hint">Items the game&apos;s Catalog leaves out.</p>}
            {list.map((s) => (
              <Fragment key={s.id}>
                {t !== 'other' && (
                  <h3 className="ref-group">
                    {s.name} <span className="pill">{s.items.length}</span>
                  </h3>
                )}
                <ul className="ref-grid">
                  {s.items.map((i) => (
                    <li key={i.key}>
                      <ItemLink item={i.key} {...links} card />
                    </li>
                  ))}
                </ul>
              </Fragment>
            ))}
          </section>
        )
      })}

      {(machineGroups.length > 0 || lockedMachines > 0) && (
        <section className="panel">
          <h2>
            Machines <span className="pill">{machineGroups.reduce((n, g) => n + g.machines.length, 0)}</span>
          </h2>
          <HiddenNote count={lockedMachines} what="machine" scope={scope} />
          {machineGroups.map(({ group, machines }) => (
            <Fragment key={group}>
              <h3 className="ref-group">
                {group} <span className="pill">{machines.length}</span>
              </h3>
              <ul className="ref-grid">
                {machines.map((b) => (
                  <li key={b.key}>
                    <MachineLink machine={b.key} {...links} card />
                  </li>
                ))}
              </ul>
            </Fragment>
          ))}
        </section>
      )}

      {!sections.some((s) => s.items.length) && !found.length && (
        <div className="panel empty-state">
          <p>Nothing matches “{view.query.trim()}”.</p>
        </div>
      )}
    </>
  )
}

// ---- Item ----

type EntryProps = Props & { catalog: ProcessCatalog; links: Links }

function ItemEntry({
  item,
  catalog,
  links,
  planName,
  planTargets,
  onPlan,
  onFindCauldron,
  onView,
  onNavigate,
  saved,
}: EntryProps & { item: Item }) {
  const rel = useMemo(() => itemRelations(catalog, item.key), [catalog, item.key])
  const reach = catalog.itemReach(item.key)
  const targetable = targetItems.includes(item)
  const inPlan = planTargets(item.key)
  const savedMixes = rel.makers.filter((m) => m.process.kind === 'cauldron')
  const makers = rel.makers.filter((m) => m.process.kind !== 'cauldron')
  const builds = rel.builds.filter((b) => machineShown(links.scope, b.key))
  // Cauldrons can make it, and the research tier has them (or the player shows everything).
  const mixable = isCauldronTarget(item.key) && machineShown(links.scope, 'Cauldron')
  return (
    <>
      <section className="panel ref-head">
        <ItemIcon item={item.key} size={64} />
        <div className="ref-head-text">
          <h2>{item.name}</h2>
          <ItemKind entry={item.key} reach={reach} links={links} onView={onView} onNavigate={onNavigate} />
          {item.description && <p className="ref-description">{item.description}</p>}
        </div>
        <div className="ref-actions">
          {targetable && (
            <>
              <button type="button" className="primary" onClick={() => onPlan(item.key, 'new')}>
                New plan for {item.name}
              </button>
              <button
                type="button"
                onClick={() => onPlan(item.key, 'add')}
                title={inPlan ? `“${planName}” already makes it: open it` : `Add ${item.name} as a target of “${planName}”`}
              >
                {inPlan ? `Open “${planName}”` : `Add to “${planName}”`}
              </button>
            </>
          )}
          {mixable && (
            <button type="button" onClick={() => onFindCauldron(item.key)} title="Search the Cauldron for mixes that make it">
              Find cauldron mixes
            </button>
          )}
        </div>
      </section>

      <NotePanel note={noteFor('item', item.key)} links={links} />

      <ItemFacts item={item} links={links} />

      <RecipeSection
        title="Made by"
        empty={
          rel.paradoxMade ? null : item.key === STEAM ? null : 'Nothing makes it: it comes from outside the factory.'
        }
        catalog={catalog}
        focus={item.key}
        links={links}
        list={makers}
      >
        {rel.paradoxMade && machineShown(links.scope, 'ParadoxCrucible') && (
          <p>
            Any item that travels on a belt refines into it in a{' '}
            <MachineLink machine="ParadoxCrucible" {...links} />, each at its own speed.
          </p>
        )}
      </RecipeSection>

      {mixable && (
        <section className="panel">
          <h2>
            Your cauldron recipes <span className="pill">{savedMixes.length}</span>
          </h2>
          {savedMixes.length ? (
            <RecipeList list={savedMixes} focus={item.key} catalog={catalog} links={links} />
          ) : (
            <p className="hint">
              {saved.length
                ? 'None of your saved recipes makes it.'
                : 'You haven’t saved any cauldron recipes yet.'}{' '}
              Cauldrons can make it from the right mix: find one in the{' '}
              <button type="button" className="link-button" onClick={() => onFindCauldron(item.key)}>
                Cauldron
              </button>
              {' '}and star it to save it here.
            </p>
          )}
        </section>
      )}

      <RecipeSection
        title="Used in"
        empty={rel.builds.length ? null : 'No recipe takes it in.'}
        catalog={catalog}
        focus={item.key}
        links={links}
        list={rel.uses.map((process) => ({ process }))}
      />

      {rel.builds.length > 0 && (
        <section className="panel">
          <h2>
            Builds <span className="pill">{builds.length}</span>
          </h2>
          <HiddenNote count={rel.builds.length - builds.length} what="machine" scope={links.scope} />
          <ul className="ref-builds">
            {builds.map((b) => (
              <li key={b.key}>
                <MachineLink machine={b.key} {...links} />
                <span className="ref-cost">
                  {b.cost.map((s) => (
                    <StackChip key={s.item} item={s.item} count={s.count} focus={item.key} {...links} />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

/**
 * Items the game keeps out of sight (the tiers of refined sand), together: what each is worth,
 * what makes them, how one turns into the next, and what they make.
 */
function GroupEntry({ group, catalog, links, onView, onNavigate }: EntryProps & { group: ItemGroup }) {
  const { scope } = links
  const rel = useMemo(() => groupRelations(catalog, group), [catalog, group])
  const first = itemsByKey.get(group.members[0])!
  const members = group.members.map((k) => itemsByKey.get(k)!)
  const shown = members.filter((m) => itemShown(scope, m.key))
  const has = (machine: string) => machineShown(scope, machine)
  const value = has('Cauldron')
  const crucible = has('ParadoxCrucible')
  const altar = has('KnowledgeAltar')
  return (
    <>
      <section className="panel ref-head">
        <ItemIcon item={first.key} size={64} />
        <div className="ref-head-text">
          <h2>{group.name}</h2>
          <ItemKind entry={group.key} reach={entryReach(catalog, group.key)} links={links} onView={onView} onNavigate={onNavigate} />
          {first.description && <p className="ref-description">{first.description}</p>}
        </div>
      </section>

      <NotePanel note={noteFor('item', group.key)} links={links} />

      <section className="panel">
        <h2>
          Tiers <span className="pill">{shown.length}</span>
        </h2>
        <HiddenNote count={members.length - shown.length} what="tier" scope={scope} />
        <div className="table-scroll">
          <table className="ref-table">
            <thead>
              <tr>
                <th>Item</th>
                {value && <th className="num">Cauldron value</th>}
                {crucible && <th className="num">Paradox Crucible</th>}
                {altar && <th className="num">Knowledge Altar</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const exp = altar ? altarYield(m.key, scope.mods) : null
                return (
                  <tr key={m.key}>
                    <td>
                      <span className="ref-stack focus">
                        <ItemIcon item={m.key} size={20} />
                        <span className="name">{m.name}</span>
                      </span>
                    </td>
                    {value && <td className="num">{fmt(m.cauldronCost)}</td>}
                    {crucible && <td className="num">{fmtSeconds(paradoxSeconds(m.key) / scope.mods.factorySpeed)}</td>}
                    {altar && <td className="num">{exp ? `${fmt(exp.exp)} EXP` : '–'}</td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <RecipeSection title="Made by" empty={null} catalog={catalog} focus={group.key} links={links} list={rel.makers} />
      <RecipeSection
        title="Refining"
        empty={null}
        catalog={catalog}
        focus={group.key}
        links={links}
        list={rel.steps.map((process) => ({ process }))}
      />
      <RecipeSection
        title="Used in"
        empty={null}
        catalog={catalog}
        focus={group.key}
        links={links}
        list={rel.uses.map((process) => ({ process }))}
      />
    </>
  )
}

/** "Material: Solid · Goods: Sundries · III": where the Catalog files it (each a link to that section), and its tier. */
function ItemKind({
  entry,
  reach,
  links,
  onView,
  onNavigate,
}: {
  entry: string
  reach: number
  links: Links
  onView: Props['onView']
  onNavigate: Props['onNavigate']
}) {
  const places = itemSections(entry)
  /** Back to the index, showing one of the Catalog sections the item is in. */
  const openSection = (s: CatalogSection) => {
    onView(() => ({ ...newReferenceView(), show: s.tab === 'other' ? 'all' : s.tab, section: s.id }))
    onNavigate('reference')
  }
  return (
    <p className="ref-kind">
      {(['materials', 'goods', 'other'] as const).map((t) => {
        const here = places.filter((s) => s.tab === t)
        return (
          here.length > 0 && (
            <span key={t} className="ref-place">
              {t === 'other' ? 'Item' : t === 'materials' ? 'Material' : 'Goods'}:{' '}
              {here.map((s, k) => (
                <Fragment key={s.id}>
                  {k > 0 && ', '}
                  <button type="button" className="link-button" onClick={() => openSection(s)} title={`Show the ${s.name} section`}>
                    {s.name}
                  </button>
                </Fragment>
              ))}
            </span>
          )
        )
      })}
      {Number.isFinite(reach) && reach > 1 && (
        <>
          {' · '}
          <TierBadge tier={reach} reached={links.scope.tier} what="To have it" />
        </>
      )}
    </p>
  )
}

function ItemFacts({ item, links }: { item: Item; links: Links }) {
  const { scope } = links
  const { mods } = scope
  const has = (machine: string) => machineShown(scope, machine)
  const facts: [string, ReactNode][] = []
  if (item.liquid) facts.push(['Moves by', 'Pipe (a liquid)'])
  else if (item.maxStack > 0) facts.push(['Stacks to', fmt(item.maxStack)])
  if (item.buyPrice != null && has(PURCHASING_PORTAL) && (!scope.hideLocked || buyTier(item.key) <= scope.tier))
    facts.push([
      'Purchasing Portal',
      <>
        <Money copper={item.buyPrice} /> each
      </>,
    ])
  if (item.sellPrice != null)
    facts.push([
      'Shop pays',
      <>
        <Money copper={item.sellPrice} /> each, before shop upgrades
      </>,
    ])
  const terms = has('Portal_Wholesaling') ? dispatchTerms(item.key, mods) : null
  if (terms)
    facts.push([
      'Dispatch Portal',
      <>
        {fmt(terms.contract.count)} per contract for{' '}
        {terms.pay.map((c) => (
          <Money key={c.coin} copper={c.count * (coinValue(c.coin) ?? 1)} />
        ))}
        , {fmt(terms.perDay)} contracts a day
        <Because>
          {terms.locked
            ? `needs the ${licenseName(terms.contract.license)} license`
            : terms.licenses > 0
              ? `with the ${licenseName(terms.licenses)} license`
              : 'with no Supplier License'}
        </Because>
      </>,
    ])
  if (item.heatValue > 0 && item.key !== STEAM)
    facts.push([
      'Fuel',
      <>
        {fmt(item.heatValue * mods.fuel)} P of heat burned
        <Upgraded base={`${fmt(item.heatValue)} P`} factor={mods.fuel} upgrade="Fuel Efficiency" />
      </>,
    ])
  if (item.key === STEAM && has('SteamHeater'))
    facts.push([
      'Heat',
      <>
        {STEAM_HEAT} P each on a <MachineLink machine="SteamHeater" {...links} />
        <Because>Fuel Efficiency doesn&apos;t apply</Because>
      </>,
    ])
  if (item.nutrientValue > 0)
    facts.push([
      'Fertilizer',
      <>
        {fmt(item.nutrientValue * mods.fertilizer)} nutrients
        <Upgraded base={fmt(item.nutrientValue)} factor={mods.fertilizer} upgrade="Fertilizer Efficiency" />, grows plants
        at {fmt(item.nutrientSpeed * mods.factorySpeed)} nutrients/s
        <Upgraded base={fmt(item.nutrientSpeed)} factor={mods.factorySpeed} upgrade="Factory Efficiency" />
      </>,
    ])
  const catalyst = catalystFor(item.key)
  if (catalyst && has('AdvancedAthanor'))
    facts.push([
      'Catalyst',
      <>
        {catalyst.description} {fmt(catalyst.charges)} charges, in an <MachineLink machine="AdvancedAthanor" {...links} />
      </>,
    ])
  if (cauldronIngredients.some((i) => i.key === item.key) && has('Cauldron')) facts.push(['Cauldron value', fmt(item.cauldronCost)])
  if (paradoxInputs.some((i) => i.key === item.key) && has('ParadoxCrucible'))
    facts.push([
      'Paradox Crucible',
      <>
        {fmtSeconds(paradoxSeconds(item.key) / mods.factorySpeed)} per <ItemLink item="Mors" {...links} />
        <Upgraded base={fmtSeconds(paradoxSeconds(item.key))} factor={mods.factorySpeed} upgrade="Factory Efficiency" divides />
      </>,
    ])
  const altar = has('KnowledgeAltar') ? altarYield(item.key, mods) : null
  if (altar)
    facts.push([
      'Knowledge Altar',
      <>
        {fmt(altar.exp)} EXP each
        {altar.relic && <Upgraded base={fmt(altar.exp / mods.altar)} factor={mods.altar} upgrade="Relic Knowledge" />},{' '}
        {fmtSeconds(altar.seconds)} to break down
        <Upgraded base={fmtSeconds(altar.seconds * mods.factorySpeed)} factor={mods.factorySpeed} upgrade="Factory Efficiency" divides />
        {altar.relic && ' (a relic)'}
      </>,
    ])
  if (!facts.length) return null
  return (
    <section className="panel">
      <dl className="ref-facts">
        {facts.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  )
}

/** How an upgrade changed a figure from the base game's: "(base 6s ÷ 1.5 Factory Efficiency)". */
function Upgraded({ base, factor, upgrade, divides }: { base: string; factor: number; upgrade: string; divides?: boolean }) {
  if (Math.abs(factor - 1) < 1e-9) return null
  return (
    <span className="ref-because">
      {' '}
      (base {base} {divides ? '÷' : '×'} {fmt(factor)} {upgrade})
    </span>
  )
}

/** Why a figure is what it is, after it. */
function Because({ children }: { children: ReactNode }) {
  return <span className="ref-because"> ({children})</span>
}

// ---- Machine ----

function MachineEntry({ building, catalog, links, onNavigate }: EntryProps & { building: Building }) {
  const original = mirrorOf(building.key)
  const own = original ?? building.key
  const rel = useMemo(() => machineRelations(catalog, building.key), [catalog, building.key])
  const machine = machinesByKey.get(own)
  const tier = buildingTier(building.key)
  const refined = rel.runs.filter((p) => p.kind === 'paradox')
  const crucible = refined.filter((p) => itemShown(links.scope, p.inputs[0].item))
  const runs = rel.runs.filter((p) => p.kind !== 'paradox').map((p) => onMachine(catalog, p, own))
  const facts: [string, ReactNode][] = []
  if (building.cost.length)
    facts.push([
      'Build cost',
      <span key="cost" className="ref-cost">
        {building.cost.map((s) => (
          <StackChip key={s.item} item={s.item} count={s.count} {...links} />
        ))}
      </span>,
    ])
  const ports = building.ports
  const portText = [
    ports.beltIn && `${ports.beltIn} belt ${noun(ports.beltIn, 'input')}`,
    ports.beltOut && `${ports.beltOut} belt ${noun(ports.beltOut, 'output')}`,
    ports.pipeIn && `${ports.pipeIn} pipe ${noun(ports.pipeIn, 'input')}`,
    ports.pipeOut && `${ports.pipeOut} pipe ${noun(ports.pipeOut, 'output')}`,
  ].filter(Boolean)
  facts.push(['Connections', portText.length ? portText.join(', ') : 'None: worked by hand'])
  const speed = machine && machine.usesFactorySpeed ? links.scope.mods.factorySpeed : 1
  if (building.heatCost > 0)
    facts.push([
      'Heat',
      <>
        {fmtTenth(building.heatCost * speed)} P/s while working, from the furnace or heating pad under it
        <Upgraded base={`${fmtTenth(building.heatCost)} P/s`} factor={speed} upgrade="Factory Efficiency" />
      </>,
    ])
  if (machine && (machine.speed !== 1 || speed !== 1))
    facts.push([
      'Speed',
      <>
        ×{fmt(machine.speed * speed)}
        {speed !== 1 && <Because>{`×${fmt(machine.speed)} built in, ×${fmt(speed)} Factory Efficiency`}</Because>}
      </>,
    ])
  if (machine?.heightScaled) facts.push(['Height', 'Output grows by 1/128 per grid space it’s built up, to ×3'])
  if (machine && !machine.usesFactorySpeed) facts.push(['Factory Efficiency', 'Doesn’t speed it up'])
  const alike = rel.alike.filter((b) => machineShown(links.scope, b.key))
  if (alike.length)
    facts.push([
      'Same recipes as',
      <span key="alike" className="ref-inline-list">
        {alike.map((b) => (
          <MachineLink key={b.key} machine={b.key} {...links} />
        ))}
      </span>,
    ])
  if (original)
    facts.push(['Mirrored copy of', <MachineLink key="original" machine={original} {...links} />])
  else if (rel.mirrors.length) facts.push(['Mirrored copy', 'Can be built mirrored, its connections flipped'])

  const cauldron = own === 'Cauldron' || own === 'AdvancedCauldron'
  return (
    <>
      <section className="panel ref-head">
        <BuildingIcon building={building.key} size={64} />
        <div className="ref-head-text">
          <h2>{building.name}</h2>
          <p className="ref-kind">
            Machine · {machineGroup(building)}
            {tier > 1 && (
              <>
                {' · '}
                <TierBadge tier={tier} reached={links.scope.tier} what="To build it" />
              </>
            )}
          </p>
          {building.description && <p className="ref-description">{building.description}</p>}
        </div>
        {cauldron && (
          <div className="ref-actions">
            <PageLink page="cauldron" onNavigate={onNavigate} className="button">
              Open the Cauldron
            </PageLink>
          </div>
        )}
      </section>

      <NotePanel note={noteFor('machine', own)} links={links} />

      <section className="panel">
        <dl className="ref-facts">
          {facts.map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      </section>

      <MachineExtras building={own} links={links} />

      {(runs.length > 0 || cauldron) && (
        <RecipeSection
          title={cauldron ? 'Your cauldron recipes' : 'Recipes'}
          empty={
            cauldron
              ? 'It mixes any ingredients into something new: find mixes in the Cauldron, and the ones you save show here.'
              : null
          }
          catalog={catalog}
          links={links}
          list={runs.map((process) => ({ process }))}
          machine={own}
        >
          {cauldron && runs.length > 0 && (
            <p className="hint">Besides these, it mixes any ingredients into something new: find mixes in the Cauldron.</p>
          )}
        </RecipeSection>
      )}

      {refined.length > 0 && (
        <section className="panel">
          <h2>
            Refines <span className="pill">{crucible.length}</span>
          </h2>
          <HiddenNote count={refined.length - crucible.length} what="item" scope={links.scope} />
          <p className="hint">
            One belt entry of any of these (a stack, for coins) into one <ItemLink item="Mors" {...links} />, each at its
            own speed, burning {fmt(building.heatCost * speed)} P/s. Times follow Factory Efficiency.
          </p>
          <ul className="ref-grid ref-grid-dense">
            {crucible
              .map((p) => p.inputs[0].item)
              .sort((a, b) => itemName(a).localeCompare(itemName(b)))
              .map((i) => (
                <li key={i}>
                  <ItemLink item={i} {...links} />
                  <span className="ref-muted">{fmtSeconds(paradoxSeconds(i) / speed)}</span>
                </li>
              ))}
          </ul>
        </section>
      )}
    </>
  )
}

/** What machines that run no recipes of their own work with. */
function MachineExtras({ building, links }: { building: string; links: Links }) {
  const { scope } = links
  const { mods } = scope
  if (building === 'StoneStove' || building === 'StoneFurnace')
    return (
      <ListSection
        title="Fuels"
        hint={`What it can burn to heat the machine on it. Any fuel heats any machine.${mods.fuel !== 1 ? ` Heat at ×${fmt(mods.fuel)} Fuel Efficiency.` : ''}`}
        hidden={fuels.length - fuels.filter((i) => itemShown(scope, i.key)).length}
        scope={scope}
      >
        {fuels
          .filter((i) => itemShown(scope, i.key))
          .map((i) => (
            <li key={i.key}>
              <ItemLink item={i.key} {...links} />
              <span className="ref-muted">{fmt(i.heatValue * mods.fuel)} P</span>
            </li>
          ))}
      </ListSection>
    )
  if (building === 'SteamHeater')
    return (
      <ListSection title="Fuel" hint="Heats the machine on it with Steam from pipes, which Steam Boilers make.">
        <li>
          <ItemLink item={STEAM} {...links} />
          <span className="ref-muted">{STEAM_HEAT} P</span>
        </li>
      </ListSection>
    )
  if (building === 'AutoNursery')
    return (
      <ListSection
        title="Fertilizers"
        hint={`What it grows its plants on: the fertilizer sets how fast they grow. Nutrients at ×${fmt(mods.fertilizer)} Fertilizer Efficiency, speed at ×${fmt(mods.factorySpeed)} Factory Efficiency.`}
        hidden={fertilizers.length - fertilizers.filter((i) => itemShown(scope, i.key)).length}
        scope={scope}
      >
        {fertilizers
          .filter((i) => itemShown(scope, i.key))
          .map((i) => (
            <li key={i.key}>
              <ItemLink item={i.key} {...links} />
              <span className="ref-muted">
                {fmt(i.nutrientValue * mods.fertilizer)} nutrients · {fmt(i.nutrientSpeed * mods.factorySpeed)}/s
              </span>
            </li>
          ))}
      </ListSection>
    )
  if (building === 'KnowledgeAltar')
    return (
      <ListSection
        title="Relics"
        hint={`Any item breaks down for EXP by its value; these give far more.${mods.altar !== 1 ? ` EXP at ×${fmt(mods.altar)} Relic Knowledge.` : ''}`}
        hidden={relics.length - relics.filter((i) => itemShown(scope, i.key)).length}
        scope={scope}
      >
        {relics
          .filter((i) => itemShown(scope, i.key))
          .map((i) => (
            <li key={i.key}>
              <ItemLink item={i.key} {...links} />
              <span className="ref-muted">{fmt(altarYield(i.key, mods)!.exp)} EXP</span>
            </li>
          ))}
      </ListSection>
    )
  if (building === 'Portal_Wholesaling')
    return (
      <ListSection
        title="Contracts"
        hint="What buyers take, a whole contract at a time, up to a limit each day: contracts a day with your Supplier Licenses."
        hidden={contracted.length - contracted.filter((i) => itemShown(scope, i.key)).length}
        scope={scope}
      >
        {contracted
          .filter((i) => itemShown(scope, i.key))
          .map((i) => {
            const t = dispatchTerms(i.key, mods)!
            return (
              <li key={i.key}>
                <ItemLink item={i.key} {...links} />
                <span className="ref-muted">
                  {fmt(t.perDay)} × {fmt(t.contract.count)} a day{t.locked ? ` · needs ${licenseName(t.contract.license)}` : ''}
                </span>
              </li>
            )
          })}
      </ListSection>
    )
  if (building === 'SeedPlot')
    return (
      <section className="panel">
        <p className="hint">
          Worked by hand, so the Planner doesn&apos;t plan with it: it plans <MachineLink machine="AutoNursery" {...links} />{' '}
          instead.
        </p>
      </section>
    )
  return null
}

/** Items buyers take at the Dispatch Portal. */
const contracted = targetItems.filter((i) => contractFor(i.key))

function ListSection({
  title,
  hint,
  hidden,
  scope,
  children,
}: {
  title: string
  hint: string
  hidden?: number
  scope?: ReferenceScope
  children: ReactNode
}) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <p className="hint">{hint}</p>
      {scope && <HiddenNote count={hidden ?? 0} what="item" scope={scope} />}
      <ul className="ref-grid ref-grid-dense">{children}</ul>
    </section>
  )
}

// ---- Notes ----

/** The note written for a page, if any. */
function NotePanel({ note, links }: { note: Note | undefined; links: Links }) {
  if (!note) return null
  return (
    <section className="panel ref-notes">
      {note.blocks.map((b, i) => (
        <NoteBlock key={i} block={b} links={links} />
      ))}
    </section>
  )
}

function NoteBlock({ block, links }: { block: Block; links: Links }) {
  if (block.kind === 'heading') {
    const H = block.level === 2 ? 'h3' : 'h4'
    return (
      <H>
        <NoteText inlines={block.children} links={links} />
      </H>
    )
  }
  if (block.kind === 'list') {
    const L = block.ordered ? 'ol' : 'ul'
    return (
      <L>
        {block.items.map((item, i) => (
          <li key={i}>
            <NoteText inlines={item} links={links} />
          </li>
        ))}
      </L>
    )
  }
  return (
    <p>
      <NoteText inlines={block.children} links={links} />
    </p>
  )
}

function NoteText({ inlines, links }: { inlines: Inline[]; links: Links }) {
  return inlines.map((x, i) => {
    switch (x.kind) {
      case 'text':
        return <Fragment key={i}>{x.text}</Fragment>
      case 'code':
        return <code key={i}>{x.text}</code>
      case 'strong':
        return (
          <strong key={i}>
            <NoteText inlines={x.children} links={links} />
          </strong>
        )
      case 'em':
        return (
          <em key={i}>
            <NoteText inlines={x.children} links={links} />
          </em>
        )
      case 'link': {
        const text = <NoteText inlines={x.children} links={links} />
        if ('url' in x.to)
          return (
            <a key={i} href={x.to.url} target="_blank" rel="noreferrer">
              {text}
            </a>
          )
        return (
          <PageLink key={i} page="reference" search={referenceSearch(x.to)} onNavigate={links.onNavigate}>
            {text}
          </PageLink>
        )
      }
    }
  })
}

// ---- Recipes ----

interface Listed {
  process: Process
  role?: Role
}

function RecipeSection({
  title,
  list,
  empty,
  children,
  ...rest
}: {
  title: string
  list: Listed[]
  /** Said when the list is empty (null: say nothing). */
  empty: string | null
  children?: ReactNode
  catalog: ProcessCatalog
  focus?: string
  machine?: string
  links: Links
}) {
  if (!list.length && !empty && !children) return null
  const { scope } = rest.links
  const shown = list.filter((l) => processShown(scope, l.process))
  return (
    <section className="panel">
      <h2>
        {title} <span className="pill">{shown.length}</span>
      </h2>
      {children}
      <HiddenNote count={list.length - shown.length} what="recipe" scope={scope} />
      {shown.length > 0 && <UpgradeNote list={shown} mods={scope.mods} />}
      {shown.length ? <RecipeList list={shown} {...rest} /> : !list.length && empty && <p className="hint">{empty}</p>}
    </section>
  )
}

/** "3 recipes past research tier IV hidden." */
function HiddenNote({ count, what, scope }: { count: number; what: string; scope: ReferenceScope }) {
  if (!count) return null
  return (
    <p className="hint ref-hidden">
      {count} {noun(count, what)} past research tier {tierName(scope.tier)} hidden.
    </p>
  )
}

/** The upgrades a list of recipes' times and rates follow, where they're not the base game's. */
function UpgradeNote({ list, mods }: { list: Listed[]; mods: Modifiers }) {
  const parts: string[] = []
  if (mods.factorySpeed !== 1 && list.some((l) => l.process.machine?.usesFactorySpeed))
    parts.push(`×${fmt(mods.factorySpeed)} crafting speed (Factory Efficiency)`)
  if (mods.extractor !== 1 && list.some((l) => /Extractor|Alembic/.test(l.process.machine?.key ?? '')))
    parts.push(`×${fmt(mods.extractor)} Extractor & Alembic output (Alchemy Skill)`)
  if (mods.beltSpeed !== BASE_MODS.beltSpeed && list.some((l) => outputCap(l.process, mods) < 1 - 1e-9))
    parts.push(`${fmt(mods.beltSpeed)} items/min belts (Logistics Efficiency)`)
  if (!parts.length) return null
  return <p className="hint">Times, rates and heat at your upgrades: {parts.join(', ')}.</p>
}

function RecipeList({
  list,
  focus,
  machine,
  links,
}: {
  list: Listed[]
  focus?: string
  machine?: string
  catalog: ProcessCatalog
  links: Links
}) {
  return (
    <ul className="ref-recipes">
      {list.map(({ process, role }) => (
        <RecipeRow key={process.id} p={process} role={role} focus={focus} machine={machine} links={links} />
      ))}
    </ul>
  )
}

const ROLE_TEXT: Record<Role, string | null> = { product: null, 'by-product': 'by-product', failed: 'from failed crafts' }

function RecipeRow({
  p,
  role,
  focus,
  machine,
  links,
}: {
  p: Process
  role?: Role
  focus?: string
  machine?: string
  links: Links
}) {
  const timed = hasOwnTime(p)
  // One machine's crafts a minute at base speed, as the planner counts them: held back by what its
  // output belts carry.
  const { mods } = links.scope
  const crafts = timed ? craftsPerMachine(p, mods) : null
  const capped = timed && outputCap(p, mods) < 1 - 1e-9
  const stack = (s: Stack) => (
    <span key={s.item} className="ref-io">
      <StackChip item={s.item} count={s.count} focus={focus} {...links} />
      {crafts !== null && (
        <span className="ref-rate" title="Per machine, at your upgrades">
          {fmt(s.count * crafts)}/min
        </span>
      )}
    </span>
  )
  const heat = heatPerSecond(p, links.scope.mods)
  const inputs = p.inputs.filter((s) => s.item !== HEAT)
  // Fail chances, and what's special about a World Tree (the rest of a process's notes are the planner's).
  const notes =
    p.kind === 'recipe' ? p.notes.filter((n) => n.includes('%')) : p.kind === 'nursery' && !p.seed ? p.notes : p.kind === 'cauldron' ? p.notes : []
  // The machine its rates are for first, then the others able to run it.
  const machines = machine
    ? []
    : [p.machine, ...p.machineOptions.filter((m) => m.key !== p.machine?.key)].filter(
        (m): m is NonNullable<typeof m> => !!m && machineShown(links.scope, m.key),
      )
  return (
    <li className="ref-recipe">
      <div className="ref-flow">
        <span className="ref-stacks">
          {p.seed && <StackChip item={p.seed} focus={focus} {...links} title="Planted in the Nursery, not used up" />}
          {inputs.map(stack)}
        </span>
        <span className="ref-arrow" aria-label="makes">
          →
        </span>
        <span className="ref-stacks">
          {p.outputs.map(stack)}
        </span>
      </div>
      <div className="ref-meta">
        {p.kind === 'cauldron' && <span className="tag mine-tag">★ {p.name ?? 'Saved recipe'}</span>}
        {machines.map((m, k) => (
          <Fragment key={m.key}>
            {k > 0 && <span className="ref-muted">or</span>}
            <MachineLink machine={m.key} {...links} />
          </Fragment>
        ))}
        {timed && (
          <span>
            {fmtSeconds(craftSeconds(p, mods))} per craft
          </span>
        )}
        {capped && (
          <span className="tag" title={`At your upgrades it could craft faster than its output belts carry (${fmt(mods.beltSpeed)} items/min each), so it slows to match them`}>
            held back by its output belt
          </span>
        )}
        {p.kind === 'nursery' && p.seed && <span className="ref-muted">speed set by its fertilizer</span>}
        {heat > 0 && <span title="Heat it burns while working">🔥 {fmtTenth(heat)} P/s</span>}
        {role && ROLE_TEXT[role] && <span className="tag">{ROLE_TEXT[role]}</span>}
        {p.alternate && <span className="tag">alternate</span>}
        {p.license && (
          <span className="tag" title={`Unlocked by the ${p.license}, not research`}>
            {p.license}
          </span>
        )}
        {p.tier > 1 && <TierBadge tier={p.tier} reached={links.scope.tier} what="To run it" />}
      </div>
      {notes.map((n) => (
        <p key={n} className="ref-note">
          {n}
        </p>
      ))}
    </li>
  )
}

// ---- Links and labels ----

interface Links {
  onNavigate: (page: Page, search?: string) => void
  /** The player's upgrades and research tier, and whether what's past it is hidden. */
  scope: ReferenceScope
}

function StackChip({
  item,
  count,
  focus,
  onNavigate,
  title,
}: { item: string; count?: number; focus?: string; title?: string } & Links) {
  if (item === MONEY) return <Money copper={count ?? 0} />
  if (item === NUTRIENTS)
    return (
      <span className="ref-stack">
        <ItemIcon item={item} size={20} />
        <span className="count">{fmt(count ?? 0)}</span> nutrients
      </span>
    )
  const label = (
    <>
      <ItemIcon item={item} size={20} />
      {count !== undefined && <span className="count">{fmt(count)}</span>}
      <span className="name">{count === undefined ? itemName(item) : itemNameFor(item, count)}</span>
    </>
  )
  const here = focus !== undefined && entryOf(item) === focus
  if (here || !isListedItem(item))
    return (
      <span className={here ? 'ref-stack focus' : 'ref-stack'} title={title}>
        {label}
      </span>
    )
  return (
    <PageLink page="reference" search={referenceSearch({ item })} onNavigate={onNavigate} className="ref-stack" title={title}>
      {label}
    </PageLink>
  )
}

function ItemLink({ item, card, onNavigate }: { item: string; card?: boolean } & Links) {
  const group = groupByKey(item)
  if (!group && !isListedItem(item)) return <span className="ref-link">{itemName(item)}</span>
  return (
    <PageLink
      page="reference"
      search={referenceSearch({ item })}
      onNavigate={onNavigate}
      className={card ? 'ref-card' : 'ref-link'}
      title={card ? itemSections(item).map((s) => s.name).join(', ') || undefined : undefined}
    >
      <ItemIcon item={group?.members[0] ?? item} size={card ? 32 : 20} />
      <span className="name">{group?.name ?? itemName(item)}</span>
    </PageLink>
  )
}

function MachineLink({ machine, card, onNavigate, scope }: { machine: string; card?: boolean } & Links) {
  const b = buildingsByKey.get(machine)
  if (!b || !isListedMachine(machine)) return <span className="ref-link">{b?.name ?? machine}</span>
  const needs = buildingTier(machine)
  return (
    <PageLink page="reference" search={referenceSearch({ machine })} onNavigate={onNavigate} className={card ? 'ref-card' : 'ref-link'}>
      <BuildingIcon building={machine} size={card ? 32 : 20} />
      <span className="name">{b.name}</span>
      {card && needs > 1 && <TierBadge tier={needs} reached={scope.tier} what="To build it" />}
    </PageLink>
  )
}

function BuildingIcon({ building, size }: { building: string; size: number }) {
  const src = iconUrl(buildingsByKey.get(building)?.icon)
  return src ? (
    <img className="item-icon" src={src} width={size} height={size} alt="" loading="lazy" />
  ) : (
    <span className="item-icon missing" style={{ width: size, height: size }} aria-hidden />
  )
}

/** A research tier: marked when the player hasn't reached it yet. */
function TierBadge({ tier, reached, what }: { tier: number; reached: number; what: string }) {
  const icon = iconUrl(tierIcon(tier))
  const locked = tier > reached
  return (
    <span
      className={locked ? 'tag tier-tag' : 'tag tier-tag reached'}
      title={`${what} needs research tier ${tierName(tier)}${locked ? ', beyond yours' : ''}`}
    >
      {icon && <img src={icon} width={14} height={14} alt="" />}
      {tierName(tier)}
    </span>
  )
}
