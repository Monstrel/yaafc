import { useEffect, useRef, useState, type DragEvent } from 'react'
import { BlueprintScene, type Above } from '../components/blueprint/blueprintScene'
import { buildingColor, buildingKind, buildingName, KINDS } from '../components/blueprint/buildingKinds'
import { ItemLabel } from '../components/ItemIcon'
import { ReferenceLink } from '../components/ReferenceLink'
import { BlueprintError, readBlueprint, type Blueprint, type PlacedBuilding } from '../lib/blueprint/blueprintFile'
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
  const [layers, setLayers] = useState(() => kept?.blueprint.size[2] ?? 1)
  const [above, setAbove] = useState<Above>('ghost')
  const [picked, setPicked] = useState<PlacedBuilding | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const open = async (file: File) => {
    setReading(true)
    setError(null)
    try {
      const blueprint = await readBlueprint(new Uint8Array(await file.arrayBuffer()))
      if (kept) URL.revokeObjectURL(kept.preview)
      kept = { blueprint, fileName: file.name, preview: URL.createObjectURL(file) }
      setOpened(kept)
      setLayers(blueprint.size[2])
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
                {opened.blueprint.size[0]} × {opened.blueprint.size[1]} cells · {opened.blueprint.size[2]}{' '}
                {noun(opened.blueprint.size[2], 'layer')}
              </p>
            </div>
          </div>
        )}
      </section>

      {opened && (
        <section className="panel xray-view">
          <CutControls
            total={opened.blueprint.size[2]}
            layers={layers}
            onLayers={setLayers}
            above={above}
            onAbove={setAbove}
          />
          <XrayScene blueprint={opened.blueprint} layers={layers} above={above} picked={picked} onPick={setPicked} />
          <div className="xray-side">
            <Picked building={picked} />
            <Legend blueprint={opened.blueprint} />
          </div>
        </section>
      )}
    </div>
  )
}

function CutControls({
  total,
  layers,
  onLayers,
  above,
  onAbove,
}: {
  total: number
  layers: number
  onLayers: (n: number) => void
  above: Above
  onAbove: (a: Above) => void
}) {
  return (
    <div className="xray-controls">
      <label className="xray-cut">
        <span>
          Showing layers 1–{layers} of {total}
        </span>
        <button type="button" onClick={() => onLayers(Math.max(1, layers - 1))} disabled={layers <= 1} title="Peel off the top layer">
          −
        </button>
        <input type="range" min={1} max={total} value={layers} onChange={(e) => onLayers(Number(e.target.value))} />
        <button type="button" onClick={() => onLayers(Math.min(total, layers + 1))} disabled={layers >= total} title="Put back a layer">
          +
        </button>
      </label>
      <div className="segmented" role="radiogroup" aria-label="Layers above the cut">
        {(['ghost', 'hidden'] as const).map((a) => (
          <button key={a} type="button" role="radio" aria-checked={above === a} aria-selected={above === a} onClick={() => onAbove(a)}>
            {a === 'ghost' ? 'Ghost the layers above' : 'Hide the layers above'}
          </button>
        ))}
      </div>
    </div>
  )
}

function XrayScene({
  blueprint,
  layers,
  above,
  picked,
  onPick,
}: {
  blueprint: Blueprint
  layers: number
  above: Above
  picked: PlacedBuilding | null
  onPick: (b: PlacedBuilding | null) => void
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
  }, [onPick])
  useEffect(() => scene.current!.show(blueprint), [blueprint])
  // After `show`, so a new blueprint keeps the cut the page has for it.
  useEffect(() => scene.current!.setCut(layers, above), [blueprint, layers, above])
  useEffect(() => scene.current!.select(picked), [blueprint, picked])

  return (
    <div className="xray-canvas-wrap">
      <div ref={host} className="xray-canvas" />
      <p className="xray-hint muted">
        Drag to turn · right-drag or Shift-drag to move · scroll to zoom · click a building to see what it is
        <button type="button" onClick={() => scene.current?.resetView()}>
          Reset view
        </button>
      </p>
    </div>
  )
}

function Picked({ building }: { building: PlacedBuilding | null }) {
  if (!building) return <p className="muted xray-picked">Click a building to see what it is.</p>
  const recipe = building.recipe ? recipesByKey.get(building.recipe) : undefined
  const name = buildingName(building.name)
  return (
    <div className="xray-picked">
      <h3>
        <span className="xray-swatch" style={{ background: buildingColor(building.name) }} />
        {buildingsByKey.has(building.name) ? <ReferenceLink to={{ machine: building.name }}>{name}</ReferenceLink> : name}
      </h3>
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

function Legend({ blueprint }: { blueprint: Blueprint }) {
  const counts = new Map<string, number>()
  for (const b of blueprint.buildings) {
    const kind = buildingKind(b.name)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return (
    <ul className="xray-legend">
      {KINDS.filter((k) => counts.has(k.kind)).map((k) => (
        <li key={k.kind}>
          <span className="xray-swatch" style={{ background: k.color }} />
          {k.label} <span className="muted">{counts.get(k.kind)}</span>
        </li>
      ))}
    </ul>
  )
}
