import { solveLP, type LinearProgram } from './lp'

/**
 * A linear program being built: equality rows, columns (all ≥ 0) with their coefficients and cost,
 * and the priority passes each column counts toward (see `solveStaged`). Rows and columns are
 * named once: naming one twice is a mistake in the model, and throws.
 */
export class LpModel implements LinearProgram {
  readonly equalities: Record<string, number> = {}
  readonly columns: Record<string, Record<string, number>> = {}
  /** Per priority pass, the weight of each column that counts toward it, in the order they were weighed. */
  readonly passes = new Map<string, Map<string, number>>()

  /** Adds a row: its coefficients sum to `value`. */
  row(name: string, value = 0) {
    if (name in this.equalities) throw new Error(`LP row ${name} added twice`)
    this.equalities[name] = value
  }

  hasRow = (name: string) => name in this.equalities

  /** Adds to what a row sums to. */
  raise(name: string, by: number) {
    if (!(name in this.equalities)) throw new Error(`LP row ${name} raised before it was added`)
    this.equalities[name] += by
  }

  /** Adds a column with its coefficients (by row) and cost; returns its coefficients, to add to. */
  column(name: string, coefficients: Record<string, number>, cost: number): Record<string, number> {
    if (name in this.columns) throw new Error(`LP column ${name} added twice`)
    const col = { ...coefficients, cost }
    this.columns[name] = col
    return col
  }

  hasColumn = (name: string) => name in this.columns

  /** Sets a column's coefficient on a row. */
  set(column: string, row: string, value: number) {
    this.col(column)[row] = value
  }

  /** Adds to a column's coefficient on a row (nothing, for 0). */
  add(column: string, row: string, value: number) {
    if (!value) return
    const col = this.col(column)
    col[row] = (col[row] ?? 0) + value
  }

  /** Counts a column toward a priority pass with a weight. */
  weigh(pass: string, column: string, weight: number) {
    this.col(column)
    let weights = this.passes.get(pass)
    if (!weights) this.passes.set(pass, (weights = new Map()))
    weights.set(column, weight)
  }

  private col(name: string) {
    const col = this.columns[name]
    if (!col) throw new Error(`LP column ${name} used before it was added`)
    return col
  }
}

/** How much a priority pass was held with (see `solveStaged`). */
export interface HeldPass {
  /** What its weighed sum could still grow by: the room it was held with. */
  room: number
  /** The least weight of a column in it. */
  minWeight: number
}

export type StagedSolution =
  | { status: 'optimal'; values: Map<string, number>; held: Map<string, HeldPass> }
  | { status: 'infeasible' | 'error'; message?: string }

/**
 * Solves the model in priority passes, then for its costs. Each pass (in `order`) minimizes the
 * weighed sum of its columns alone; once solved it's held there, with `room` relative to what it
 * reached and absolute (the LP's tolerance needs some, or a later pass can find no solution), and
 * the next pass is solved within it. A pass weighing no columns is skipped. Adds each pass's row
 * (and a slack column for its room) to the model.
 */
export function solveStaged(m: LpModel, order: string[], room: number): StagedSolution {
  const held = new Map<string, HeldPass>()
  for (const pass of order) {
    const weights = m.passes.get(pass)
    if (!weights?.size) continue
    const phase = solveLP({
      equalities: m.equalities,
      columns: Object.fromEntries(Object.entries(m.columns).map(([name, { cost: _cost, ...rows }]) => [name, { ...rows, cost: weights.get(name) ?? 0 }])),
    })
    if (phase.status !== 'optimal') return { status: phase.status, message: phase.message }
    let total = 0
    for (const [name, x] of phase.values) total += x * (weights.get(name) ?? 0)
    const allowed = total * room + room
    m.row(pass, total + allowed)
    held.set(pass, { room: allowed, minWeight: Math.min(...weights.values()) })
    for (const [name, w] of weights) m.set(name, pass, w)
    m.column(`slack:${pass}`, { [pass]: 1 }, 0)
  }
  const solution = solveLP(m)
  if (solution.status !== 'optimal') return { status: solution.status, message: solution.message }
  return { status: 'optimal', values: solution.values, held }
}
