import { evaluate, recipeSignature, type CauldronMode } from './cauldron'
import { BUILDINGS, RECIPES, WORDS } from './shareDictionary'
import type { Backup } from './store'
import type { Plan, PlanTarget, SavedRecipe, Separation } from './types'

/**
 * A plan as a short URL-safe code: one byte stream, base64url-encoded once. Game names are their
 * place in a frozen dictionary (one byte), numbers are varints, and every setting kept per tree row
 * hangs off one tree of row paths, so the steps rows share are written once. Saved cauldron recipes
 * the plan uses travel inside it, as their ingredients.
 *
 * Layout (format 1):
 *   format byte · name · research tier · plan flags (which sections follow) · targets · producers · machines ·
 *   feedback items · altar items · separations · supply caps · row tree
 */

const FORMAT = 1

// Token bytes: a dictionary place below DICTIONARY_LIMIT, or one of these.
const DICTIONARY_LIMIT = 0xf0
const NONE = 0xfc // an advanced recipe's missing third ingredient
const RECOVER = 0xfd // row step `recover:<item>@<process>`
const WITH = 0xfe // row step `with:<item>`
const SPELLED = 0xff // a name the dictionary lacks, spelled out

const PLAN_AUTO_ORGANIZE = 1
const PLAN_LOOP_FEEDBACK = 2
const PLAN_PRODUCERS = 4
const PLAN_MACHINES = 8
const PLAN_FEEDBACK = 16
const PLAN_ALTAR = 32
const PLAN_SEPARATE = 64
const PLAN_SUPPLY = 128

const UNITS: readonly (PlanTarget['unit'] | undefined)[] = [undefined, 'machines', 'net', 'overflow', 'supply', 'dispatch']
const TARGET_FEEDBACK = 8 // its feedback is set; TARGET_FEEDS_BACK says which way
const TARGET_FEEDS_BACK = 16
const TARGET_CONSUMES = 32

const SEPARATE_ANCHOR = 1
const SEPARATE_AT = 2

// What a row in the tree carries, in the order its values follow. A row's header is these flags
// above two bits of child count (3 = more, counted after its values): most rows are one byte.
const ROW_PICK = 1
const ROW_PICK_MACHINE = 2
const ROW_ROUND_UP = 4
const ROW_BUILT = 8
const ROW_UNITS = 16
const ROW_STACK = 32
const ROW_HEIGHT = 64
const ROW_CATALYSTS = 128
const ROW_ALTAR_OUTPUTS = 256
const ROW_MIXED = 512
const ROW_NOT_MIXED = 1024
const CHILD_BITS = 4
const MANY_CHILDREN = 3

// Numbers: a varint whose low two bits say how to read the rest.
const SCALES = [1, 10, 1000] // whole, tenths, thousandths
const EXACT = 3 // an 8-byte double follows

// Process kinds: those with one name after a prefix, then the rest.
const PREFIXED: readonly [string, readonly string[]][] = [
  ['recipe:', RECIPES],
  ['nursery:', WORDS],
  ['paradox:', WORDS],
  ['buy:', WORDS],
  ['spend:', WORDS],
  ['fuel:', WORDS],
  ['boiler:', WORDS],
  ['fert:', WORDS],
]
const KIND_EMPTY = PREFIXED.length
const KIND_IMPORT = KIND_EMPTY + 1
const KIND_BUS = KIND_EMPTY + 2
const KIND_BANK = KIND_EMPTY + 3
const KIND_CAULDRON = KIND_EMPTY + 4 // its ingredients follow
const KIND_CAULDRON_AGAIN = KIND_EMPTY + 5 // one already in the code, by its place in order of first use
const KIND_SPELLED = 0xff

const CAULDRON = 'cauldron:'

const places = (list: readonly string[]) => new Map(list.map((s, i) => [s, i]))
const PLACES = new Map<readonly string[], Map<string, number>>([
  [WORDS, places(WORDS)],
  [RECIPES, places(RECIPES)],
  [BUILDINGS, places(BUILDINGS)],
])

class Writer {
  readonly bytes: number[] = []
  /** The plan's saved recipes by id. */
  readonly saved: Map<string, SavedRecipe>
  /** Places of the recipes written so far, by signature (as the reader numbers them). */
  readonly written = new Map<string, number>()

  constructor(saved: SavedRecipe[]) {
    this.saved = new Map(saved.map((s) => [s.id, s]))
  }

  byte(b: number) {
    this.bytes.push(b)
  }

  varint(n: number) {
    do {
      const low = n % 128
      n = Math.floor(n / 128)
      this.bytes.push(n > 0 ? low | 0x80 : low)
    } while (n > 0)
  }

  number(x: number) {
    for (let code = 0; code < SCALES.length; code++) {
      const n = Math.round(x * SCALES[code])
      if (n >= 0 && n / SCALES[code] === x && Number.isSafeInteger(n * 4 + code)) return this.varint(n * 4 + code)
    }
    this.varint(EXACT)
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat64(0, x, true)
    for (let i = 0; i < 8; i++) this.bytes.push(view.getUint8(i))
  }

  text(s: string) {
    const utf8 = new TextEncoder().encode(s)
    this.varint(utf8.length)
    for (const b of utf8) this.bytes.push(b)
  }

  name(s: string, list: readonly string[] = WORDS) {
    const place = PLACES.get(list)!.get(s)
    if (place !== undefined && place < DICTIONARY_LIMIT) return this.byte(place)
    this.byte(SPELLED)
    this.text(s)
  }

  names(list: readonly string[]) {
    this.varint(list.length)
    for (const s of list) this.name(s)
  }

  /** A process id (or 'import', 'bus', ''), with a saved cauldron recipe as its ingredients. */
  process(id: string) {
    const prefixed = PREFIXED.findIndex(([prefix]) => id.startsWith(prefix))
    if (prefixed >= 0) {
      const [prefix, list] = PREFIXED[prefixed]
      this.byte(prefixed)
      return this.name(id.slice(prefix.length), list)
    }
    if (id === '') return this.byte(KIND_EMPTY)
    if (id === 'import') return this.byte(KIND_IMPORT)
    if (id === 'bus') return this.byte(KIND_BUS)
    const bank = /^bank:([^:]+):([^:]+)$/.exec(id)
    if (bank) {
      this.byte(KIND_BANK)
      this.name(bank[1])
      return this.name(bank[2])
    }
    const recipe = id.startsWith(CAULDRON) ? this.saved.get(id.slice(CAULDRON.length)) : undefined
    if (recipe) {
      const signature = recipeSignature(recipe.mode, recipe.inputs)
      const place = this.written.get(signature)
      if (place !== undefined) {
        this.byte(KIND_CAULDRON_AGAIN)
        return this.varint(place)
      }
      this.written.set(signature, this.written.size)
      this.byte(KIND_CAULDRON)
      for (const input of recipe.inputs) this.name(input)
      if (recipe.mode === 'advanced') this.byte(NONE)
      return
    }
    this.byte(KIND_SPELLED)
    this.text(id)
  }
}

class Reader {
  private at = 0
  private readonly bytes: Uint8Array
  /** The saved cauldron recipes read so far, one per distinct recipe. */
  readonly recipes: SavedRecipe[] = []

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  get done() {
    return this.at >= this.bytes.length
  }

  byte(): number {
    if (this.at >= this.bytes.length) throw new Error('share code ends early')
    return this.bytes[this.at++]
  }

  peek(): number {
    if (this.at >= this.bytes.length) throw new Error('share code ends early')
    return this.bytes[this.at]
  }

  varint(): number {
    let n = 0
    for (let scale = 1; ; scale *= 128) {
      const b = this.byte()
      n += (b & 0x7f) * scale
      if (b < 0x80) return n
      if (scale > 2 ** 49) throw new Error('share code has a bad number')
    }
  }

  number(): number {
    const n = this.varint()
    const code = n % 4
    if (code !== EXACT) return Math.floor(n / 4) / SCALES[code]
    const view = new DataView(new ArrayBuffer(8))
    for (let i = 0; i < 8; i++) view.setUint8(i, this.byte())
    return view.getFloat64(0, true)
  }

  text(): string {
    const length = this.varint()
    if (this.at + length > this.bytes.length) throw new Error('share code ends early')
    const s = new TextDecoder().decode(this.bytes.subarray(this.at, this.at + length))
    this.at += length
    return s
  }

  name(list: readonly string[] = WORDS): string {
    const b = this.byte()
    if (b === SPELLED) return this.text()
    if (b >= list.length) throw new Error(`share code names something unknown (${b})`)
    return list[b]
  }

  names(): string[] {
    return Array.from({ length: this.varint() }, () => this.name())
  }

  process(): string {
    const kind = this.byte()
    if (kind < PREFIXED.length) {
      const [prefix, list] = PREFIXED[kind]
      return prefix + this.name(list)
    }
    switch (kind) {
      case KIND_EMPTY:
        return ''
      case KIND_IMPORT:
        return 'import'
      case KIND_BUS:
        return 'bus'
      case KIND_BANK:
        return `bank:${this.name()}:${this.name()}`
      case KIND_CAULDRON: {
        const inputs = [this.name(), this.name()]
        const advanced = this.peek() === NONE
        if (advanced) this.byte()
        else inputs.push(this.name())
        return this.recipe(advanced ? 'advanced' : 'normal', inputs)
      }
      case KIND_CAULDRON_AGAIN: {
        const recipe = this.recipes[this.varint()]
        if (!recipe) throw new Error('share code refers to a recipe it doesn’t have')
        return CAULDRON + recipe.id
      }
      case KIND_SPELLED:
        return this.text()
      default:
        throw new Error(`share code has an unknown producer kind (${kind})`)
    }
  }

  private recipe(mode: CauldronMode, inputs: string[]): string {
    const signature = recipeSignature(mode, inputs)
    let recipe = this.recipes.find((s) => recipeSignature(s.mode, s.inputs) === signature)
    if (!recipe) {
      const output = evaluate(mode, inputs)?.output.key ?? ''
      recipe = { id: `shared${this.recipes.length + 1}`, mode, inputs, output, createdAt: 0 }
      this.recipes.push(recipe)
    }
    return CAULDRON + recipe.id
  }
}

// ---- The row tree ----

interface RowSettings {
  pick?: string
  pickMachine?: string
  roundUp?: boolean
  built?: boolean
  units?: { count: number; of: number }
  stack?: number
  height?: number
  catalysts?: string[]
  altarOutputs?: string[]
  mixed?: boolean
}

interface RowNode {
  settings: RowSettings
  children: Map<string, RowNode>
}

const newRow = (): RowNode => ({ settings: {}, children: new Map() })

function rowTree(plan: Plan): RowNode {
  const root = newRow()
  const at = (id: string) => {
    let node = root
    for (const step of id.split('/')) {
      let child = node.children.get(step)
      if (!child) node.children.set(step, (child = newRow()))
      node = child
    }
    return node.settings
  }
  for (const [id, b] of Object.entries(plan.branches ?? {})) {
    const s = at(id)
    s.pick = b.producer
    s.pickMachine = b.machine
  }
  for (const id of plan.roundUp ?? []) at(id).roundUp = true
  for (const id of plan.built ?? []) at(id).built = true
  for (const [id, u] of Object.entries(plan.units ?? {})) at(id).units = u
  for (const [id, n] of Object.entries(plan.rowStacks ?? {})) at(id).stack = n
  for (const [id, n] of Object.entries(plan.rowHeights ?? {})) at(id).height = n
  for (const [id, c] of Object.entries(plan.rowCatalysts ?? {})) at(id).catalysts = c
  for (const [id, o] of Object.entries(plan.altarOutputs ?? {})) at(id).altarOutputs = o
  for (const [id, m] of Object.entries(plan.mixedFeed ?? {})) at(id).mixed = m
  return root
}

/** A path step: a target's index at the top of a path, else an item, `with:` or `recover:` row. */
function writeStep(w: Writer, step: string, top: boolean) {
  if (top) {
    // Paths start at a target's index; anything else is spelled out.
    if (/^\d+$/.test(step)) return w.varint(Number(step) + 1)
    w.varint(0)
    return w.text(step)
  }
  if (step.startsWith('with:')) {
    w.byte(WITH)
    return w.name(step.slice(5))
  }
  const recover = 'recover:'
  const process = step.indexOf('@', recover.length)
  if (step.startsWith(recover) && process > 0) {
    w.byte(RECOVER)
    w.name(step.slice(recover.length, process))
    return w.process(step.slice(process + 1))
  }
  w.name(step)
}

function readStep(r: Reader, top: boolean): string {
  if (top) {
    const n = r.varint()
    return n ? String(n - 1) : r.text()
  }
  const b = r.peek()
  if (b === WITH) {
    r.byte()
    return `with:${r.name()}`
  }
  if (b === RECOVER) {
    r.byte()
    const item = r.name()
    return `recover:${item}@${r.process()}`
  }
  return r.name()
}

function writeRows(w: Writer, rows: Map<string, RowNode>, top: boolean) {
  for (const [step, row] of rows) {
    writeStep(w, step, top)
    const s = row.settings
    const flags =
      (s.pick !== undefined ? ROW_PICK : 0) |
      (s.pickMachine !== undefined ? ROW_PICK_MACHINE : 0) |
      (s.roundUp ? ROW_ROUND_UP : 0) |
      (s.built ? ROW_BUILT : 0) |
      (s.units ? ROW_UNITS : 0) |
      (s.stack !== undefined ? ROW_STACK : 0) |
      (s.height !== undefined ? ROW_HEIGHT : 0) |
      (s.catalysts ? ROW_CATALYSTS : 0) |
      (s.altarOutputs ? ROW_ALTAR_OUTPUTS : 0) |
      (s.mixed === true ? ROW_MIXED : 0) |
      (s.mixed === false ? ROW_NOT_MIXED : 0)
    const children = row.children.size
    w.varint(flags * CHILD_BITS + Math.min(children, MANY_CHILDREN))
    if (children >= MANY_CHILDREN) w.varint(children - MANY_CHILDREN)
    if (s.pick !== undefined) w.process(s.pick)
    if (s.pickMachine !== undefined) w.name(s.pickMachine, BUILDINGS)
    if (s.units) {
      w.varint(s.units.count)
      w.varint(s.units.of)
    }
    if (s.stack !== undefined) w.number(s.stack)
    if (s.height !== undefined) w.number(s.height)
    if (s.catalysts) w.names(s.catalysts)
    if (s.altarOutputs) w.names(s.altarOutputs)
    writeRows(w, row.children, false)
  }
}

function readRows(r: Reader, plan: Plan, path: string, count: number) {
  for (let i = 0; i < count; i++) {
    const step = readStep(r, !path)
    const id = path ? `${path}/${step}` : step
    const header = r.varint()
    const flags = Math.floor(header / CHILD_BITS)
    let children = header % CHILD_BITS
    if (children === MANY_CHILDREN) children += r.varint()
    if (flags & ROW_PICK) (plan.branches ??= {})[id] = { producer: r.process() }
    if (flags & ROW_PICK_MACHINE) {
      const machine = r.name(BUILDINGS)
      // A machine is only kept with a pick (a row can't pick a machine alone).
      if (plan.branches?.[id]) plan.branches[id].machine = machine
    }
    if (flags & ROW_ROUND_UP) (plan.roundUp ??= []).push(id)
    if (flags & ROW_BUILT) (plan.built ??= []).push(id)
    if (flags & ROW_UNITS) (plan.units ??= {})[id] = { count: r.varint(), of: r.varint() }
    if (flags & ROW_STACK) (plan.rowStacks ??= {})[id] = r.number()
    if (flags & ROW_HEIGHT) (plan.rowHeights ??= {})[id] = r.number()
    if (flags & ROW_CATALYSTS) (plan.rowCatalysts ??= {})[id] = r.names()
    if (flags & ROW_ALTAR_OUTPUTS) (plan.altarOutputs ??= {})[id] = r.names()
    if (flags & ROW_MIXED) (plan.mixedFeed ??= {})[id] = true
    if (flags & ROW_NOT_MIXED) (plan.mixedFeed ??= {})[id] = false
    readRows(r, plan, id, children)
  }
}

// ---- Separations: `at` is a row path, written as its steps ----

function writePath(w: Writer, id: string) {
  const steps = id.split('/')
  w.varint(steps.length)
  steps.forEach((step, i) => writeStep(w, step, i === 0))
}

const readPath = (r: Reader) => Array.from({ length: r.varint() }, (_, i) => readStep(r, i === 0)).join('/')

// ---- The plan ----

/**
 * The plan's bytes. Its saved cauldron recipes come from `saved`; `tier` is the research tier it's
 * set up at (absent = every tier). Legacy fields aren't written.
 */
export function encodePlanBytes(plan: Plan, saved: SavedRecipe[], tier?: number): Uint8Array {
  const w = new Writer(saved)
  const producers = Object.entries(plan.producers)
  const machines = Object.entries(plan.machines)
  const supply = Object.entries(plan.busSupply ?? {})
  w.byte(FORMAT)
  w.text(plan.name)
  w.varint(tier ?? 0)
  w.varint(
    (plan.autoOrganize ? PLAN_AUTO_ORGANIZE : 0) |
      (plan.loopFeedback ? PLAN_LOOP_FEEDBACK : 0) |
      (producers.length ? PLAN_PRODUCERS : 0) |
      (machines.length ? PLAN_MACHINES : 0) |
      (plan.feedbackItems?.length ? PLAN_FEEDBACK : 0) |
      (plan.altarItems?.length ? PLAN_ALTAR : 0) |
      (plan.separate?.length ? PLAN_SEPARATE : 0) |
      (supply.length ? PLAN_SUPPLY : 0),
  )

  w.varint(plan.targets.length)
  for (const t of plan.targets) {
    w.name(t.item)
    const unit = Math.max(0, UNITS.indexOf(t.unit))
    w.byte(
      unit |
        (t.feedback !== undefined ? TARGET_FEEDBACK : 0) |
        (t.feedback ? TARGET_FEEDS_BACK : 0) |
        (t.consumes !== undefined ? TARGET_CONSUMES : 0),
    )
    if (t.consumes !== undefined) w.name(t.consumes)
    w.number(t.rate)
  }

  if (producers.length) {
    w.varint(producers.length)
    for (const [item, p] of producers) {
      w.name(item)
      w.process(p)
    }
  }
  if (machines.length) {
    w.varint(machines.length)
    for (const [process, machine] of machines) {
      w.process(process)
      w.name(machine, BUILDINGS)
    }
  }
  if (plan.feedbackItems?.length) w.names(plan.feedbackItems)
  if (plan.altarItems?.length) w.names(plan.altarItems)
  if (plan.separate?.length) {
    w.varint(plan.separate.length)
    for (const s of plan.separate) {
      w.name(s.item)
      w.byte((s.anchor !== undefined ? SEPARATE_ANCHOR : 0) | (s.at !== undefined ? SEPARATE_AT : 0))
      if (s.anchor !== undefined) w.name(s.anchor)
      if (s.at !== undefined) writePath(w, s.at)
    }
  }
  if (supply.length) {
    w.varint(supply.length)
    for (const [item, n] of supply) {
      w.name(item)
      w.number(n)
    }
  }

  const rows = rowTree(plan).children
  w.varint(rows.size)
  writeRows(w, rows, true)
  return Uint8Array.from(w.bytes)
}

/**
 * The plan in a code's bytes, as a backup holding just it, the saved recipes it uses and the
 * research tier it was set up at.
 */
export function decodePlanBytes(bytes: Uint8Array): Backup {
  const r = new Reader(bytes)
  const format = r.byte()
  if (format !== FORMAT) throw new Error(`share code format ${format} isn't one this version reads`)
  const plan: Plan = { id: '', name: r.text(), targets: [], producers: {}, machines: {} }
  const tier = r.varint()
  const flags = r.varint()
  if (flags & PLAN_AUTO_ORGANIZE) plan.autoOrganize = true
  if (flags & PLAN_LOOP_FEEDBACK) plan.loopFeedback = true

  const targets = r.varint()
  for (let i = 0; i < targets; i++) {
    const t: PlanTarget = { item: r.name(), rate: 0 }
    const b = r.byte()
    const unit = UNITS[b & 7]
    if (unit) t.unit = unit
    if (b & TARGET_FEEDBACK) t.feedback = Boolean(b & TARGET_FEEDS_BACK)
    if (b & TARGET_CONSUMES) t.consumes = r.name()
    t.rate = r.number()
    plan.targets.push(t)
  }

  if (flags & PLAN_PRODUCERS) {
    const count = r.varint()
    for (let i = 0; i < count; i++) {
      const item = r.name()
      plan.producers[item] = r.process()
    }
  }
  if (flags & PLAN_MACHINES) {
    const count = r.varint()
    for (let i = 0; i < count; i++) {
      const process = r.process()
      plan.machines[process] = r.name(BUILDINGS)
    }
  }
  if (flags & PLAN_FEEDBACK) plan.feedbackItems = r.names()
  if (flags & PLAN_ALTAR) plan.altarItems = r.names()
  if (flags & PLAN_SEPARATE) {
    const count = r.varint()
    plan.separate = []
    for (let i = 0; i < count; i++) {
      const s: Separation = { item: r.name() }
      const b = r.byte()
      if (b & SEPARATE_ANCHOR) s.anchor = r.name()
      if (b & SEPARATE_AT) s.at = readPath(r)
      plan.separate.push(s)
    }
  }
  if (flags & PLAN_SUPPLY) {
    const count = r.varint()
    plan.busSupply = {}
    for (let i = 0; i < count; i++) {
      const item = r.name()
      plan.busSupply[item] = r.number()
    }
  }

  readRows(r, plan, '', r.varint())
  if (!r.done) throw new Error('share code has bytes left over')
  return { version: 1, savedRecipes: r.recipes, plans: [plan], ...(tier && { progress: { upgrades: {}, tier } }) }
}

// ---- Text ----

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(code: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(code)) throw new Error('share code has characters it can’t have')
  const binary = atob(code.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

// ---- Compression: the format byte's top bit says the rest is deflated ----

const DEFLATED = 0x80
/** No plan comes near this: past it, a code is a deflate bomb rather than a plan. */
const MAX_INFLATED = 1 << 20

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > MAX_INFLATED) {
      await reader.cancel()
      throw new Error('share code is too big')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(length)
  let at = 0
  for (const c of chunks) out.set(c, (at += c.length) - c.length)
  return out
}

/** The plan's share code: deflated when that's shorter. */
export async function encodePlan(plan: Plan, saved: SavedRecipe[], tier?: number): Promise<string> {
  const bytes = encodePlanBytes(plan, saved, tier)
  const body = await deflate(bytes.subarray(1))
  if (body.length + 1 >= bytes.length) return toBase64Url(bytes)
  const deflated = new Uint8Array(body.length + 1)
  deflated[0] = bytes[0] | DEFLATED
  deflated.set(body, 1)
  return toBase64Url(deflated)
}

/** The plan in a share code, as a backup holding it, its saved recipes and its tier; throws on a bad code. */
export async function decodePlan(code: string): Promise<Backup> {
  const bytes = fromBase64Url(code)
  if (!bytes.length || !(bytes[0] & DEFLATED)) return decodePlanBytes(bytes)
  const body = await inflate(bytes.subarray(1))
  const whole = new Uint8Array(body.length + 1)
  whole[0] = bytes[0] & ~DEFLATED
  whole.set(body, 1)
  return decodePlanBytes(whole)
}
