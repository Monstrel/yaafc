import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  GridHelper,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshLambertMaterial,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Blueprint, PlacedBuilding } from '../../lib/blueprint/blueprintFile'
import { buildingKind, buildingColor, type BuildingKind } from './buildingKinds'

/** What the layers above the cut look like: gone, or a faint ghost to keep their place in view. */
export type Above = 'hidden' | 'ghost'

/**
 * A blueprint in 3D, one cell to a unit: the game's x and y run along three's x and z, and its
 * layers go up three's y. (Swapping two axes also turns Unreal's left-handed space right-handed,
 * so nothing is mirrored.) Each building is a box over the cells it covers until the game's own
 * models are in; scaffolding frames are outlines, so they don't hide what they hold.
 *
 * The cutaway is a horizontal clipping plane: solids keep what's below it, and ghosts (the same
 * boxes, faint) what's above, so a building taller than a layer is sliced where the cut runs.
 */
export class BlueprintScene {
  private renderer: WebGLRenderer
  private scene = new Scene()
  private camera = new PerspectiveCamera(40, 1, 0.1, 1000)
  private controls: OrbitControls
  private content: Object3D[] = []
  private solid: InstancedMesh | null = null
  private placed: PlacedBuilding[] = []
  private selection: LineSegments | null = null
  private below = new Plane(new Vector3(0, -1, 0), 0)
  private above = new Plane(new Vector3(0, 1, 0), 0)
  private ghostMaterials: { opacity: number; visible: boolean }[] = []
  private dirty = true
  private resize: ResizeObserver
  private home = { position: new Vector3(), target: new Vector3() }
  private cutHeight = Infinity

  /** Called with the building clicked, or null for a click on nothing. */
  onPick: (building: PlacedBuilding | null) => void = () => {}

  private host: HTMLElement

  constructor(host: HTMLElement) {
    this.host = host
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.localClippingEnabled = true
    host.appendChild(this.renderer.domElement)

    this.scene.add(new HemisphereLight(0xffffff, 0x554a60, 1.6))
    this.scene.add(new AmbientLight(0xffffff, 0.35))
    const sun = new DirectionalLight(0xffffff, 1.4)
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
    this.placed = blueprint.buildings
    const [w, d, h] = blueprint.size

    const floor = new GridHelper(Math.max(w, d) + 4, Math.max(w, d) + 4, 0x6d6478, 0x3c3645)
    floor.position.set(w / 2, 0, d / 2)
    this.add(floor)

    // Boxes for everything but frames, in one instanced mesh drawn twice: solid below the cut, ghost above.
    const boxes = this.placed.map((b, i) => ({ b, i, kind: buildingKind(b.name) })).filter((x) => x.kind !== 'frame')
    const geometry = new BoxGeometry(1, 1, 1)
    const solidMaterial = new MeshLambertMaterial({ side: DoubleSide, clippingPlanes: [this.below] })
    const ghostMaterial = new MeshLambertMaterial({
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      clippingPlanes: [this.above],
    })
    this.ghostMaterials.push(ghostMaterial)
    const solid = new InstancedMesh(geometry, solidMaterial, boxes.length)
    const ghost = new InstancedMesh(geometry, ghostMaterial, boxes.length)
    const m = new Matrix4()
    const color = new Color()
    boxes.forEach(({ b, kind }, at) => {
      m.compose(...boxTransform(b, kind))
      solid.setMatrixAt(at, m)
      ghost.setMatrixAt(at, m)
      color.set(buildingColor(b.name, kind))
      solid.setColorAt(at, color)
      ghost.setColorAt(at, color)
    })
    solid.userData.buildings = boxes.map((x) => x.i)
    this.solid = solid
    this.add(solid, ghost)

    // Frames as outlines: the twelve edges of each, in one set of line segments per pass.
    const frames = this.placed.filter((b) => buildingKind(b.name) === 'frame')
    if (frames.length) {
      const edges = frameEdges(frames)
      const solidLines = new LineBasicMaterial({ color: 0x9a90a8, clippingPlanes: [this.below] })
      const ghostLines = new LineBasicMaterial({
        color: 0x9a90a8,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        clippingPlanes: [this.above],
      })
      this.ghostMaterials.push(ghostLines)
      this.add(new LineSegments(edges, solidLines), new LineSegments(edges, ghostLines))
    }

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
  }

  /** Shows the layers below `layers` (all of them for Infinity); the rest are hidden or ghosts. */
  setCut(layers: number, above: Above) {
    // Just under the layer line, so a building's top face isn't cut where it touches the next layer.
    this.cutHeight = layers - 0.001
    this.below.constant = this.cutHeight
    this.above.constant = -this.cutHeight
    for (const material of this.ghostMaterials) material.visible = above === 'ghost'
    this.dirty = true
  }

  /** Outlines a building (or none), as picked. */
  select(building: PlacedBuilding | null) {
    if (this.selection) {
      this.scene.remove(this.selection)
      this.selection.geometry.dispose()
      this.selection = null
    }
    if (building) {
      const edges = new EdgesGeometry(new BoxGeometry(1, 1, 1))
      this.selection = new LineSegments(edges, new LineBasicMaterial({ color: 0xffffff, depthTest: false }))
      this.selection.renderOrder = 1
      const [position, , scale] = boxTransform(building, buildingKind(building.name))
      this.selection.position.copy(position)
      this.selection.scale.copy(scale).multiplyScalar(1.04)
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
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private add(...objects: Object3D[]) {
    for (const o of objects) {
      this.scene.add(o)
      this.content.push(o)
    }
    this.dirty = true
  }

  private clear() {
    for (const o of this.content) {
      this.scene.remove(o)
      o.traverse((x) => {
        const disposable = x as Partial<InstancedMesh>
        disposable.geometry?.dispose()
        const material = disposable.material
        for (const mat of Array.isArray(material) ? material : material ? [material] : []) mat.dispose()
      })
    }
    this.content = []
    this.ghostMaterials = []
    this.solid = null
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
      if (!down || down.distanceTo(new Vector2(e.clientX, e.clientY)) > 4 || !this.solid) return
      down = null
      const rect = canvas.getBoundingClientRect()
      const pointer = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(pointer, this.camera)
      // Raycasting ignores clipping: skip what the cut has taken away.
      const hit = raycaster.intersectObject(this.solid).find((h) => h.point.y <= this.cutHeight + 0.01)
      const index = hit?.instanceId === undefined ? undefined : (this.solid.userData.buildings as number[])[hit.instanceId]
      this.onPick(index === undefined ? null : this.placed[index])
    })
  }
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
  const scale = new Vector3(kind === 'pipe' ? Math.min(sx, 0.35) : sx, height - (kind === 'belt' ? 0 : 0.04), kind === 'pipe' ? Math.min(sz, 0.35) : sz)
  return [position, new Quaternion(), scale]
}

/** The edges of each frame's cells, as one geometry. */
function frameEdges(frames: PlacedBuilding[]): BufferGeometry {
  const unit = new EdgesGeometry(new BoxGeometry(1, 1, 1)).getAttribute('position')
  const points: number[] = []
  for (const f of frames) {
    const [x, y, z] = f.cell
    const [w, d] = f.area
    // A hair under its layers, as the boxes are, so a cut on the layer line keeps its top edges.
    const h = (f.name.endsWith('Duo') ? 2 : 1) - 0.04
    for (let i = 0; i < unit.count; i++)
      points.push(x + w / 2 + unit.getX(i) * w, z + h / 2 + unit.getY(i) * h, y + d / 2 + unit.getZ(i) * d)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3))
  return geometry
}
