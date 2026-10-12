
/** Shows a target's row in the production tree. */
export function TargetLink({ index, onShow }: { index: number; onShow: (index: number) => void }) {
  return (
    <button className="tree-link" onClick={() => onShow(index)}>
      Target {index + 1}
    </button>
  )
}
