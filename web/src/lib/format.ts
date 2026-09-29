/** Compact number for rates: 3 significant digits, thousands grouped. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '–'
  const a = Math.abs(n)
  if (a === 0) return '0'
  if (a >= 1000) return Math.round(n).toLocaleString()
  if (a >= 100) return n.toFixed(0)
  if (a >= 10) return n.toFixed(1).replace(/\.0$/, '')
  if (a >= 0.01) return n.toFixed(2).replace(/\.?0+$/, '')
  return n.toPrecision(2)
}

export function fmtSeconds(s: number): string {
  return s >= 100 ? `${Math.round(s)}s` : `${fmt(s)}s`
}
