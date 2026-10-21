import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react'
import { BlueprintScene, type HiddenLook, type ModelStatus } from '../components/blueprint/blueprintScene'
import { buildingName, isBuildingBlock } from '../components/blueprint/buildingKinds'
import { buildingInfo } from '../components/blueprint/models'
import { ItemLabel } from '../components/ItemIcon'
import { ReferenceLink } from '../components/ReferenceLink'
import { BlueprintError, blueprintLayers, readBlueprint, type Blueprint, type PlacedBuilding } from '../lib/blueprint/blueprintFile'
import { buildingsByKey, gameRecipes } from '../lib/gameData'
import { noun } from '../lib/plural'

interface Opened {
  blueprint: Blueprint
  fileName: string
  /** The file itself, which is the blueprint's preview picture. */
  preview: string
}

/** A blueprint read from a folder (or several files) the player opened, to choose from by its name. */
interface Shelved extends Opened {
  modified: number
}

// The blueprint open on the page, and those read with it, kept while the player visits other pages.
let kept: Opened | null = null
let keptShelf: Shelved[] = []

/** Where the game keeps blueprints, as Windows' file dialogs take it in their address bar. */
const BLUEPRINT_FOLDER = '%LOCALAPPDATA%\\AlchemyFactory\\Saved\\Blueprints'
/**
 * Where Steam puts the blueprints a player subscribes to on the Workshop, a folder each (3669570 is
 * the game's app id), in a default Steam install.
 */
const WORKSHOP_FOLDER = '%ProgramFiles(x86)%\\Steam\\steamapps\\workshop\\content\\3669570'
const recipesByKey = new Map(gameRecipes.map((r) => [r.key, r]))

export function XrayPage() {
  const [opened, setOpened] = useState<Opened | null>(kept)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [shelf, setShelf] = useState<Shelved[]>(keptShelf)
  // The folder whose address was copied last.
  const [copied, setCopied] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  // The layers shown, from the bottom: null for all of them.
  const [cut, setCut] = useState<number | null>(null)
  const [look, setLook] = useState<HiddenLook>('ghost')
  const [arrows, setArrows] = useState(true)
  const [blocks, setBlocks] = useState(false)
  const [picked, setPicked] = useState<PlacedBuilding | null>(null)
  const [models, setModels] = useState<ModelStatus | null>(null)
  // The game's names for buildings and their heights in layers, from the models' manifest.
  const [info, setInfo] = useState<Map<string, { name: string; layers: number }>>(new Map())
  useEffect(() => {
    buildingInfo().then(setInfo, () => {})
  }, [])
  const nameOf = (key: string) => info.get(key.toLowerCase())?.name ?? buildingName(key)
  // Its layers counting the full height of what's on top (a drawbridge's towers), once known.
  const total = opened ? blueprintLayers(opened.blueprint, (key) => info.get(key.toLowerCase())?.layers ?? 1) : 1
  const fileInput = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement | null>(null)

  const show = (entry: Opened) => {
    // A preview not on the shelf belonged to the blueprint shown till now only.
    if (kept && !keptShelf.some((e) => e.preview === kept!.preview)) URL.revokeObjectURL(kept.preview)
    kept = entry
    setOpened(entry)
    setCut(null)
    setPicked(null)
  }

  /** Puts what was just read on the shelf in place of what was read before: nothing, for one blueprint. */
  const shelve = (entries: Shelved[]) => {
    for (const e of keptShelf) if (e.preview !== kept?.preview) URL.revokeObjectURL(e.preview)
    keptShelf = entries
    setShelf(entries)
  }

  /**
   * Reads blueprint files the player opened (or dropped): one shows at once; several, from a folder
   * or picked together, go on the shelf to choose from by name, newest first.
   */
  const openFiles = async (files: File[]) => {
    const pictures = files.filter((f) => /\.png$/i.test(f.name))
    setError(null)
    if (!pictures.length) {
      setError(files.length ? 'There are no blueprints here: the game saves them as .png files.' : 'No files were opened.')
      return
    }
    setReading(true)
    const read = await Promise.all(
      pictures.map(async (file) => {
        try {
          return { file, blueprint: await readBlueprint(new Uint8Array(await file.arrayBuffer())) }
        } catch (e) {
          if (pictures.length === 1) setError(e instanceof BlueprintError ? e.message : `This file couldn’t be read: ${(e as Error).message}`)
          return null
        }
      }),
    )
    setReading(false)
    const found = read.flatMap((r) => (r ? [r] : []))
    if (!found.length) {
      if (pictures.length > 1) setError('None of these files is an Alchemy Factory blueprint.')
      return
    }
    if (found.length === 1) {
      // Before `show`, which then lets go of the preview shown till now, it being off the shelf.
      shelve([])
      show({ blueprint: found[0].blueprint, fileName: found[0].file.name, preview: URL.createObjectURL(found[0].file) })
      return
    }
    const entries = found
      .map(({ file, blueprint }) => ({ blueprint, fileName: file.name, preview: URL.createObjectURL(file), modified: file.lastModified }))
      .sort((a, b) => b.modified - a.modified)
    shelve(entries)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    void openFiles([...e.dataTransfer.files])
  }

  const filesChosen = (e: ChangeEvent<HTMLInputElement>) => {
    void openFiles([...(e.target.files ?? [])])
    e.target.value = ''
  }
  const chooser = (
    <>
      <button type="button" className={opened ? undefined : 'primary'} onClick={() => folder.current?.click()} disabled={reading}>
        {reading ? 'Reading…' : 'Open your blueprints folder'}
      </button>
      <button type="button" onClick={() => fileInput.current?.click()} disabled={reading}>
        Open a blueprint file
      </button>
      {[
        { folder: BLUEPRINT_FOLDER, label: 'your blueprints folder' },
        { folder: WORKSHOP_FOLDER, label: 'the Workshop folder' },
      ].map(({ folder, label }) => (
        <button
          key={folder}
          type="button"
          onClick={() => void navigator.clipboard.writeText(folder).then(() => setCopied(folder))}
          title={`${folder}: paste it into the folder dialog’s address bar to go straight there`}
        >
          {copied === folder ? `Copied ${label}’s address` : `Copy ${label}’s address`}
        </button>
      ))}
      {/* A folder picker: an ordinary file input that takes a folder. The File System Access API's
          picker won't open anything under AppData\Local, where the game keeps blueprints. */}
      <input
        ref={(input) => {
          folder.current = input
          input?.setAttribute('webkitdirectory', '')
        }}
        type="file"
        hidden
        onChange={filesChosen}
      />
      <input ref={fileInput} type="file" accept="image/png,.png" multiple hidden onChange={filesChosen} />
    </>
  )

  return (
    <div
      className={dragging ? 'page xray dragging' : 'page xray'}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <section className="panel xray-intro">
        <div className="xray-intro-text">
          <h2>Blueprint X-ray</h2>
          <p>
            See inside a blueprint without building it. Turn it around in 3D and cut it away from the top, layer by
            layer, to see how a compact build is put together.
          </p>
          <p className="muted">
            The game saves your blueprints as pictures with random names, in <code>{BLUEPRINT_FOLDER}</code>. Open that
            folder to choose one by its name in the game (paste its address into the folder dialog), or open or drop a
            blueprint file. Blueprints you subscribe to on the Steam Workshop download elsewhere, a folder each, in{' '}
            <code>{WORKSHOP_FOLDER}</code> (in your Steam library’s <code>steamapps</code> if it’s on another drive): open
            that folder to choose from all of them. Your browser may ask to “upload” a folder: its files stay on your
            computer, read here in the page.
          </p>
          <div className="xray-actions">{chooser}</div>
          {error && <p className="warning">{error}</p>}
          {shelf.length > 0 && <Shelf entries={shelf} current={opened?.preview} onOpen={show} />}
        </div>
        {opened && (
          <div className="xray-summary">
            <img src={opened.preview} alt="" width={96} height={96} />
            <div>
              <h3>{opened.blueprint.title || 'Untitled blueprint'}</h3>
              {opened.blueprint.description && <p className="xray-description">{opened.blueprint.description}</p>}
              <p className="muted">
                {opened.blueprint.buildings.length} {noun(opened.blueprint.buildings.length, 'building')} ·{' '}
                {opened.blueprint.size[0]} × {opened.blueprint.size[1]} cells · {total} {noun(total, 'layer')}
              </p>
            </div>
          </div>
        )}
      </section>

      {opened && (
        <section className="panel xray-view">
          <CutControls
            look={look}
            onLook={setLook}
            arrows={arrows}
            onArrows={setArrows}
            blocks={blocks}
            onBlocks={(hidden) => {
              setBlocks(hidden)
              // A hidden building can't be clicked, so it isn't left picked either.
              if (hidden && picked && isBuildingBlock(picked.name)) setPicked(null)
            }}
          />
          <XrayScene
            blueprint={opened.blueprint}
            cut={cut !== null && cut < total ? cut : null}
            look={look}
            arrows={arrows}
            blocks={blocks}
            picked={picked}
            onPick={setPicked}
            onModels={setModels}
          >
            <LayerSlider total={total} layers={Math.min(cut ?? total, total)} onLayers={(n) => setCut(n >= total ? null : n)} />
          </XrayScene>
          <div className="xray-side">
            <Picked building={picked} nameOf={nameOf} />
            <BuildingList blueprint={opened.blueprint} nameOf={nameOf} />
            <ModelNote status={models} nameOf={nameOf} />
          </div>
        </section>
      )}
    </div>
  )
}

const shelfDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** The blueprints in the folder the player opened, by their names in the game, newest first. */
function Shelf({ entries, current, onOpen }: { entries: Shelved[]; current?: string; onOpen: (entry: Shelved) => void }) {
  return (
    <ul className="xray-shelf" aria-label="Blueprints in the folder">
      {entries.map((e) => (
        <li key={e.preview}>
          <button type="button" aria-current={e.preview === current ? 'true' : undefined} onClick={() => onOpen(e)}>
            <img src={e.preview} alt="" width={36} height={36} />
            <span className="xray-shelf-name">{e.blueprint.title || 'Untitled blueprint'}</span>
            <span className="muted">
              {e.blueprint.buildings.length} {noun(e.blueprint.buildings.length, 'building')} · {e.blueprint.size[0]} ×{' '}
              {e.blueprint.size[1]} · {shelfDate.format(e.modified)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * The layers shown, as a vertical slider over the view: up for more, as the blueprint stands, with
 * a button above to put back a layer and one below to peel one off.
 */
function LayerSlider({ total, layers, onLayers }: { total: number; layers: number; onLayers: (n: number) => void }) {
  const label = `Showing layers 1–${layers} of ${total}`
  return (
    <div className="xray-layers" role="group" aria-label="Layers shown" title={label}>
      <span className="xray-layers-count" aria-hidden>
        {layers}
        <small>/{total}</small>
      </span>
      <button type="button" onClick={() => onLayers(Math.min(total, layers + 1))} disabled={layers >= total} title="Put back a layer">
        +
      </button>
      <input
        type="range"
        min={1}
        max={total}
        value={layers}
        aria-label={label}
        onChange={(e) => onLayers(Number(e.target.value))}
      />
      <button type="button" onClick={() => onLayers(Math.max(1, layers - 1))} disabled={layers <= 1} title="Peel off the top layer">
        −
      </button>
    </div>
  )
}

function CutControls({
  look,
  onLook,
  arrows,
  onArrows,
  blocks,
  onBlocks,
}: {
  look: HiddenLook
  onLook: (look: HiddenLook) => void
  arrows: boolean
  onArrows: (shown: boolean) => void
  blocks: boolean
  onBlocks: (hidden: boolean) => void
}) {
  return (
    <div className="xray-controls">
      <div className="xray-look" title="How the layers above the cut, and building blocks when hidden, are drawn">
        <span id="xray-look-label" className="muted">
          Hidden buildings
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="xray-look-label">
          {(['ghost', 'gone'] as const).map((l) => (
            <button key={l} type="button" role="radio" aria-checked={look === l} aria-selected={look === l} onClick={() => onLook(l)}>
              {l === 'ghost' ? 'Ghosts' : 'Invisible'}
            </button>
          ))}
        </div>
      </div>
      <label className="xray-toggle" title="Blocks, beams, lab stands, platforms, pillars, floors and walls: there only to take up space">
        <input type="checkbox" checked={blocks} onChange={(e) => onBlocks(e.target.checked)} />
        Hide building blocks
      </label>
      <label className="xray-toggle" title="Arrows on belts, pointing the way items go">
        <input type="checkbox" checked={arrows} onChange={(e) => onArrows(e.target.checked)} />
        Belt directions
      </label>
    </div>
  )
}

function XrayScene({
  blueprint,
  cut,
  look,
  arrows,
  blocks,
  picked,
  onPick,
  onModels,
  children,
}: {
  blueprint: Blueprint
  /** The layers shown, from the bottom: null for all of them. */
  cut: number | null
  look: HiddenLook
  arrows: boolean
  /** Whether the building blocks are hidden, looking as `look` says, as the layers above the cut do. */
  blocks: boolean
  picked: PlacedBuilding | null
  onPick: (b: PlacedBuilding | null) => void
  onModels: (status: ModelStatus) => void
  /** Controls laid over the view. */
  children?: ReactNode
}) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<BlueprintScene | null>(null)

  useEffect(() => {
    const s = new BlueprintScene(host.current!)
    scene.current = s
    return () => {
      s.dispose()
      scene.current = null
    }
  }, [])
  useEffect(() => {
    scene.current!.onPick = onPick
    scene.current!.onModels = onModels
  }, [onPick, onModels])
  useEffect(() => scene.current!.show(blueprint), [blueprint])
  // After `show`, so a new blueprint keeps the cut the page has for it.
  useEffect(() => scene.current!.setCut(cut, look), [blueprint, cut, look])
  useEffect(() => scene.current!.setArrows(arrows), [arrows])
  // After `show`, which sorts a new blueprint's buildings by the choice the scene already has.
  useEffect(() => scene.current!.setBlocks(blocks), [blocks])
  useEffect(() => scene.current!.select(picked), [blueprint, picked])

  return (
    <div className="xray-canvas-wrap">
      <div className="xray-stage">
        <div ref={host} className="xray-canvas" />
        {children}
      </div>
      <p className="xray-hint muted">
        Drag to turn · right-drag or Shift-drag to move · scroll to zoom · click a building to see what it is
        <button type="button" onClick={() => scene.current?.resetView()}>
          Reset view
        </button>
      </p>
    </div>
  )
}

function Picked({ building, nameOf }: { building: PlacedBuilding | null; nameOf: (key: string) => string }) {
  if (!building) return <p className="muted xray-picked">Click a building to see what it is.</p>
  const recipe = building.recipe ? recipesByKey.get(building.recipe) : undefined
  const name = nameOf(building.name)
  return (
    <div className="xray-picked">
      <h3>{buildingsByKey.has(building.name) ? <ReferenceLink to={{ machine: building.name }}>{name}</ReferenceLink> : name}</h3>
      <p className="muted">
        Layer {building.cell[2] + 1} · {building.area[0]} × {building.area[1]} {noun(building.area[0] * building.area[1], 'cell')}
      </p>
      {recipe && (
        <p className="note-line">
          Makes <ItemLabel item={recipe.output.item} />
        </p>
      )}
      {building.text && <p className="xray-sign">“{building.text}”</p>}
    </div>
  )
}

/** What the blueprint is made of: each kind of building and how many, most first. */
function BuildingList({ blueprint, nameOf }: { blueprint: Blueprint; nameOf: (key: string) => string }) {
  const counts = new Map<string, number>()
  for (const b of blueprint.buildings) counts.set(nameOf(b.name), (counts.get(nameOf(b.name)) ?? 0) + 1)
  const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return (
    <ul className="xray-buildings">
      {rows.map(([name, count]) => (
        <li key={name}>
          <span>{name}</span> <span className="muted">{count}</span>
        </li>
      ))}
    </ul>
  )
}

function ModelNote({ status, nameOf }: { status: ModelStatus | null; nameOf: (key: string) => string }) {
  if (!status) return null
  if (status.state === 'loading') return <p className="muted xray-note">Loading the game’s models…</p>
  if (status.state === 'failed')
    return <p className="warning xray-note">The game’s models couldn’t be loaded, so buildings are boxes. {status.message}</p>
  if (!status.missing.length) return null
  return (
    <p className="muted xray-note">
      Shown as boxes, as the game draws them without models: {status.missing.map(nameOf).join(', ')}.
    </p>
  )
}
