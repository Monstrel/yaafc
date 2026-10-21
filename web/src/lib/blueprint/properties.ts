/**
 * Unreal Engine's tagged properties (the format of a SaveGame), as UE 5.4 and later write them:
 * every tag spells out its name and full type, so a stream reads without knowing its classes.
 *
 * A tag is: name · type tree · value size (int32) · flags (byte) · [array index] · [GUID] · value.
 * A type tree is a name and its parameters, each a type tree: `ArrayProperty(StructProperty(
 * CloneBuildingData(/Script/BeltTD)))`. A struct's properties run until a tag named "None".
 */

export type PropertyValue = null | boolean | number | string | PropertyValue[] | Properties
export interface Properties {
  [name: string]: PropertyValue
}

interface TypeName {
  name: string
  params: TypeName[]
}

const HAS_ARRAY_INDEX = 0x01
const HAS_GUID = 0x02
const HAS_EXTENSIONS = 0x04
const BINARY_OR_NATIVE = 0x08
const BOOL_TRUE = 0x10

/** Structs serialized as their raw fields rather than as tags, and how to read them. */
const NATIVE_STRUCTS: Record<string, (r: Reader) => PropertyValue> = {
  Vector: (r) => [r.f64(), r.f64(), r.f64()],
  Vector2D: (r) => [r.f64(), r.f64()],
  Rotator: (r) => [r.f64(), r.f64(), r.f64()],
  Quat: (r) => [r.f64(), r.f64(), r.f64(), r.f64()],
  IntPoint: (r) => [r.i32(), r.i32()],
  IntVector: (r) => [r.i32(), r.i32(), r.i32()],
  // FColor is stored B, G, R, A.
  Color: (r) => [r.u8(), r.u8(), r.u8(), r.u8()],
  LinearColor: (r) => [r.f32(), r.f32(), r.f32(), r.f32()],
  Guid: (r) => [r.u32(), r.u32(), r.u32(), r.u32()],
}

export class Reader {
  readonly bytes: Uint8Array
  private view: DataView
  pos: number

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.pos = pos
  }

  private advance(n: number) {
    const at = this.pos
    if (at + n > this.bytes.length) throw new RangeError(`Read past the end of the data (at byte ${at})`)
    this.pos += n
    return at
  }
  u8 = () => this.view.getUint8(this.advance(1))
  i32 = () => this.view.getInt32(this.advance(4), true)
  u32 = () => this.view.getUint32(this.advance(4), true)
  u16 = () => this.view.getUint16(this.advance(2), true)
  i64 = () => Number(this.view.getBigInt64(this.advance(8), true))
  f32 = () => this.view.getFloat32(this.advance(4), true)
  f64 = () => this.view.getFloat64(this.advance(8), true)
  skip = (n: number) => void this.advance(n)

  /** An FString: its length counts the terminating zero, and a negative one means UTF-16. */
  string(): string {
    const n = this.i32()
    if (n === 0) return ''
    if (n < 0) {
      const at = this.advance(-n * 2)
      return new TextDecoder('utf-16le').decode(this.bytes.subarray(at, at - n * 2 - 2))
    }
    const at = this.advance(n)
    return new TextDecoder('latin1').decode(this.bytes.subarray(at, at + n - 1))
  }
}

function readTypeName(r: Reader): TypeName {
  const name = r.string()
  const count = r.i32()
  const params: TypeName[] = []
  for (let i = 0; i < count; i++) params.push(readTypeName(r))
  return { name, params }
}

/** Reads tags up to the "None" that ends them. */
export function readProperties(r: Reader): Properties {
  const out: Properties = {}
  for (;;) {
    const name = r.string()
    if (name === 'None') return out
    const type = readTypeName(r)
    const size = r.i32()
    const flags = r.u8()
    const index = flags & HAS_ARRAY_INDEX ? r.i32() : 0
    if (flags & HAS_GUID) r.skip(16)
    if (flags & HAS_EXTENSIONS) {
      const extensions = r.u8()
      if (extensions !== 0) throw new Error(`Property ${name} has extensions this reader doesn't know (${extensions})`)
    }
    const start = r.pos
    const value = type.name === 'BoolProperty' ? Boolean(flags & BOOL_TRUE) : readValue(r, type, size, flags)
    // A value this reader got wrong (or skipped) still ends where its size says.
    r.pos = start + size
    out[index ? `${name}[${index}]` : name] = value
  }
}

/** A tag's value; `size` and `flags` are its tag's (an array's elements have neither). */
function readValue(r: Reader, type: TypeName, size: number, flags: number, inArray = false): PropertyValue {
  switch (type.name) {
    case 'BoolProperty':
      return r.u8() !== 0
    case 'ByteProperty':
      // A byte naming an enum value is written as that value's name.
      return type.params.length && !inArray ? r.string() : r.u8()
    case 'IntProperty':
      return r.i32()
    case 'UInt16Property':
      return r.u16()
    case 'UInt32Property':
      return r.u32()
    case 'Int64Property':
      return r.i64()
    case 'FloatProperty':
      return r.f32()
    case 'DoubleProperty':
      return r.f64()
    case 'NameProperty':
    case 'StrProperty':
    case 'EnumProperty':
      return r.string()
    case 'TextProperty':
      return readText(r, size)
    case 'StructProperty': {
      const struct = type.params[0]?.name ?? ''
      const native = NATIVE_STRUCTS[struct]
      if (native) return native(r)
      if (flags & BINARY_OR_NATIVE) return null // a native struct this reader doesn't know: skipped by size
      return readProperties(r)
    }
    case 'ArrayProperty': {
      const count = r.i32()
      const values: PropertyValue[] = []
      for (let i = 0; i < count; i++) values.push(readValue(r, type.params[0], 0, 0, true))
      return values
    }
    case 'SetProperty': {
      r.i32() // elements to remove: none in a saved set
      const count = r.i32()
      const values: PropertyValue[] = []
      for (let i = 0; i < count; i++) values.push(readValue(r, type.params[0], 0, 0, true))
      return values
    }
    case 'MapProperty': {
      r.i32() // keys to remove: none in a saved map
      const count = r.i32()
      const entries: PropertyValue[] = []
      for (let i = 0; i < count; i++)
        entries.push([readValue(r, type.params[0], 0, 0, true), readValue(r, type.params[1], 0, 0, true)])
      return entries
    }
    default:
      if (inArray) throw new Error(`Can't read an array of ${type.name}`)
      return null // skipped by size
  }
}

/** An FText: its source string, for the kinds a player's own text is saved as. */
function readText(r: Reader, size: number): string | null {
  const end = r.pos + size
  r.u32() // flags
  const history = r.u8()
  if (history === 0xff) {
    // No history: text typed in by the player.
    return r.i32() ? r.string() : ''
  }
  if (history === 0) {
    // Base: namespace, key, source string.
    r.string()
    r.string()
    return r.string()
  }
  r.pos = end
  return null
}
