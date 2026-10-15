// Our own build of HiGHS, with only the LP solvers these plans use: under half the package's download
// (see tools/highs). Vite bundles and fingerprints the .wasm.
import highsLoader from '../vendor/highs/highs.mjs'
import wasmUrl from '../vendor/highs/highs.wasm?url'

/**
 * Linear programs are solved with HiGHS (University of Edinburgh; the solver behind SciPy's
 * linprog) compiled to WebAssembly. It replaced yalps, whose simplex produced phantom
 * over-production or false "infeasible" results on badly scaled plans (a Flax nursery craft moves
 * one item in 0.004 s while heat rows run to tens of thousands of P).
 */
// In the browser (the solver's worker) it loads from the bundle; under Node (tests) it finds its own.
const highs = await highsLoader(
  typeof location === 'undefined' ? undefined : { locateFile: (file) => (file.endsWith('.wasm') ? wasmUrl : file) },
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

/** A number in the LP's text: one that isn't finite is a mistake in the model, not something to solve. */
const num = (v: number, what: () => string) => {
  if (!Number.isFinite(v)) throw new Error(`LP ${what()} is ${v}`)
  return String(v)
}

/**
 * Minimizes Σ cost·x subject to the equalities, with every column ≥ 0. Throws on a mistake in the
 * model (a coefficient on a row it doesn't have, a number that isn't finite) rather than solving
 * something else.
 */
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
      const term = `${v < 0 ? '-' : '+'} ${num(Math.abs(v), () => `coefficient ${c} × ${key}`)} ${id}`
      if (key === 'cost') objective.push(term)
      else {
        const row = rows.get(key)
        if (!row) throw new Error(`LP column ${c} has a coefficient on unknown row ${key}`)
        row.push(term)
      }
    }
  }
  const text = [
    'Minimize',
    ` obj: ${objective.length ? objective.join(' ') : '0 x0'}`,
    'Subject To',
    ...rowNames.map((r) => ` ${rowId.get(r)}: ${(rows.get(r) ?? []).join(' ') || '0 x0'} = ${num(lp.equalities[r], () => `row ${r}`)}`),
    'End',
  ].join('\n')

  try {
    // Feasibility tolerances 100× tighter than HiGHS's defaults let the solver hold each priority pass
    // to a 100× smaller room (it needs about 10× its tolerance; see `solveRound`): less noise. 1e-10
    // is past what these plans' scaling allows.
    const options = { output_flag: false, primal_feasibility_tolerance: 1e-9, dual_feasibility_tolerance: 1e-9 }
    let result = highs.solve(text, options)
    // A priority pass whose optimum is near 0 (a millionth of an item, priced up to 10⁶) can solve
    // with a primal-dual objective gap that's tiny yet large next to the objective: HiGHS then calls
    // it "Unknown" (and returns no values) though its solution meets every row. Checking that gap
    // more loosely accepts the same solution (HiGHS takes the option; the package's types leave it out).
    const loose = { ...options, optimality_tolerance: 1e-3 }
    if (result.Status === 'Unknown') result = highs.solve(text, loose)
    if (result.Status !== 'Optimal') return { status: 'infeasible', message: `Solver status: ${result.Status}`, values: new Map() }
    const values = new Map<string, number>()
    for (const c of colNames) values.set(c, result.Columns[colId.get(c)!]?.Primal ?? 0)
    return { status: 'optimal', values }
  } catch (e) {
    return { status: 'error', message: String(e), values: new Map() }
  }
}
