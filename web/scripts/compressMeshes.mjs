// Compresses the Blueprint X-ray's meshes for the page. The extractor (`dotnet run -- models`)
// writes each mesh plainly (AFM1, see tools/extractor/Models.cs) and runs this on them:
//
//   node scripts/compressMeshes.mjs <AFM1 folder> <web/public/models/meshes>
//
// It writes each as a .mesh: gzip around an AFM2 file, little-endian:
//
//   "AFM2" · vertices (u32) · indices (u32) · sections (u32)
//   position bounds min, max (f32 × 3 each) · UV bounds min, max (f32 × 2 each)
//   sections: first index, index count, material slot (u32 each)
//   encoded vertices' byte length (u32) · encoded vertices · encoded indices
//
// Vertices are 16 bytes before meshoptimizer encodes them: position u16 × 3 across its bounds
// (and 2 bytes of padding), normal i8 × 4 (x, y, z, 0), UV u16 × 2 across its bounds. Indices
// are u16, or u32 past 65,535 vertices. Each section's triangles are reordered for the GPU's
// vertex cache, and its vertices into the order they're first used, which is what lets them
// compress: about a third of the plain size.
import { MeshoptEncoder } from 'meshoptimizer/encoder'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const [source, target] = process.argv.slice(2)
if (!source || !target) {
  console.error('Usage: node compressMeshes.mjs <AFM1 folder> <output folder>')
  process.exit(1)
}
await MeshoptEncoder.ready
mkdirSync(target, { recursive: true })

const VERTEX = 16
let plain = 0
let packed = 0
for (const file of readdirSync(source).filter((f) => f.endsWith('.bin'))) {
  const input = readFileSync(join(source, file))
  const mesh = readPlain(input)
  const output = gzipSync(writePacked(mesh), { level: 9 })
  writeFileSync(join(target, file.replace(/\.bin$/, '.mesh')), output)
  plain += input.length
  packed += output.length
}
console.log(`Compressed meshes: ${(plain / 1024) | 0} KB → ${(packed / 1024) | 0} KB`)

/** An AFM1 file: bounds, sections, and its attributes as written. */
function readPlain(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (view.getUint32(0, true) !== 0x314d4641) throw new Error('Not an AFM1 mesh')
  const vertices = view.getUint32(4, true)
  const indexCount = view.getUint32(8, true)
  const sectionCount = view.getUint32(12, true)
  const min = [0, 1, 2].map((i) => view.getFloat32(16 + i * 4, true))
  const max = [0, 1, 2].map((i) => view.getFloat32(28 + i * 4, true))
  let at = 40
  const sections = []
  for (let s = 0; s < sectionCount; s++, at += 12)
    sections.push({ first: view.getUint32(at, true), count: view.getUint32(at + 4, true), slot: view.getUint32(at + 8, true) })
  const slice = (bytes) => buffer.buffer.slice(buffer.byteOffset + at, buffer.byteOffset + (at += bytes))
  const positions = new Uint16Array(slice(vertices * 6))
  at += (4 - (at % 4)) % 4
  const normals = new Int8Array(slice(vertices * 4))
  const uvs = new Float32Array(slice(vertices * 8))
  const indices = vertices > 65535 ? Uint32Array.from(new Uint32Array(slice(indexCount * 4))) : Uint32Array.from(new Uint16Array(slice(indexCount * 2)))
  return { vertices, min, max, sections, positions, normals, uvs, indices }
}

function writePacked({ min, max, sections, positions, normals, uvs, indices }) {
  const uvMin = [Infinity, Infinity]
  const uvMax = [-Infinity, -Infinity]
  for (let i = 0; i < uvs.length; i++) {
    uvMin[i % 2] = Math.min(uvMin[i % 2], uvs[i])
    uvMax[i % 2] = Math.max(uvMax[i % 2], uvs[i])
  }
  const uvSpan = [0, 1].map((c) => Math.max(uvMax[c] - uvMin[c], 1e-9))

  // Each section on its own vertices, reordered: sections are a material each, so they share few.
  const vertexBytes = []
  const indexParts = []
  const placed = []
  let vertexCount = 0
  let indexCount = 0
  for (const section of sections) {
    const local = new Map()
    const sectionIndices = new Uint32Array(section.count)
    const source = []
    for (let i = 0; i < section.count; i++) {
      const v = indices[section.first + i]
      if (!local.has(v)) {
        local.set(v, source.length)
        source.push(v)
      }
      sectionIndices[i] = local.get(v)
    }
    const [remap, unique] = MeshoptEncoder.reorderMesh(sectionIndices, true, false)
    const bytes = new Uint8Array(unique * VERTEX)
    const view = new DataView(bytes.buffer)
    source.forEach((v, i) => {
      const at = remap[i] * VERTEX
      for (let c = 0; c < 3; c++) view.setUint16(at + c * 2, positions[v * 3 + c], true)
      for (let c = 0; c < 3; c++) view.setInt8(at + 8 + c, normals[v * 4 + c])
      for (let c = 0; c < 2; c++) view.setUint16(at + 12 + c * 2, Math.round(((uvs[v * 2 + c] - uvMin[c]) / uvSpan[c]) * 65535), true)
    })
    for (let i = 0; i < sectionIndices.length; i++) sectionIndices[i] += vertexCount
    vertexBytes.push(bytes)
    indexParts.push(sectionIndices)
    placed.push({ first: indexCount, count: section.count, slot: section.slot })
    vertexCount += unique
    indexCount += section.count
  }

  const allVertices = new Uint8Array(vertexCount * VERTEX)
  let offset = 0
  for (const bytes of vertexBytes) allVertices.set(bytes, (offset += bytes.length) - bytes.length)
  const all = new Uint32Array(indexCount)
  offset = 0
  for (const part of indexParts) all.set(part, (offset += part.length) - part.length)
  const wide = vertexCount > 65535
  const indexBytes = wide ? new Uint8Array(all.buffer) : new Uint8Array(Uint16Array.from(all).buffer)
  const encodedVertices = MeshoptEncoder.encodeVertexBuffer(allVertices, vertexCount, VERTEX)
  const encodedIndices = MeshoptEncoder.encodeIndexBuffer(indexBytes, indexCount, wide ? 4 : 2)

  const header = new DataView(new ArrayBuffer(16 + 40 + placed.length * 12 + 4))
  header.setUint32(0, 0x324d4641, true) // "AFM2"
  header.setUint32(4, vertexCount, true)
  header.setUint32(8, indexCount, true)
  header.setUint32(12, placed.length, true)
  ;[...min, ...max, ...uvMin, ...uvMax].forEach((v, i) => header.setFloat32(16 + i * 4, v, true))
  placed.forEach((s, i) => {
    header.setUint32(56 + i * 12, s.first, true)
    header.setUint32(60 + i * 12, s.count, true)
    header.setUint32(64 + i * 12, s.slot, true)
  })
  header.setUint32(56 + placed.length * 12, encodedVertices.length, true)
  return Buffer.concat([Buffer.from(header.buffer), Buffer.from(encodedVertices), Buffer.from(encodedIndices)])
}
