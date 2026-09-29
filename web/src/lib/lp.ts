import highsLoader from 'highs'
// The package doesn't export its .wasm, so import it by path; Vite bundles and fingerprints it.
import wasmUrl from '../../node_modules/highs/build/highs.wasm?url'

/**
 * Linear programs are solved with HiGHS (University of Edinburgh; the solver behind SciPy's
 * linprog) compiled to WebAssembly. It replaced yalps, whose simplex produced phantom
 * over-production or false "infeasible" results on badly scaled plans (a Flax nursery craft moves
 * one item in 0.004 s while heat rows run to tens of thousands of P).
 */
const highs = await highsLoader(
  typeof window === 'undefined' ? undefined : { locateFile: (file) => (file.endsWith('.wasm') ? wasmUrl : file) },
)

export interface LinearProgram {
  /** Row name → required value (all rows are equalities). */
  equalities: Record<string, number>
  /** Column name → coefficients per row, plus its objective cost under `cost`. Columns are ≥ 0. */
  columns: Record<string, Record<string, number>>
}

export interface LpSolution {
  status: 'optimal' | 'infeasible' | 'error'
  message?: string
  values: Map<string, number>
}

const num = (v: number) => (Number.isFinite(v) ? String(v) : '0')

/** Minimizes Σ cost·x subject to the equalities, with every column ≥ 0. */
export function solveLP(lp: LinearProgram): LpSolution {
  // LP-format identifiers can't contain the ':' and '@' our names use, so map them.
  const rowNames = Object.keys(lp.equalities)
  const rowId = new Map(rowNames.map((r, i) => [r, `r${i}`]))
  const colNames = Object.keys(lp.columns)
  const colId = new Map(colNames.map((c, i) => [c, `x${i}`]))

  const objective: string[] = []
  const rows = new Map<string, string[]>(rowNames.map((r) => [r, []]))
  for (const c of colNames) {
    const id = colId.get(c)!
    for (const [key, v] of Object.entries(lp.columns[c])) {
      if (!v) continue
      const term = `${v < 0 ? '-' : '+'} ${num(Math.abs(v))} ${id}`
      if (key === 'cost') objective.push(term)
      else rows.get(key)?.push(term)
    }
  }
  const text = [
    'Minimize',
    ` obj: ${objective.length ? objective.join(' ') : '0 x0'}`,
    'Subject To',
    ...rowNames.map((r) => ` ${rowId.get(r)}: ${(rows.get(r) ?? []).join(' ') || '0 x0'} = ${num(lp.equalities[r])}`),
    'End',
  ].join('\n')

  try {
    const result = highs.solve(text, { output_flag: false })
    if (result.Status !== 'Optimal') return { status: 'infeasible', message: `Solver status: ${result.Status}`, values: new Map() }
    const values = new Map<string, number>()
    for (const c of colNames) values.set(c, result.Columns[colId.get(c)!]?.Primal ?? 0)
    return { status: 'optimal', values }
  } catch (e) {
    return { status: 'error', message: String(e), values: new Map() }
  }
}
