import { Box3, Matrix4, Vector3 } from 'three'
import { describe, expect, test } from 'vitest'
import manifest from '../../../public/models/manifest.json'
import frameUrl from '../../../public/models/meshes/SM_FrameSingle.mesh?inline'
import { readBlueprint } from '../../lib/blueprint/blueprintFile'
import { beltShape, beltSides, portFlow, readMesh, type Port } from './models'

const bytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0))
const blueprints = import.meta.glob<string>('../../test/blueprints/*.png', { query: '?inline', import: 'default', eager: true })

// The models as the extractor wrote them (`dotnet run -- models`).
const buildings = manifest.buildings as Record<string, { name: string; parts: { mesh: string; materials?: (string | null)[] }[]; layers: number; shapes?: string }>
const meshes = manifest.meshes as Record<string, { materials: (string | null)[] }>
const shapes = manifest.shapes as Record<string, Record<string, { mesh: string; sides?: string }>>
const belts = shapes.Belt as Record<string, { mesh: string; sides: string }>
const pipes = shapes.Pipeline
const materials = manifest.materials as Record<string, object>

describe('readMesh', () => {
  test('reads a mesh in the game’s units, from its origin at the bottom middle', async () => {
    // A single lab stand fills one cell: 25 units each way, standing on its origin.
    const data = bytes(frameUrl)
    const geometry = await readMesh(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
    const box = geometry.boundingBox!
    expect(box.min.toArray().map((v) => Math.round(v * 10) / 10)).toEqual([-12.5, -12.5, 0])
    expect(box.max.toArray().map((v) => Math.round(v * 10) / 10)).toEqual([12.5, 12.5, 25])
    const normal = geometry.getAttribute('normal')
    for (let i = 0; i < normal.count; i++)
      expect(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))).toBeCloseTo(1, 1)
    // Its sections draw every triangle.
    expect(geometry.groups.reduce((n, g) => n + g.count, 0)).toBe(geometry.index!.count)
  })

  test('turns every triangle counter-clockwise round its outward side, as three.js draws its front', async () => {
    const data = bytes(frameUrl)
    const geometry = await readMesh(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
    const position = geometry.getAttribute('position')
    const normal = geometry.getAttribute('normal')
    const index = geometry.index!
    const [a, b, c, n] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()]
    for (let t = 0; t < index.count; t += 3) {
      a.fromBufferAttribute(position, index.getX(t))
      b.fromBufferAttribute(position, index.getX(t + 1)).sub(a)
      c.fromBufferAttribute(position, index.getX(t + 2)).sub(a)
      n.fromBufferAttribute(normal, index.getX(t))
      expect(b.cross(c).dot(n), `triangle ${t / 3}`).toBeGreaterThan(0)
    }
  })
})

describe('the models manifest', () => {
  test('names every mesh and material its buildings use', () => {
    for (const [key, building] of Object.entries(buildings))
      for (const part of building.parts) {
        expect(meshes[part.mesh], `${key}: ${part.mesh}`).toBeDefined()
        for (const material of [...meshes[part.mesh].materials, ...(part.materials ?? [])])
          if (material) expect(materials[material], `${key}: ${material}`).toBeDefined()
      }
    for (const table of Object.values(shapes)) for (const shape of Object.values(table)) expect(meshes[shape.mesh]).toBeDefined()
    expect(buildings.Belt.shapes).toBe('Belt')
    expect(buildings.Pipe.shapes).toBe('Pipeline')
    expect(buildings.Pipe_Vertical.shapes).toBe('Pipeline')
  })

  test('gives each building its height in whole layers, as the game builds with it', () => {
    for (const b of Object.values(buildings)) expect(Number.isInteger(b.layers) && b.layers >= 1).toBe(true)
    // A cauldron's rim pokes a hair over its two layers; an athanor stands 2.84 high.
    expect([buildings.Cauldron.layers, buildings.Athanor.layers, buildings.DrawBridge.layers]).toEqual([2, 3, 3])
    expect([buildings.Belt.layers, buildings.SteamHeater.layers, buildings.FrameDuo.layers]).toEqual([1, 1, 2])
  })

  test.each(Object.keys(blueprints))('has a model for every building in %s', async (path) => {
    const bp = await readBlueprint(bytes(blueprints[path]))
    const keys = new Set(Object.keys(buildings).map((k) => k.toLowerCase()))
    for (const b of bp.buildings) {
      expect(keys.has(b.name.toLowerCase()), b.name).toBe(true)
      // A belt's shape is the game's own, or the nearest it has (see beltShape).
      if (b.name === 'Belt') expect(belts[beltShape(b.variant!, (k) => k in belts)], `belt shape ${b.variant}`).toBeDefined()
      // A pipe's: every way six sides can join is in the game's table.
      if (b.name.startsWith('Pipe')) expect(pipes[b.variant!], `pipe shape ${b.variant}`).toBeDefined()
    }
  })
})

describe('beltShape', () => {
  const SIDES = ['r', 'b', 'l', 'u']
  /** The sides a shape's index names, as the game's table describes them: "li", "ro"… */
  const fromBits = (index: number) =>
    SIDES.flatMap((side, bit) => [...(index & (1 << bit) ? [side + 'i'] : []), ...(index & (16 << bit) ? [side + 'o'] : [])]).sort()
  // "bliro": sides before an i come in (bottom, left), before an o go out (right).
  const described = (sides: string) =>
    [...sides.matchAll(/([lrub]+)([io])/g)].flatMap(([, letters, way]) => [...letters].map((side) => side + way)).sort()

  test('reads an index as the sides belts come in from and go out to', () => {
    // Every shape with a way in and a way out: the rest are drawn as a default straight belt.
    const both = Object.entries(belts).filter(([k]) => Number(k) & 0x0f && Number(k) & 0xf0)
    expect(both.length).toBeGreaterThan(40)
    for (const [key, belt] of both) expect(fromBits(Number(key)), `shape ${key}`).toEqual(described(belt.sides))
  })

  test('leaves out a side that is both a way in and a way out', () => {
    const known = (k: number) => k in belts
    // Left in and left out: nothing left but a straight belt.
    expect(beltShape(68, known)).toBe(0)
    // Up in and out, and right out: out to the right.
    expect(beltShape(152, known)).toBe(16)
    // Right in and out, and out up and down: a split.
    expect(beltShape(177, known)).toBe(160)
    expect(beltShape(20, known)).toBe(20)
  })
})

describe('pipe shapes', () => {
  const files = import.meta.glob<string>('../../../public/models/meshes/SM_Pipe_*.mesh', { query: '?inline', import: 'default', eager: true })
  const box = async (mesh: string) => {
    const data = bytes(files[`../../../public/models/meshes/${mesh}.mesh`])
    return (await readMesh(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))).boundingBox!
  }
  // The sides of a cell, by bit, as unit directions in the game's space: right +x, bottom +y,
  // left -x, up -y, below -z, above +z.
  const SIDES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(-1, 0, 0), new Vector3(0, -1, 0), new Vector3(0, 0, -1), new Vector3(0, 0, 1)]

  test.each(Object.keys(pipes).filter((k) => k !== '0'))('shape %s reaches the sides it joins, and no others', async (key) => {
    const shape = pipes[key] as { mesh: string; matrix?: number[] }
    const placed = new Box3().copy(await box(shape.mesh)).applyMatrix4(new Matrix4().fromArray(shape.matrix ?? new Matrix4().toArray()))
    // From the middle of its cell (its origin is the bottom of its layer).
    const center = new Vector3(0, 0, 12.5)
    SIDES.forEach((side, bit) => {
      // How far the pipe runs from the middle toward that side.
      const reach = Math.max(side.dot(placed.max.clone().sub(center)), side.dot(placed.min.clone().sub(center)))
      if (Number(key) & (1 << bit)) expect(reach, `side ${bit}`).toBeGreaterThan(12)
      else expect(reach, `side ${bit}`).toBeLessThan(5)
    })
  })
})

describe('beltSides', () => {
  test('reads which sides a belt shape takes items in from and sends them out to', () => {
    expect(beltSides('liro')).toEqual({ ins: ['l'], outs: ['r'] })
    expect(beltSides('bliro')).toEqual({ ins: ['b', 'l'], outs: ['r'] })
    // A splitter's shape: one way in, three out.
    expect(beltSides('irbluo')).toEqual({ ins: [], outs: ['r', 'b', 'l', 'u'] })
    expect(beltSides('lirbuo')).toEqual({ ins: ['l'], outs: ['r', 'b', 'u'] })
  })

  test('every belt shape names its sides', () => {
    // Some name only ways in (all four, "rbluio") or only ways out (all four, "irbluo").
    for (const belt of Object.values(belts)) {
      const { ins, outs } = beltSides(belt.sides)
      expect(ins.length + outs.length, belt.sides).toBeGreaterThan(0)
    }
  })
})

describe('portFlow', () => {
  const flow = (name: string) => {
    const b = (manifest.buildings as unknown as Record<string, { ports?: Port[]; top?: number }>)[name]
    return portFlow(name, b.ports!, b.top!)
  }

  test('a ramp runs from its low edge to its high one, a layer up over two cells', () => {
    expect(flow('BeltSlopeUp')).toEqual({ kind: 'path', paths: [{ from: [-12.5, 0, 0], to: [37.5, 0, 25] }], roof: undefined })
    // The way down: the same slope, the other way.
    expect(flow('BeltSlopeDown')).toEqual({ kind: 'path', paths: [{ from: [37.5, 0, 25], to: [-12.5, 0, 0] }], roof: undefined })
    expect(flow('BeltInclinedUp')).toMatchObject({ paths: [{ from: [-12.5, 0, 0], to: [62.5, 0, 75] }] })
  })

  test('a drawbridge spans its four cells; a tunnel’s arrow goes over its roof', () => {
    expect(flow('DrawBridge')).toMatchObject({ paths: [{ from: [0, 12.5, 0], to: [0, -87.5, 0] }] })
    expect(flow('DrawBridgeR')).toMatchObject({ paths: [{ from: [0, -87.5, 0], to: [0, 12.5, 0] }] })
    expect(flow('ConveyorTunnel')).toMatchObject({ paths: [{ from: [0, -12.5, 0], to: [0, 87.5, 0] }], roof: 26.4 })
    // Two ways through, crossing in its middle cell.
    expect(flow('CrossTunnel')).toMatchObject({
      paths: [
        { from: [-37.5, 0, 0], to: [37.5, 0, 0] },
        { from: [0, -37.5, 0], to: [0, 37.5, 0] },
      ],
    })
  })

  test('each section of a retractable conveyor passage carries items across its cell, over its roof', () => {
    for (const name of ['ExpandableConveyorTunnel', 'ExpandableConveyorTunnelBody'])
      expect(flow(name)).toMatchObject({ kind: 'path', paths: [{ from: [0, -12.5, 0], to: [0, 12.5, 0] }], roof: expect.any(Number) })
  })

  test('a lift goes up or down, and its top end takes items out by, or in from, a side', () => {
    expect(flow('ConveyerLift_Upwards')).toEqual({ kind: 'lift', up: true, top: undefined })
    expect(flow('ConveyerLift_Downwards')).toEqual({ kind: 'lift', up: false, top: undefined })
    expect(flow('ConveyerLift_EndUpwards')).toEqual({ kind: 'lift', up: true, top: { side: 'b', out: true } })
    expect(flow('ConveyerLift_EndDownwards')).toEqual({ kind: 'lift', up: false, top: { side: 'b', out: false } })
  })
})
