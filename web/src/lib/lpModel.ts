import type { LinearProgram } from './lp'

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
