import type { ProcessCatalog } from '../lib/processes'
import type { TreeNode } from '../lib/tree'
import type { ReuseOption } from './ProducerSelect'

/**
 * Rows taking by-products, set not to, or offered some by rows making their own can switch taking
 * them first on or off; the producer makes the rest either way.
 */
export function reuseOption(
  node: TreeNode,
  separateByproducts: Map<string, string[]>,
  onReuse: (item: string, on: boolean, row?: string) => void,
): ReuseOption | undefined {
  const separately = separateByproducts.get(node.item)
  if (!(node.fromByproduct > 0 || !node.reuse || node.reuseChosen || separately)) return undefined
  return {
    on: node.reuse && (node.fromByproduct > 0 || node.reuseChosen),
    covered: node.kind === 'byproduct',
    sources:
      node.fromByproduct > 0
        ? node.byproductSources.map((s) => s.label).join(', ')
        : (separately?.map((s) => `${s} (made separately)`).join(', ') ?? ''),
    onChange: (on, everywhere) => onReuse(node.item, on, everywhere ? undefined : node.id),
  }
}

/** A row offers a pick of how its item is had. */
export const choosable = (node: TreeNode, catalog: ProcessCatalog, reuse: ReuseOption | undefined) =>
  !!node.producer && ((catalog.byProduct.get(node.item)?.length ?? 0) > 0 || !!reuse)
