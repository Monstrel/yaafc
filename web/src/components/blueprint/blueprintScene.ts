import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  GridHelper,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
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
  type Material,
  type Object3D,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { CELL, type Blueprint, type PlacedBuilding } from '../../lib/blueprint/blueprintFile'
import { buildingColor, buildingKind, type BuildingKind } from './buildingKinds'
import { buildingParts, type Part } from './models'

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
 * is a box over its cells. The cutaway is a horizontal clipping plane: solids keep what's below
 * it, and ghosts (the same shapes, faint) what's above, so a building taller than a layer is
 * sliced where the cut runs.
 */
export class BlueprintScene {
  private host: HTMLElement
  private renderer: WebGLRenderer
  private scene = new Scene()
  private camera = new PerspectiveCamera(40, 1, 0.1, 1000)
  private controls: OrbitControls
  private content: Object3D[] = []
  /** The meshes a click can pick, each with the building behind each of its instances. */
  private pickable: InstancedMesh[] = []
  private placed: PlacedBuilding[] = []
  private selection: LineSegments | null = null
  private below = new Plane(new Vector3(0, -1, 0), 0)
  private above = new Plane(new Vector3(0, 1, 0), 0)
  private ghost = new MeshLambertMaterial({
    color: 0xb8b0c4,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    clippingPlanes: [this.above],
  })
  private boxMaterial = new MeshLambertMaterial({ side: DoubleSide, clippingPlanes: [this.below] })
  private unitBox = new BoxGeometry(1, 1, 1)
  private dirty = true
  private resize: ResizeObserver
  private home = { position: new Vector3(), target: new Vector3() }
  private cutHeight = Infinity
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

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.screenSpacePanning = true
    this.controls.addEventListener('change', () => (this.dirty = true))

    this.resize = new ResizeObserver(() => this.fit())
    this.resize.observe(host)
    this.listenForClicks()
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
    const [w, d, h] = blueprint.size

    const floor = new GridHelper(Math.max(w, d) + 4, Math.max(w, d) + 4, 0x6d6478, 0x3c3645)
    floor.position.set(w / 2, 0, d / 2)
    this.add(floor)
    const boxes = this.addBoxes(this.placed.map((_, i) => i))

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

    this.onModels({ state: 'loading' })
    Promise.all(this.placed.map((b) => buildingParts(b.name, b.variant))).then(
      (parts) => {
        if (shown !== this.shown) return
        this.remove(boxes)
        this.addModels(parts)
        const missing = this.placed.flatMap((_, i) => (parts[i] ? [] : [i]))
        if (missing.length) this.addBoxes(missing)
        this.onModels({ state: 'ready', missing: [...new Set(missing.map((i) => this.placed[i].name))] })
      },
      (e: unknown) => {
        if (shown === this.shown) this.onModels({ state: 'failed', message: (e as Error).message })
      },
    )
  }

  /** Shows the layers below `layers` (all of them for Infinity); the rest are hidden or ghosts. */
  setCut(layers: number, above: Above) {
    // Just under the layer line, so a building's top isn't cut where it meets the next layer.
    this.cutHeight = layers - 0.001
    this.below.constant = this.cutHeight
    this.above.constant = -this.cutHeight
    this.ghost.visible = above === 'ghost'
    this.dirty = true
  }

  /** Outlines a building's cells (or none), as picked. */
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
      this.selection.position.set(x + w / 2, z + 0.5, y + d / 2)
      this.selection.scale.set(w + 0.04, 1.04, d + 0.04)
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
    this.resize.disconnect()
    this.renderer.setAnimationLoop(null)
    this.select(null)
    this.clear()
    this.ghost.dispose()
    this.boxMaterial.dispose()
    this.unitBox.dispose()
    this.scene.environment?.dispose()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  /**
   * The models, one instanced mesh per mesh and set of materials, drawn twice: solid below the
   * cut, ghost above. Each instance is its building's origin and turn, then its part's place.
   */
  private addModels(parts: (Part[] | null)[]) {
    // Unreal's space to the scene's: x stays, y and z swap, and 25 units make a cell.
    const world = new Group()
    world.matrixAutoUpdate = false
    world.matrix.set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1).multiply(new Matrix4().makeScale(1 / CELL, 1 / CELL, 1 / CELL))
    world.matrixWorldNeedsUpdate = true

    const batches = new Map<string, { part: Part; matrices: Matrix4[]; buildings: number[] }>()
    parts.forEach((list, i) => {
      if (!list) return
      const b = this.placed[i]
      const origin = new Matrix4()
        .makeTranslation(...b.position)
        .multiply(new Matrix4().makeRotationZ((b.rotation * Math.PI) / 2))
      for (const part of list) {
        let batch = batches.get(part.key)
        if (!batch) batches.set(part.key, (batch = { part, matrices: [], buildings: [] }))
        batch.matrices.push(origin.clone().multiply(part.matrix))
        batch.buildings.push(i)
      }
    })
    for (const { part, matrices, buildings } of batches.values()) {
      const solid = new InstancedMesh(part.geometry, part.materials.map(clipped(this.below)), matrices.length)
      const ghost = new InstancedMesh(part.geometry, this.ghost, matrices.length)
      matrices.forEach((m, at) => {
        solid.setMatrixAt(at, m)
        ghost.setMatrixAt(at, m)
      })
      solid.userData.buildings = buildings
      solid.computeBoundingSphere()
      ghost.computeBoundingSphere()
      this.pickable.push(solid)
      world.add(solid, ghost)
    }
    this.add(world)
  }

  /** Boxes over the cells of the buildings at `indices`, for those without models (yet). */
  private addBoxes(indices: number[]): Object3D[] {
    if (!indices.length) return []
    const solid = new InstancedMesh(this.unitBox, this.boxMaterial, indices.length)
    const ghost = new InstancedMesh(this.unitBox, this.ghost, indices.length)
    const m = new Matrix4()
    const color = new Color()
    indices.forEach((i, at) => {
      const b = this.placed[i]
      const kind = buildingKind(b.name)
      m.compose(...boxTransform(b, kind))
      solid.setMatrixAt(at, m)
      ghost.setMatrixAt(at, m)
      solid.setColorAt(at, color.set(buildingColor(b.name, kind)))
    })
    solid.userData.buildings = indices
    this.pickable.push(solid)
    this.add(solid, ghost)
    return [solid, ghost]
  }

  private add(...objects: Object3D[]) {
    for (const o of objects) {
      this.scene.add(o)
      this.content.push(o)
    }
    this.dirty = true
  }

  /**
   * Takes objects out of the scene. Geometries, materials and textures stay: the models' are
   * cached for the next blueprint, and the boxes' and ghosts' belong to the scene.
   */
  private remove(objects: Object3D[]) {
    for (const o of objects) {
      this.scene.remove(o)
      o.traverse((x) => {
        if (x instanceof InstancedMesh) x.dispose()
        if (x instanceof GridHelper) {
          x.geometry.dispose()
          ;(x.material as Material).dispose()
        }
      })
    }
    const gone = new Set(objects)
    this.content = this.content.filter((o) => !gone.has(o))
    this.pickable = this.pickable.filter((m) => !gone.has(m) && !objects.some((o) => o !== m && isInside(m, o)))
    this.dirty = true
  }

  private clear() {
    this.remove([...this.content])
    this.pickable = []
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
      // Raycasting ignores clipping: skip what the cut has taken away, down to the underside of a
      // building that sits on the cut line.
      const hit = raycaster.intersectObjects(this.pickable, false).find((h) => h.point.y < this.cutHeight)
      const mesh = hit?.object as InstancedMesh | undefined
      const index = hit?.instanceId === undefined ? undefined : (mesh!.userData.buildings as number[])[hit.instanceId]
      this.onPick(index === undefined ? null : this.placed[index])
    })
  }
}

/** The models' own materials, sharing the scene's clipping plane (cached ones are set once). */
const clipped = (plane: Plane) => (material: Material) => {
  material.clippingPlanes = [plane]
  return material
}

function isInside(child: Object3D, parent: Object3D): boolean {
  for (let o = child.parent; o; o = o.parent) if (o === parent) return true
  return false
}

/** Where a building's box goes: its cells, a hair smaller so neighbours stay apart, flatter for belts and pipes. */
function boxTransform(b: PlacedBuilding, kind: BuildingKind): [Vector3, Quaternion, Vector3] {
  const [x, y, z] = b.cell
  const [w, d] = b.area
  const height = kind === 'belt' ? 0.14 : kind === 'pipe' ? 0.35 : 1
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
