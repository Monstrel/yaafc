

/** A bookmark: use this row's setup as my default. */
/** A bookmark: outlined, or filled for a saved default. */
export function BookmarkIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ verticalAlign: '-2px' }}
    >
      <path d="M4 2.5h8a.5.5 0 0 1 .5.5v10.5L8 10.5l-4.5 3V3a.5.5 0 0 1 .5-.5Z" />
    </svg>
  )
}

/** Boxes joined left to right: a row's flow chart. */
export function FlowIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ verticalAlign: '-2px' }}
    >
      <rect x="1.5" y="2" width="4" height="3.5" rx="1" />
      <rect x="1.5" y="10.5" width="4" height="3.5" rx="1" />
      <rect x="10.5" y="6.25" width="4" height="3.5" rx="1" />
      <path d="M5.5 3.75h1.5a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H5.5M8.5 8h2" />
    </svg>
  )
}

/** A box with an arrow leaving it (build separately), or coming back in (merge back). */
export function BoxArrowIcon({ inward = false }: { inward?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11.5 9.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3.5" />
      <path d="M13.5 2.5 7.5 8.5" />
      <path d={inward ? 'M7.5 4.5v4h4' : 'M9.5 2.5h4v4'} />
    </svg>
  )
}
