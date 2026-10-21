import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomToneMapping,
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
  PerspectiveCamera,
  Plane,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  Scene,
  ShaderChunk,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { CELL, layersOf, type Blueprint, type PlacedBuilding } from '../../lib/blueprint/blueprintFile'
import { buildingColor, buildingKind, isBuildingBlock, type BuildingKind } from './buildingKinds'
import { buildingModel, onTextureLoad, type Flow, type Part, type Side } from './models'

/**
 * The game's look: its colour grade and Unreal's filmic tone curve, with the settings of its
 * post-process volume (Main2_sub_lighting's PostProcessVolume_0), all in ACEScg (AP1) as Unreal does.
 *
 * The grade cools the picture: its gain takes red down and blue up, more so in the midtones, so greys
 * come out blue-grey. Saturation, then gain, the midtones' (times the global) weighed in by luminance
 * between Unreal's default shadow and highlight ranges. Its contrast is left out: the midtones' (more
 * in green, less in blue) tints whites green here.
 *
 * The curve is Unreal's FilmToneMap with the game's shoulder, 1 (Unreal's default is 0.26): a hard
 * one, and it works on each channel, so bright colours wash out towards white. That's why the game's
 * wood is a pale tan, though its textures are a strong yellowish brown; three's neutral curve keeps
 * their colour, and they look yellow beside the game.
 */
ShaderChunk.tonemapping_pars_fragment = ShaderChunk.tonemapping_pars_fragment.replace(
  'vec3 CustomToneMapping( vec3 color ) { return color; }',
  /* glsl */ `
vec3 CustomToneMapping( vec3 color ) {
	// Linear sRGB to ACEScg and back: Unreal's sRGB_2_AP1 and AP1_2_sRGB, by rows (as color * m reads them).
	const mat3 toAP1 = mat3( 0.6131, 0.3395, 0.0474, 0.0702, 0.9164, 0.0134, 0.0206, 0.1096, 0.8698 );
	const mat3 fromAP1 = mat3( 1.7049, -0.6217, -0.0833, -0.1301, 1.1407, -0.0106, -0.0240, -0.1290, 1.1530 );
	const vec3 toY = vec3( 0.2722, 0.6741, 0.0537 );
	color = color * toneMappingExposure * toAP1;

	float luma = dot( color, toY );
	float midtones = smoothstep( 0.0, 0.09, luma ) - smoothstep( 0.5, 1.0, luma );
	color = max( vec3( 0.0 ), mix( vec3( luma ), color, 1.15 ) );
	color *= mix( vec3( 0.95, 1.01, 1.05 ), vec3( 0.95, 0.98, 1.1235 ), midtones );

	const float slope = 0.88, toe = 0.55, shoulder = 1.0, blackClip = 0.0, whiteClip = 0.04;
	const float toeScale = 1.0 + blackClip - toe, shoulderScale = 1.0 + whiteClip - shoulder;
	const float bt = 0.18 / toeScale - 1.0;
	float toeMatch = log( 0.18 ) / log( 10.0 ) - 0.5 * log( ( 1.0 + bt ) / ( 1.0 - bt ) ) * toeScale / slope;
	float straightMatch = ( 1.0 - toe ) / slope - toeMatch;
	float shoulderMatch = shoulder / slope - straightMatch;
	color = mix( vec3( dot( color, toY ) ), color, 0.96 );
	vec3 logColor = log( max( color, vec3( 1e-10 ) ) ) / log( 10.0 );
	vec3 straight = slope * ( logColor + straightMatch );
	vec3 toeColor = - blackClip + 2.0 * toeScale / ( 1.0 + exp( - 2.0 * slope / toeScale * ( logColor - toeMatch ) ) );
	vec3 shoulderColor = 1.0 + whiteClip - 2.0 * shoulderScale / ( 1.0 + exp( 2.0 * slope / shoulderScale * ( logColor - shoulderMatch ) ) );
	toeColor = mix( straight, toeColor, step( logColor, vec3( toeMatch ) ) );
	shoulderColor = mix( straight, shoulderColor, step( vec3( shoulderMatch ), logColor ) );
	vec3 t = clamp( ( logColor - toeMatch ) / ( shoulderMatch - toeMatch ), 0.0, 1.0 );
	t = ( 3.0 - 2.0 * t ) * t * t;
	color = mix( toeColor, shoulderColor, t );
	color = mix( vec3( dot( color, toY ) ), color, 0.93 );

	return clamp( max( color, vec3( 0.0 ) ) * fromAP1, 0.0, 1.0 );
}`,
)

/**
 * What hidden buildings look like, those above the cut and the building blocks when hidden: a faint
 * ghost to keep their place in view, or gone.
 */
export type HiddenLook = 'ghost' | 'gone'
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
  /** The belts' direction arrows, in the game's space: a part of `batches` a click doesn't pick. */
  private arrows = new Group()
  private arrowBatches = new Set<Batch>()
  private arrowMaterial = new MeshBasicMaterial({ color: 0xffc845, side: DoubleSide })
  private arrowGeometries = new Map<string, BufferGeometry>()
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
  private hideBlocks = false
  /** The buildings drawn as if above the cut, wherever they are: the building blocks, when hidden. */
  private gone = new Set<number>()
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
    this.renderer.toneMapping = CustomToneMapping
    // Bright, as the game is: its tone curve washes the brightest colours out towards white.
    this.renderer.toneMappingExposure = 2.75
    host.appendChild(this.renderer.domElement)
    this.ghostSliced.clippingPlanes = [this.above]
    this.inside.clippingPlanes = [this.below]
    // Flat colours of the X-ray's own, kept as they are.
    this.arrowMaterial.toneMapped = false
    this.inside.toneMapped = false

    // A soft room's light for the models' metal and gloss, a sun for shape, and a blue sky's light
    // filling the shade, as in the game by day: without it, the shade's wood comes out yellow.
    const pmrem = new PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.35
    pmrem.dispose()
    // From below, the game's sky light's lower hemisphere: a cool grey.
    this.scene.add(new HemisphereLight(0x80a8ff, 0x6d757c, 0.8))
    this.scene.add(new AmbientLight(0x80a8ff, 0.2))
    // The game's sun, a warm white.
    const sun = new DirectionalLight(0xede4d0, 2.3)
    sun.position.set(0.6, 1, 0.35)
    this.scene.add(sun)

    // Unreal's space to the scene's: x stays, y and z swap, and 25 units make a cell.
    this.world.matrixAutoUpdate = false
    this.world.matrix.set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1).multiply(new Matrix4().makeScale(1 / CELL, 1 / CELL, 1 / CELL))
    this.world.matrixWorldNeedsUpdate = true
    this.scene.add(this.world)
    this.world.add(this.arrows)

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
    this.gone = this.blocksGone()
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
        this.addArrows(pieces, models)
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

  /** Shows the bottom `layers` layers (null: all of them); the rest look as `look` says. */
  setCut(layers: number | null, look: HiddenLook) {
    this.cut = layers ?? Infinity
    // Far above everything rather than Infinity, which shaders needn't take.
    const plane = Math.min(this.cut, 1e6)
    this.below.constant = plane
    this.above.constant = -plane
    this.ghostWhole.visible = this.ghostSliced.visible = look === 'ghost'
    for (const batch of this.batches) batch.cut(this.cut, this.gone)
    this.dirty = true
  }

  /** Hides the building blocks (or shows them again): ghosts or gone, as hidden buildings look. */
  setBlocks(hidden: boolean) {
    this.hideBlocks = hidden
    this.gone = this.blocksGone()
    for (const batch of this.batches) batch.cut(this.cut, this.gone)
    this.dirty = true
  }

  /** Shows or hides the arrows on belts that point the way items go. */
  setArrows(shown: boolean) {
    this.arrows.visible = shown
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
    for (const m of [this.ghostWhole, this.ghostSliced, this.inside, this.boxMaterial, this.arrowMaterial, ...this.slicedMaterials.values()]) m.dispose()
    for (const g of [this.unitBox, ...this.arrowGeometries.values()]) g.dispose()
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
      const tint = b.color && new Color().setRGB(...(b.color.map((c) => c / 255) as [number, number, number]), SRGBColorSpace)
      for (const part of parts) {
        let batch = batches.get(part.key)
        if (!batch) batches.set(part.key, (batch = { part, instances: [] }))
        batch.instances.push({ matrix: origin.clone().multiply(part.matrix), building: piece.building, from, to: from + layers, tint })
      }
    })
    for (const { part, instances } of batches.values()) {
      const batch = new Batch(part.geometry, part.materials, part.materials.map((m) => this.sliced(m)), this.ghostWhole, this.ghostSliced, this.inside, instances)
      this.world.add(...batch.meshes)
      this.batches.push(batch)
      batch.cut(this.cut, this.gone)
    }
    this.dirty = true
  }

  /**
   * An arrow on each belt and ramp, flat on its surface, the way items go: from each side they
   * come in by to the middle, and from the middle out to each side they leave by, with a head.
   */
  private addArrows(pieces: Piece[], models: { flow?: Flow; layers: number }[]) {
    const instances = new Map<string, Instance[]>()
    const place = (geometry: string, matrix: Matrix4, piece: Piece, layers: number) => {
      const from = this.placed[piece.building].cell[2] + piece.layer
      const list = instances.get(geometry) ?? []
      list.push({ matrix, building: piece.building, from, to: from + layers })
      instances.set(geometry, list)
    }
    models.forEach(({ flow, layers }, at) => {
      if (!flow) return
      const piece = pieces[at]
      const [x, y, z] = this.placed[piece.building].position
      const origin = new Matrix4()
        .makeTranslation(x, y, z + piece.layer * CELL)
        .multiply(new Matrix4().makeRotationZ((piece.rotation * Math.PI) / 2))
      // Flat at a height, turned to a side.
      const toSide = (s: Side, height: number) =>
        origin.clone().multiply(new Matrix4().makeTranslation(0, 0, height)).multiply(new Matrix4().makeRotationZ(SIDE_TURNS[s]))
      // Along a line from a point, its face to `normal` (or, unless given, as near up as it can be).
      const along = (from: Vector3, direction: Vector3, normal?: Vector3) => {
        const x = direction.clone().normalize()
        const z = normal ?? x.clone().cross(new Vector3(0, 0, 1).cross(x).normalize())
        return origin.clone().multiply(new Matrix4().makeBasis(x, z.clone().cross(x), z).setPosition(from))
      }
      if (flow.kind === 'flat') {
        // Just over the belt's top.
        for (const s of flow.ins) place('in', toSide(s, ARROW_LIFT), piece, layers)
        for (const s of flow.outs) place('out', toSide(s, ARROW_LIFT), piece, layers)
      } else if (flow.kind === 'path') {
        // From the edge items come in by to the edge they leave by, over its deck, or its roof.
        const lift = flow.roof === undefined ? ARROW_LIFT : flow.roof + 0.8
        for (const { from, to } of flow.paths) {
          const start = new Vector3(from[0], from[1], from[2] + lift)
          const run = new Vector3(...to).sub(new Vector3(...from))
          place(`line ${run.length().toFixed(1)}`, along(start, run), piece, layers)
        }
      } else {
        // Up or down each side of the lift's bottom and top ends, and across its top's lid.
        const vertical = new Vector3(0, 0, flow.up ? 1 : -1)
        for (const s of Object.keys(SIDE_TURNS) as Side[]) {
          const face = new Vector3(Math.cos(SIDE_TURNS[s]), Math.sin(SIDE_TURNS[s]), 0)
          const start = face.clone().multiplyScalar(LIFT_FACE).setZ(flow.up ? LIFT_ARROW_FROM : CELL - LIFT_ARROW_FROM)
          place(`line ${LIFT_ARROW}`, along(start, vertical, face), piece, layers)
        }
        if (flow.top?.out) place('out', toSide(flow.top.side, CELL + 0.6), piece, layers)
        else if (flow.top) {
          // From the side items come in by to the middle, where they drop.
          const turn = SIDE_TURNS[flow.top.side]
          const edge = new Vector3(Math.cos(turn), Math.sin(turn), 0).multiplyScalar(CELL / 2)
          place(`line ${(CELL / 2).toFixed(1)}`, along(edge.clone().setZ(CELL + 0.6), edge.clone().negate()), piece, layers)
        }
      }
    })
    for (const [key, list] of instances) {
      const material = [this.arrowMaterial]
      const batch = new Batch(this.arrowGeometry(key), material, material.map((m) => this.sliced(m)), this.ghostWhole, this.ghostSliced, this.inside, list)
      this.arrows.add(...batch.meshes)
      this.batches.push(batch)
      this.arrowBatches.add(batch)
      batch.cut(this.cut, this.gone)
    }
    this.dirty = true
  }

  /**
   * An arrow's shape, flat, pointing along +x, in the game's units: "in", a bar from the middle of
   * a cell to its side; "out", a bar and head from the middle to near the side; "line <length>", a
   * bar and head that long.
   */
  private arrowGeometry(key: string): BufferGeometry {
    let made = this.arrowGeometries.get(key)
    if (!made) {
      const half = ARROW_WIDTH / 2
      // Bars start a half-width behind the middle, so they meet without a notch at a turn.
      const bar = (from: number, to: number) => [from, -half, to, -half, to, half, from, -half, to, half, from, half]
      const head = (at: number) => [at, -ARROW_HEAD, at + ARROW_HEAD * 1.3, 0, at, ARROW_HEAD]
      const length = key === 'in' ? CELL / 2 : key === 'out' ? CELL / 2 - 1 : Number(key.split(' ')[1])
      const tip = length - ARROW_HEAD * 1.3
      const flat = key === 'in' ? bar(-half, length) : key === 'out' ? [...bar(-half, tip), ...head(tip)] : [...bar(0, tip), ...head(tip)]
      const points = new Float32Array(flat.length / 2 * 3)
      for (let i = 0; i < flat.length / 2; i++) points.set([flat[i * 2], flat[i * 2 + 1], 0], i * 3)
      made = new BufferGeometry().setAttribute('position', new BufferAttribute(points, 3))
      this.arrowGeometries.set(key, made)
    }
    return made
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
    batch.cut(this.cut, this.gone)
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
      // Cloning leaves out how the models' shader takes a building's tint.
      made.onBeforeCompile = material.onBeforeCompile
      made.clippingPlanes = [this.below]
      made.side = FrontSide
      this.slicedMaterials.set(material, made)
    }
    return made
  }

  private blocksGone(): Set<number> {
    return new Set(this.hideBlocks ? this.placed.flatMap((b, i) => (isBuildingBlock(b.name) ? [i] : [])) : [])
  }

  private removeBatch(batch: Batch) {
    for (const mesh of batch.meshes) {
      mesh.removeFromParent()
      mesh.dispose()
    }
    this.batches = this.batches.filter((b) => b !== batch)
    this.arrowBatches.delete(batch)
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
        .intersectObjects(this.batches.filter((b) => !this.arrowBatches.has(b)).flatMap((b) => [b.whole, b.slicedSolid]), false)
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
  /** The colour its building is tinted, for its solid meshes only (not its ghost). */
  tint?: Color
}

const UNTINTED = new Color(1, 1, 1)

/**
 * One mesh placed many times, sorted by the cut: whole where it fits below, sliced (solid below
 * the cut, dark inside, a ghost above) where it crosses it, a ghost where it's all above (or
 * its building is hidden).
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

  /** Sorts the instances for the bottom `layers` layers shown (Infinity: all), those of the `gone` buildings as if above. */
  cut(layers: number, gone: Set<number>) {
    const sorted = new Map(this.meshes.map((m) => [m, [] as Instance[]]))
    for (const i of this.instances) {
      if (gone.has(i.building)) sorted.get(this.aboveGhost)!.push(i)
      else if (i.to <= layers) sorted.get(this.whole)!.push(i)
      else if (i.from >= layers) sorted.get(this.aboveGhost)!.push(i)
      else for (const mesh of this.slicedOnes) sorted.get(mesh)!.push(i)
    }
    const tinted = this.instances.some((i) => i.tint)
    for (const [mesh, list] of sorted) {
      const solid = tinted && (mesh === this.whole || mesh === this.slicedSolid)
      list.forEach((i, at) => {
        mesh.setMatrixAt(at, i.matrix)
        if (i.color) mesh.setColorAt(at, i.color)
        else if (solid) mesh.setColorAt(at, i.tint ?? UNTINTED)
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
/** The arrows' width, their heads' half-width, and how far over a belt's origin they lie, in the game's units. */
const ARROW_WIDTH = 3.5
const ARROW_HEAD = 4.5
const ARROW_LIFT = 6.2
/** A lift's arrows: their length, how far up a side they start, and how far out of its middle they lie. */
const LIFT_ARROW = 16
const LIFT_ARROW_FROM = 4.5
const LIFT_FACE = 13.6
/** Each side of a building's cell, as a turn from +x (right). */
const SIDE_TURNS: Record<Side, number> = { r: 0, b: Math.PI / 2, l: Math.PI, u: -Math.PI / 2 }

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
