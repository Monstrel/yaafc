import type { ProcessCatalog } from '../lib/processes'
import type { TreeNode } from '../lib/tree'
import type { ReuseInfo } from './ProducerSelect'

/** What other rows' by-products cover of a row, which takes them before its producer makes the rest. */
export function reuseInfo(node: TreeNode): ReuseInfo | undefined {
  if (!(node.fromByproduct > 0)) return undefined
  return { covered: node.kind === 'byproduct', sources: node.byproductSources.map((s) => s.label).join(', ') }
}

/** A row offers a pick of how its item is had. */
export const choosable = (node: TreeNode, catalog: ProcessCatalog, reuse: ReuseInfo | undefined) =>
  !!node.producer && ((catalog.byProduct.get(node.item)?.length ?? 0) > 0 || !!reuse)
