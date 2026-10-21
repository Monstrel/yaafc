import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  FrontSide,
  GridHelper,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  Plane,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { CELL, layersOf, type Blueprint, type PlacedBuilding } from '../../lib/blueprint/blueprintFile'
import { buildingColor, buildingKind, type BuildingKind } from './buildingKinds'
import { buildingModel, onTextureLoad, type Part } from './models'

/** What the layers above the cut look like: gone, or a faint ghost to keep their place in view. */
export type Above = 'hidden' | 'ghost'
export type ModelStatus = { state: 'loading' } | { state: 'ready'; missing: string[] } | { state: 'failed'; message: string }

/**
 * A blueprint in 3D, one cell to a unit: the game's x and y run along three's x and z, and its
 * layers go up three's y. The game's models are placed in its own space (Unreal's: z up, 25 units
 * to a cell) inside a group that turns that into the scene's; swapping two axes also turns
 * Unreal's left-handed space right-handed, so nothing is mirrored.
 *
 * Until the models are in, and for buildings the game draws without static meshes, each building
 * is a box over its cells.
 *
 * The cutaway goes by layers: each building (each part of a lift) fills whole layers, its height
 * in the game. Below the cut it shows whole, even where its model pokes a little over its top
 * layer (a cauldron's rim); above, it's a ghost or gone; across the cut, it's sliced at the cut.
 *
 * Looking into a sliced model through its cut, the view meets the back of its faces: those are
 * drawn flat and dark, so the cut reads as solid. (Filling the cut plane itself, by counting faces
 * in the stencil buffer, needs closed models, and most of the game's have gaps where nothing shows.)
 */
export class BlueprintScene {
  private host: HTMLElement
  private renderer: WebGLRenderer
  private scene = new Scene()
  private camera = new PerspectiveCamera(40, 1, 0.1, 1000)
  private controls: OrbitControls
  private floor: GridHelper | null = null
  /** The models, in the game's space. */
  private world = new Group()
  private batches: Batch[] = []
  private placeholders: Batch | null = null
  private placed: PlacedBuilding[] = []
  /** Each building's layers, from its own: how high it stands. */
  private heights: number[] = []
  private selection: LineSegments | null = null
  private below = new Plane(new Vector3(0, -1, 0), 0)
  private above = new Plane(new Vector3(0, 1, 0), 0)
  private ghostWhole = new MeshLambertMaterial({ color: 0xb8b0c4, transparent: true, opacity: 0.1, depthWrite: false })
  private ghostSliced = this.ghostWhole.clone()
  /** The insides of sliced models, seen through their cut. */
  private inside = new MeshBasicMaterial({ color: 0x1b1a20, side: BackSide })
  private boxMaterial = new MeshLambertMaterial({ side: DoubleSide })
  /** The models' materials as sliced at the cut, by the material they're made from. */
  private slicedMaterials = new Map<Material, Material>()
  private unitBox = new BoxGeometry(1, 1, 1)
  private dirty = true
  private resize: ResizeObserver
  private stopTextures: () => void
  private home = { position: new Vector3(), target: new Vector3() }
  /** Layers shown: Infinity for all of them. */
  private cut = Infinity
  private shown = 0

  /** Called with the building clicked, or null for a click on nothing. */
  onPick: (building: PlacedBuilding | null) => void = () => {}
  /** Called as the models for the shown blueprint load. */
  onModels: (status: ModelStatus) => void = () => {}

  constructor(host: HTMLElement) {
    this.host = host
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.localClippingEnabled = true
    this.renderer.toneMapping = NeutralToneMapping
    host.appendChild(this.renderer.domElement)
    this.ghostSliced.clippingPlanes = [this.above]
    this.inside.clippingPlanes = [this.below]

    // A soft room's light for the models' metal and gloss, a sun for shape.
    const pmrem = new PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.6
    pmrem.dispose()
    this.scene.add(new HemisphereLight(0xffffff, 0x554a60, 0.8))
    this.scene.add(new AmbientLight(0xffffff, 0.2))
    const sun = new DirectionalLight(0xffffff, 1.6)
    sun.position.set(0.6, 1, 0.35)
    this.scene.add(sun)

    // Unreal's space to the scene's: x stays, y and z swap, and 25 units make a cell.
    this.world.matrixAutoUpdate = false
    this.world.matrix.set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1).multiply(new Matrix4().makeScale(1 / CELL, 1 / CELL, 1 / CELL))
    this.world.matrixWorldNeedsUpdate = true
    this.scene.add(this.world)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.screenSpacePanning = true
    this.controls.addEventListener('change', () => (this.dirty = true))

    this.resize = new ResizeObserver(() => this.fit())
    this.resize.observe(host)
    this.listenForClicks()
    // The models show before their textures have downloaded: draw again as each one arrives.
    this.stopTextures = onTextureLoad(() => (this.dirty = true))
    this.renderer.setAnimationLoop(() => {
      if (this.controls.update()) this.dirty = true
      if (!this.dirty) return
      this.dirty = false
      this.renderer.render(this.scene, this.camera)
    })
  }

  show(blueprint: Blueprint) {
    this.clear()
    const shown = ++this.shown
    this.placed = blueprint.buildings
    this.heights = this.placed.map((b) => layersOf(b))
    const [w, d, h] = blueprint.size

    this.floor = new GridHelper(Math.max(w, d) + 4, Math.max(w, d) + 4, 0x6d6478, 0x3c3645)
    this.floor.position.set(w / 2, 0, d / 2)
    this.scene.add(this.floor)
    this.placeholders = this.addBoxes(this.placed.map((_, i) => i))

    // Looking down at it from a corner, far enough back to see all of it across the narrower of
    // the view's width and height (a phone's view is taller than it's wide).
    this.fit()
    const center = new Vector3(w / 2, h / 3, d / 2)
    const radius = new Vector3(w, h, d).length() / 2
    const halfHeight = (this.camera.fov * Math.PI) / 360
    const halfWidth = Math.atan(Math.tan(halfHeight) * this.camera.aspect)
    const distance = radius / Math.sin(Math.min(halfHeight, halfWidth))
    this.home.target.copy(center)
    this.home.position.copy(center).add(new Vector3(-0.75, 0.8, -1).normalize().multiplyScalar(distance * 1.05))
    this.controls.maxDistance = distance * 4
    this.resetView()

    // Each building, and for a lift the parts stacked on it.
    const pieces: Piece[] = this.placed.flatMap((b, i) => [
      { building: i, name: b.name, variant: b.variant, rotation: b.rotation, layer: 0 },
      ...(b.stack ?? []).map((s, k) => ({ building: i, name: s.name, variant: undefined, rotation: s.rotation, layer: k + 1 })),
    ])
    this.onModels({ state: 'loading' })
    Promise.all(pieces.map((p) => buildingModel(p.name, p.variant))).then(
      (models) => {
        if (shown !== this.shown) return
        if (this.placeholders) this.removeBatch(this.placeholders)
        this.placeholders = null
        this.heights = this.placed.map(() => 0)
        pieces.forEach((p, at) => (this.heights[p.building] = Math.max(this.heights[p.building], p.layer + models[at].layers)))
        this.addModels(pieces, models)
        // A building without models of its own is a box.
        const missing = pieces.flatMap((p, at) => (p.layer === 0 && !models[at].parts ? [p.building] : []))
        if (missing.length) this.addBoxes(missing)
        this.onModels({ state: 'ready', missing: [...new Set(missing.map((i) => this.placed[i].name))] })
      },
      (e: unknown) => {
        if (shown === this.shown) this.onModels({ state: 'failed', message: (e as Error).message })
      },
    )
  }

  /** Shows the bottom `layers` layers (null: all of them); the rest are ghosts or hidden. */
  setCut(layers: number | null, above: Above) {
    this.cut = layers ?? Infinity
    // Far above everything rather than Infinity, which shaders needn't take.
    const plane = Math.min(this.cut, 1e6)
    this.below.constant = plane
    this.above.constant = -plane
    this.ghostWhole.visible = this.ghostSliced.visible = above === 'ghost'
    for (const batch of this.batches) batch.cut(this.cut)
    this.dirty = true
  }

  /** Outlines a building's layers (or none), as picked. */
  select(building: PlacedBuilding | null) {
    if (this.selection) {
      this.scene.remove(this.selection)
      this.selection.geometry.dispose()
      this.selection = null
    }
    if (building) {
      const edges = new EdgesGeometry(this.unitBox)
      this.selection = new LineSegments(edges, new LineBasicMaterial({ color: 0xffffff, depthTest: false }))
      this.selection.renderOrder = 1
      const [x, y, z] = building.cell
      const [w, d] = building.area
      const h = this.heights[this.placed.indexOf(building)] ?? 1
      this.selection.position.set(x + w / 2, z + h / 2, y + d / 2)
      this.selection.scale.set(w + 0.04, h + 0.04, d + 0.04)
      this.scene.add(this.selection)
    }
    this.dirty = true
  }

  resetView() {
    this.camera.position.copy(this.home.position)
    this.controls.target.copy(this.home.target)
    this.controls.update()
    this.dirty = true
  }

  dispose() {
    // Models still loading have nowhere to go.
    this.shown++
    this.resize.disconnect()
    this.stopTextures()
    this.renderer.setAnimationLoop(null)
    this.select(null)
    this.clear()
    for (const m of [this.ghostWhole, this.ghostSliced, this.inside, this.boxMaterial, ...this.slicedMaterials.values()]) m.dispose()
    this.unitBox.dispose()
    this.scene.environment?.dispose()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  /**
   * The models, one batch per mesh and set of materials. Each instance is its piece's origin (its
   * building's, a layer up for each part of a lift below it) and turn, then its part's place.
   */
  private addModels(pieces: Piece[], models: { parts: Part[] | null; layers: number }[]) {
    const batches = new Map<string, { part: Part; instances: Instance[] }>()
    models.forEach(({ parts, layers }, at) => {
      if (!parts) return
      const piece = pieces[at]
      const b = this.placed[piece.building]
      const [x, y, z] = b.position
      const origin = new Matrix4()
        .makeTranslation(x, y, z + piece.layer * CELL)
        .multiply(new Matrix4().makeRotationZ((piece.rotation * Math.PI) / 2))
      const from = b.cell[2] + piece.layer
      for (const part of parts) {
        let batch = batches.get(part.key)
        if (!batch) batches.set(part.key, (batch = { part, instances: [] }))
        batch.instances.push({ matrix: origin.clone().multiply(part.matrix), building: piece.building, from, to: from + layers })
      }
    })
    for (const { part, instances } of batches.values()) {
      const batch = new Batch(part.geometry, part.materials, part.materials.map((m) => this.sliced(m)), this.ghostWhole, this.ghostSliced, this.inside, instances)
      this.world.add(...batch.meshes)
      this.batches.push(batch)
      batch.cut(this.cut)
    }
    this.dirty = true
  }

  /** Boxes over the cells of the buildings at `indices`, for those without models (yet). */
  private addBoxes(indices: number[]): Batch | null {
    if (!indices.length) return null
    const instances = indices.map((i): Instance => {
      const b = this.placed[i]
      const kind = buildingKind(b.name)
      return {
        matrix: new Matrix4().compose(...boxTransform(b, kind, this.heights[i])),
        building: i,
        from: b.cell[2],
        to: b.cell[2] + this.heights[i],
        color: new Color(buildingColor(b.name, kind)),
      }
    })
    const batch = new Batch(this.unitBox, [this.boxMaterial], [this.sliced(this.boxMaterial)], this.ghostWhole, this.ghostSliced, this.inside, instances)
    this.scene.add(...batch.meshes)
    this.batches.push(batch)
    batch.cut(this.cut)
    this.dirty = true
    return batch
  }

  /**
   * A material as sliced at the cut: a copy (sharing its textures) that the cut's plane clips, its
   * front faces only, as the back ones are the dark inside.
   */
  private sliced(material: Material): Material {
    let made = this.slicedMaterials.get(material)
    if (!made) {
      made = material.clone()
      made.clippingPlanes = [this.below]
      made.side = FrontSide
      this.slicedMaterials.set(material, made)
    }
    return made
  }

  private removeBatch(batch: Batch) {
    for (const mesh of batch.meshes) {
      mesh.removeFromParent()
      mesh.dispose()
    }
    this.batches = this.batches.filter((b) => b !== batch)
    this.dirty = true
  }

  /** Takes the blueprint out. Geometries, materials and textures stay: the models' are cached for the next. */
  private clear() {
    for (const batch of [...this.batches]) this.removeBatch(batch)
    this.placeholders = null
    if (this.floor) {
      this.scene.remove(this.floor)
      this.floor.geometry.dispose()
      ;(this.floor.material as Material).dispose()
      this.floor = null
    }
  }

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.host
    if (!w || !h) return
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.dirty = true
  }

  /** A click (a press that doesn't drag the view) picks what's under it, below the cut. */
  private listenForClicks() {
    const canvas = this.renderer.domElement
    const raycaster = new Raycaster()
    let down: Vector2 | null = null
    canvas.addEventListener('pointerdown', (e) => (down = new Vector2(e.clientX, e.clientY)))
    canvas.addEventListener('pointerup', (e) => {
      if (!down || down.distanceTo(new Vector2(e.clientX, e.clientY)) > 4) return
      down = null
      const rect = canvas.getBoundingClientRect()
      const pointer = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(pointer, this.camera)
      const sliced = new Set(this.batches.map((b) => b.slicedSolid))
      // Raycasting ignores clipping: on a sliced building, skip what the cut has taken away.
      const hit = raycaster
        .intersectObjects(this.batches.flatMap((b) => [b.whole, b.slicedSolid]), false)
        .find((h) => !sliced.has(h.object as InstancedMesh) || h.point.y < this.cut)
      const mesh = hit?.object as InstancedMesh | undefined
      const index = hit?.instanceId === undefined ? undefined : (mesh!.userData.buildings as number[])[hit.instanceId]
      this.onPick(index === undefined ? null : this.placed[index])
    })
  }
}

/** A building, or a part stacked on a lift (`layer` up from it), to draw with its models. */
interface Piece {
  building: number
  name: string
  variant: number | undefined
  rotation: PlacedBuilding['rotation']
  layer: number
}

/** One placed mesh: where it goes, whose it is, and the layers it fills (from up to, not including, to). */
interface Instance {
  matrix: Matrix4
  building: number
  from: number
  to: number
  color?: Color
}

/**
 * One mesh placed many times, sorted by the cut: whole where it fits below, sliced (solid below
 * the cut, dark inside, a ghost above) where it crosses it, a ghost where it's all above.
 */
class Batch {
  readonly whole: InstancedMesh
  readonly slicedSolid: InstancedMesh
  readonly meshes: InstancedMesh[]
  private aboveGhost: InstancedMesh
  private slicedOnes: InstancedMesh[]
  private instances: Instance[]

  constructor(
    geometry: BufferGeometry,
    solid: Material[],
    sliced: Material[],
    ghostWhole: Material,
    ghostSliced: Material,
    inside: Material,
    instances: Instance[],
  ) {
    const n = instances.length
    this.instances = instances
    this.whole = new InstancedMesh(geometry, solid.length === 1 ? solid[0] : solid, n)
    this.slicedSolid = new InstancedMesh(geometry, sliced.length === 1 ? sliced[0] : sliced, n)
    this.aboveGhost = new InstancedMesh(geometry, ghostWhole, n)
    this.slicedOnes = [this.slicedSolid, new InstancedMesh(geometry, inside, n), new InstancedMesh(geometry, ghostSliced, n)]
    this.meshes = [this.whole, this.aboveGhost, ...this.slicedOnes]
  }

  /** Sorts the instances for the bottom `layers` layers shown (Infinity: all). */
  cut(layers: number) {
    const sorted = new Map(this.meshes.map((m) => [m, [] as Instance[]]))
    for (const i of this.instances) {
      if (i.to <= layers) sorted.get(this.whole)!.push(i)
      else if (i.from >= layers) sorted.get(this.aboveGhost)!.push(i)
      else for (const mesh of this.slicedOnes) sorted.get(mesh)!.push(i)
    }
    for (const [mesh, list] of sorted) {
      list.forEach((i, at) => {
        mesh.setMatrixAt(at, i.matrix)
        if (i.color) mesh.setColorAt(at, i.color)
      })
      mesh.count = list.length
      mesh.visible = list.length > 0
      mesh.userData.buildings = list.map((i) => i.building)
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
    }
  }
}

/** Where a building's box goes: its layers, a hair smaller so neighbours stay apart, flatter for belts and pipes. */
function boxTransform(b: PlacedBuilding, kind: BuildingKind, layers: number): [Vector3, Quaternion, Vector3] {
  const [x, y, z] = b.cell
  const [w, d] = b.area
  const height = kind === 'belt' ? 0.14 : kind === 'pipe' ? 0.35 : layers
  const inset = kind === 'belt' ? 0.04 : 0.08
  const sx = w - inset
  const sz = d - inset
  const position = new Vector3(x + w / 2, z + (kind === 'pipe' ? 0.5 : height / 2), y + d / 2)
  const scale = new Vector3(
    kind === 'pipe' ? Math.min(sx, 0.35) : sx,
    height - (kind === 'belt' ? 0 : 0.04),
    kind === 'pipe' ? Math.min(sz, 0.35) : sz,
  )
  return [position, new Quaternion(), scale]
}
