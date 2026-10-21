import { MeshoptDecoder } from 'meshoptimizer/decoder'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  LinearSRGBColorSpace,
  Matrix4,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  type Material,
  type Texture,
} from 'three'

/**
 * The buildings' models as the extractor writes them (`dotnet run -- models`, see
 * tools/extractor/Models.cs): a manifest, and the meshes and textures it names, fetched as a
 * blueprint needs them and kept for the next.
 */

interface Manifest {
  /** `shapes`: the table of shapes it takes as it joins its neighbours, for a belt or a pipe. */
  /** `layers`: its height, in whole layers; `ports` and `top`, for a ramp, drawbridge, tunnel or lift. */
  buildings: Record<string, { name: string; parts: ManifestPart[]; layers: number; shapes?: string; ports?: Port[]; top?: number }>
  /** By SecondaryType (Belt, Pipeline), then by a placed one's BaseActiveIndex. */
  shapes: Record<string, Record<string, ManifestPart & { sides?: string }>>
  meshes: Record<string, { materials: (string | null)[] }>
  materials: Record<string, ManifestMaterial>
}

/** Where items go through a building: see Models.cs. */
export interface Port {
  at: Point
  in: string
  out: string
  offset: Point
}

interface ManifestPart {
  mesh: string
  /** From the building's origin, in Unreal's space; read as three.js's column-major array. */
  matrix?: number[]
  /** Per material slot, the building's own material in place of the mesh's (null: the mesh's). */
  materials?: (string | null)[]
}

interface ManifestMaterial {
  color?: string
  normal?: string
  orm?: string
  tint?: [number, number, number]
  /** Where the building takes the colour the player tints it (white), for a storage box. */
  mask?: string
  masked?: boolean
  translucent?: boolean
}

/** A mesh placed in a building: its geometry, the material for each of its sections, and where it goes. */
export interface Part {
  key: string
  geometry: BufferGeometry
  materials: Material[]
  matrix: Matrix4
}

// Next to the pages: every page's address is one level under the site's.
const base = () => new URL('models/', document.baseURI)
let manifest: Promise<Manifest> | undefined
const geometries = new Map<string, Promise<BufferGeometry>>()
const materials = new Map<string, Material>()
const textures = new Map<string, Texture>()
const loader = new TextureLoader()
/** Told each time a texture has downloaded, so a scene that draws only on change draws again. */
const textureListeners = new Set<() => void>()

/** Calls `listener` whenever a texture finishes loading; returns a function that stops it. */
export function onTextureLoad(listener: () => void): () => void {
  textureListeners.add(listener)
  return () => textureListeners.delete(listener)
}

function loadManifest(): Promise<Manifest> {
  return (manifest ??= fetch(new URL('manifest.json', base())).then((r) => {
    if (!r.ok) throw new Error(`The models couldn’t be loaded (${r.status})`)
    return r.json() as Promise<Manifest>
  }))
}

/** Each building table row's name in the game and height in layers, by its row name in lower case. */
export async function buildingInfo(): Promise<Map<string, { name: string; layers: number }>> {
  const m = await loadManifest()
  return new Map(Object.entries(m.buildings).map(([key, b]) => [key.toLowerCase(), { name: b.name, layers: b.layers }]))
}

/**
 * The meshes a building is made of, from its origin (for a belt or a pipe, the shape `variant`
 * names), and its height in layers. No parts for a building the game draws without static meshes,
 * which the X-ray shows as a box.
 */
export async function buildingModel(
  name: string,
  variant: number | undefined,
): Promise<{ parts: Part[] | null; layers: number; flow?: Flow }> {
  const m = await loadManifest()
  // Rows are matched without case: the game saves its Catapult row's buildings as "catapult".
  const building = m.buildings[name] ?? Object.entries(m.buildings).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  if (!building) return { parts: null, layers: 1 }
  return { parts: await buildingParts(m, building, variant), layers: building.layers, flow: flowOf(m, name, variant) }
}

/** The sides of a building's cell, before its turn: right (+x), bottom (+y), left (−x), up (−y). */
export type Side = 'r' | 'b' | 'l' | 'u'

/** A point from a building's origin, before its turn, in the game's units. */
export type Point = [number, number, number]

/**
 * Which way items go through a building, for the X-ray's arrows:
 * - `flat`, a belt: in from some sides of its cell, out to others;
 * - `path`, a ramp, drawbridge or tunnel: along each path, from the edge of the cell items come in
 *   at to the edge of the one they leave from, on its deck (`roof`: over it, as a tunnel's is hidden);
 * - `lift`, the bottom or top end of a conveyor lift, `up` or down, and for its top end the side of
 *   it items leave by (going up) or come in by (going down).
 */
export type Flow =
  | { kind: 'flat'; ins: Side[]; outs: Side[] }
  | { kind: 'path'; paths: { from: Point; to: Point }[]; roof?: number }
  | { kind: 'lift'; up: boolean; top?: { side: Side; out: boolean } }

/** Each side, as a step to the next cell. */
const SIDE_STEPS: Record<Side, Point> = { r: [1, 0, 0], b: [0, 1, 0], l: [-1, 0, 0], u: [0, -1, 0] }

function flowOf(m: Manifest, name: string, variant: number | undefined): Flow | undefined {
  if (name === 'Belt') {
    const belts = m.shapes.Belt
    const sides = variant === undefined ? undefined : belts[beltShape(variant, (k) => k in belts)]?.sides
    return sides ? { kind: 'flat', ...beltSides(sides) } : undefined
  }
  const building = m.buildings[name]
  return building?.ports ? portFlow(name, building.ports, building.top ?? 0) : undefined
}

/** A ramp's, drawbridge's, tunnel's or lift's flow, from its ports (see Models.cs). */
export function portFlow(name: string, ports: Port[], top: number): Flow | undefined {
  if (name.startsWith('ConveyerLift_')) {
    const up = name.includes('Upwards')
    const port = ports[0]
    const side = (port?.out || port?.in) as Side | undefined
    return { kind: 'lift', up, top: name.includes('_End') && side ? { side, out: Boolean(port.out) } : undefined }
  }
  const half = 12.5
  const edge = (cell: Point, side: Side): Point => cell.map((c, i) => c * 25 + SIDE_STEPS[side][i] * half) as Point
  const paths = ports
    .filter((p) => p.in && p.out)
    .map((p) => ({
      from: edge(p.at, p.in[0] as Side),
      to: edge(p.at.map((c, i) => c + p.offset[i]) as Point, p.out[0] as Side),
    }))
  if (!paths.length) return undefined
  return { kind: 'path', paths, roof: /tunnel/i.test(name) ? top : undefined }
}

/** A belt shape's sides from its row's Desc: "bliro" is in from the bottom and left, out to the right. */
export function beltSides(desc: string): { ins: Side[]; outs: Side[] } {
  const ins: Side[] = []
  const outs: Side[] = []
  for (const [, sides, way] of desc.matchAll(/([lrub]+)([io])/g)) (way === 'i' ? ins : outs).push(...([...sides] as Side[]))
  return { ins, outs }
}

async function buildingParts(m: Manifest, building: Manifest['buildings'][string], variant: number | undefined): Promise<Part[] | null> {
  const table = building.shapes && variant !== undefined ? m.shapes[building.shapes] : undefined
  const shape = table && table[building.shapes === 'Belt' ? beltShape(variant!, (k) => k in table) : variant!]
  const parts: ManifestPart[] = shape ? [shape] : building.parts
  if (!parts.length) return null
  return Promise.all(
    parts.map(async (part) => {
      const slots = m.meshes[part.mesh]?.materials ?? []
      const chosen = slots.map((slot, i) => part.materials?.[i] ?? slot)
      return {
        key: `${part.mesh}|${chosen.join(',')}`,
        geometry: await meshGeometry(part.mesh),
        materials: chosen.map((mat) => material(mat ? m.materials[mat] : undefined, mat ?? '')),
        matrix: part.matrix ? new Matrix4().fromArray(part.matrix) : new Matrix4(),
      }
    }),
  )
}

/**
 * The belt shape (DT_BeltMeshBuildings row) to draw a belt's BaseActiveIndex with. The index says
 * which sides belts come in from (low four bits: right 1, bottom 2, left 4, up 8) and go out to
 * (high four: right 16 … up 128), and the game's table has a row for each that makes sense. A side
 * marked both in and out has none (the game saves a few): it's left out, and the rest drawn.
 */
export function beltShape(index: number, known: (key: number) => boolean): number {
  if (known(index)) return index
  const both = index & (index >> 4) & 0xf
  const rest = index & ~(both | (both << 4))
  return known(rest) ? rest : 0
}

function meshGeometry(name: string): Promise<BufferGeometry> {
  let geometry = geometries.get(name)
  if (!geometry) {
    geometry = fetch(new URL(`meshes/${name}.mesh`, base()))
      .then((r) => {
        if (!r.ok) throw new Error(`Mesh ${name} couldn’t be loaded (${r.status})`)
        return r.arrayBuffer()
      })
      .then(readMesh)
    geometries.set(name, geometry)
  }
  return geometry
}

/**
 * A mesh file (layout in scripts/compressMeshes.mjs: gzip around meshoptimizer-encoded vertices
 * and indices) as geometry, one group per section, in Unreal's space.
 */
export async function readMesh(file: ArrayBuffer): Promise<BufferGeometry> {
  const buffer = await new Response(new Blob([file]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== 0x324d4641) throw new Error('Not a mesh file') // "AFM2"
  const vertices = view.getUint32(4, true)
  const indices = view.getUint32(8, true)
  const sections = view.getUint32(12, true)
  const bounds = [...Array(10).keys()].map((i) => view.getFloat32(16 + i * 4, true))
  const [min, max, uvMin, uvMax] = [bounds.slice(0, 3), bounds.slice(3, 6), bounds.slice(6, 8), bounds.slice(8, 10)]
  let at = 56
  const geometry = new BufferGeometry()
  for (let s = 0; s < sections; s++, at += 12)
    geometry.addGroup(view.getUint32(at, true), view.getUint32(at + 4, true), view.getUint32(at + 8, true))
  const vertexBytes = view.getUint32(at, true)
  at += 4

  await MeshoptDecoder.ready
  const packed = new Uint8Array(vertices * VERTEX)
  MeshoptDecoder.decodeVertexBuffer(packed, vertices, VERTEX, new Uint8Array(buffer, at, vertexBytes))
  const wide = vertices > 65535
  const index = wide ? new Uint32Array(indices) : new Uint16Array(indices)
  MeshoptDecoder.decodeIndexBuffer(new Uint8Array(index.buffer), indices, wide ? 4 : 2, new Uint8Array(buffer, at + vertexBytes))

  // Each vertex: position u16 × 3 (and padding), normal i8 × 4, UV u16 × 2, across their bounds.
  const v = new DataView(packed.buffer)
  const positions = new Float32Array(vertices * 3)
  const normals = new Float32Array(vertices * 3)
  const uvs = new Float32Array(vertices * 2)
  for (let i = 0; i < vertices; i++) {
    const at = i * VERTEX
    for (let c = 0; c < 3; c++) {
      positions[i * 3 + c] = min[c] + (v.getUint16(at + c * 2, true) / 65535) * (max[c] - min[c])
      normals[i * 3 + c] = v.getInt8(at + 8 + c) / 127
    }
    for (let c = 0; c < 2; c++) uvs[i * 2 + c] = uvMin[c] + (v.getUint16(at + 12 + c * 2, true) / 65535) * (uvMax[c] - uvMin[c])
  }
  // Unreal's triangles turn clockwise round their outward side, three.js's the other way (as it
  // keeps them once the scene's mirror into its space is undone): reverse each.
  for (let t = 0; t + 2 < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]]

  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
  geometry.setIndex(new BufferAttribute(index, 1))
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  return geometry
}

/** Bytes per vertex before encoding. */
const VERTEX = 16

function material(spec: ManifestMaterial | undefined, name: string): Material {
  let made = materials.get(name)
  if (made) return made
  const m = new MeshStandardMaterial({ color: 0x9a948c, roughness: 0.8, metalness: 0 })
  if (spec?.color) {
    m.color = new Color(0xffffff)
    m.map = texture(spec.color, SRGBColorSpace)
  } else if (spec?.tint) m.color = new Color().setRGB(...spec.tint, LinearSRGBColorSpace)
  // A building's tint comes as its instance's colour, and shows only through its mask (the game's
  // MaskColorChange multiplies the base colour there); a model without a mask leaves it out.
  if (spec?.color && spec.mask) {
    // The game reads its masks as sRGB.
    const mask = texture(spec.mask, SRGBColorSpace)
    m.onBeforeCompile = (shader) => tintThroughMask(shader, mask)
  } else m.onBeforeCompile = untinted
  if (spec?.normal) {
    m.normalMap = texture(spec.normal, LinearSRGBColorSpace)
    // The game's normal maps point green down (DirectX); three.js reads green as up.
    m.normalScale = new Vector2(1, -1)
  }
  if (spec?.orm) {
    // Roughness is in green, as three.js reads it. The other channels aren't packed the same way
    // from one model to the next (painted wood would come out as metal), so metal stays a constant
    // and occlusion is left out: the colour map carries the look.
    m.roughnessMap = texture(spec.orm, LinearSRGBColorSpace)
    m.roughness = 1
    m.metalness = 0.1
  }
  if (spec?.masked) m.alphaTest = 0.33
  if (spec?.translucent) {
    m.transparent = true
    m.opacity = 0.45
    m.depthWrite = false
  }
  made = m
  materials.set(name, made)
  return made
}

type Shader = Parameters<Material['onBeforeCompile']>[0]

function tintThroughMask(shader: Shader, mask: Texture) {
  shader.uniforms.tintMask = { value: mask }
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <color_pars_fragment>', '#include <color_pars_fragment>\nuniform sampler2D tintMask;')
    .replace(
      '#include <color_fragment>',
      '#ifdef USE_COLOR\n\tdiffuseColor.rgb *= mix( vec3( 1.0 ), vColor.rgb, texture2D( tintMask, vMapUv ).r );\n#endif',
    )
}

function untinted(shader: Shader) {
  shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '')
}

function texture(file: string, colorSpace:typeof SRGBColorSpace | typeof LinearSRGBColorSpace): Texture {
  let t = textures.get(file)
  if (!t) {
    t = loader.load(new URL(`textures/${file}`, base()).href, () => textureListeners.forEach((listener) => listener()))
    t.colorSpace = colorSpace
    // Unreal's UVs start at the top of the picture, and run past it to repeat it.
    t.flipY = false
    t.wrapS = RepeatWrapping
    t.wrapT = RepeatWrapping
    t.anisotropy = 4
    textures.set(file, t)
  }
  return t
}
