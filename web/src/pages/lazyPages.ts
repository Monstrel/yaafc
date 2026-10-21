import { PageFailed } from '../components/ChunkFailed'
import { lazyChunk } from '../lib/lazyChunk'
import { showsSolve, solveAhead } from '../lib/planModel'
import type { Page } from '../lib/router'

// Each page downloads when it's first opened, so a visit to one part doesn't fetch the rest.
export const HomePage = lazyChunk(() => import('./HomePage').then((m) => m.HomePage), PageFailed)
export const ChangelogPage = lazyChunk(() => import('./ChangelogPage').then((m) => m.ChangelogPage), PageFailed)
export const CauldronPage = lazyChunk(() => import('./CauldronPage').then((m) => m.CauldronPage), PageFailed)
export const SavedPage = lazyChunk(() => import('./SavedPage').then((m) => m.SavedPage), PageFailed)
export const PlannerPage = lazyChunk(() => import('./PlannerPage').then((m) => m.PlannerPage), PageFailed)
export const ReferencePage = lazyChunk(() => import('./ReferencePage').then((m) => m.ReferencePage), PageFailed)
// With three.js, the bulk of its download: no other page needs it.
export const XrayPage = lazyChunk(() => import('./XrayPage').then((m) => m.XrayPage), PageFailed)

const pages: Record<Page, { preload: () => unknown }> = {
  home: HomePage,
  changelog: ChangelogPage,
  cauldron: CauldronPage,
  saved: SavedPage,
  planner: PlannerPage,
  reference: ReferencePage,
  xray: XrayPage,
}

/** Starts downloading a page, and solving the plan for one that shows it, so it's likely there by the time it's opened. */
export function preloadPage(page: Page) {
  void pages[page].preload()
  if (showsSolve(page)) solveAhead()
}
