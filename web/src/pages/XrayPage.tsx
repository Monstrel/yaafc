import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { BlueprintScene, type Above, type ModelStatus } from '../components/blueprint/blueprintScene'
import { buildingName } from '../components/blueprint/buildingKinds'
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

// The blueprint open on the page, kept while the player visits other pages.
let kept: Opened | null = null
const recipesByKey = new Map(gameRecipes.map((r) => [r.key, r]))

export function XrayPage() {
  const [opened, setOpened] = useState<Opened | null>(kept)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [dragging, setDragging] = useState(false)
  // The layers shown, from the bottom: null for all of them.
  const [cut, setCut] = useState<number | null>(null)
  const [above, setAbove] = useState<Above>('ghost')
  const [arrows, setArrows] = useState(true)
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

  const open = async (file: File) => {
    setReading(true)
    setError(null)
    try {
      const blueprint = await readBlueprint(new Uint8Array(await file.arrayBuffer()))
      if (kept) URL.revokeObjectURL(kept.preview)
      kept = { blueprint, fileName: file.name, preview: URL.createObjectURL(file) }
      setOpened(kept)
      setCut(null)
      setPicked(null)
    } catch (e) {
      setError(e instanceof BlueprintError ? e.message : `This file couldn’t be read: ${(e as Error).message}`)
    } finally {
      setReading(false)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) void open(file)
  }

  const chooser = (
    <>
      <button type="button" className={opened ? undefined : 'primary'} onClick={() => fileInput.current?.click()} disabled={reading}>
        {reading ? 'Reading…' : opened ? 'Open another blueprint' : 'Open a blueprint'}
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,.png"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void open(file)
          e.target.value = ''
        }}
      />
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
            The game saves your blueprints as pictures, in <code>%LOCALAPPDATA%\AlchemyFactory\Saved\Blueprints</code>. Their
            names are random letters, so pick one by its preview. Open it here, or drop it on this page.
          </p>
          <div className="xray-actions">{chooser}</div>
          {error && <p className="warning">{error}</p>}
        </div>
        {opened && (
          <div className="xray-summary">
            <img src={opened.preview} alt="" width={96} height={96} />
            <div>
              <h3>{opened.blueprint.title || 'Untitled blueprint'}</h3>
              {opened.blueprint.description && <p>{opened.blueprint.description}</p>}
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
          <CutControls above={above} onAbove={setAbove} arrows={arrows} onArrows={setArrows} />
          <XrayScene
            blueprint={opened.blueprint}
            cut={cut !== null && cut < total ? cut : null}
            above={above}
            arrows={arrows}
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
  above,
  onAbove,
  arrows,
  onArrows,
}: {
  above: Above
  onAbove: (a: Above) => void
  arrows: boolean
  onArrows: (shown: boolean) => void
}) {
  return (
    <div className="xray-controls">
      <div className="segmented" role="radiogroup" aria-label="Layers above the cut">
        {(['ghost', 'hidden'] as const).map((a) => (
          <button key={a} type="button" role="radio" aria-checked={above === a} aria-selected={above === a} onClick={() => onAbove(a)}>
            {a === 'ghost' ? 'Ghost the layers above' : 'Hide the layers above'}
          </button>
        ))}
      </div>
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
  above,
  arrows,
  picked,
  onPick,
  onModels,
  children,
}: {
  blueprint: Blueprint
  /** The layers shown, from the bottom: null for all of them. */
  cut: number | null
  above: Above
  arrows: boolean
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
  useEffect(() => scene.current!.setCut(cut, above), [blueprint, cut, above])
  useEffect(() => scene.current!.setArrows(arrows), [arrows])
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
