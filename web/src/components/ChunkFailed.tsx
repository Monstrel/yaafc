import { useEffect, useRef } from 'react'

const MESSAGE =
  "This part of the calculator couldn't be downloaded. Most likely a new version went live since this page was opened: reload to get it. Your plans and recipes are kept."

/** In place of a page whose code couldn't be downloaded. */
export function PageFailed() {
  return (
    <div className="panel">
      <p>{MESSAGE}</p>
      <button type="button" className="primary" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  )
}

/** In place of a dialog whose code couldn't be downloaded: says so in a dialog of its own. */
export function DialogFailed({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  return (
    <dialog ref={ref} className="tree-dialog" onClose={onClose}>
      <p>{MESSAGE}</p>
      <div className="tree-dialog-actions">
        <button type="button" className="primary" onClick={() => location.reload()}>
          Reload
        </button>
        <button type="button" onClick={() => ref.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  )
}
