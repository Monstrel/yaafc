import { useEffect, useRef, useState } from 'react'
import { planTitle } from '../../lib/planName'
import { noun } from '../../lib/plural'
import { pageHref } from '../../lib/router'
import { shareLink, type Shared } from '../../lib/shareLink'
import type { MyDefaults, Plan, Progress, SavedRecipe } from '../../lib/types'

/** A link that adds a copy of the plan for whoever opens it, ready to copy. */
export function ShareDialog({
  plan,
  saved,
  myDefaults,
  progress,
  onClose,
}: {
  plan: Plan
  saved: SavedRecipe[]
  myDefaults: MyDefaults
  progress: Progress
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const [link, setLink] = useState<Shared | null>(null)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => dialog.current?.showModal(), [])
  useEffect(() => {
    let live = true
    shareLink(new URL(pageHref('planner'), location.href).href, plan, saved, myDefaults, progress).then(
      (l) => live && setLink(l),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [plan, saved, myDefaults, progress])

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link.url)
      setCopied(true)
    } catch {
      // No clipboard here (or not allowed): select it for copying by hand.
      field.current?.select()
    }
  }

  return (
    <dialog ref={dialog} className="tree-dialog share-dialog" onClose={onClose}>
      <h3>Share “{planTitle(plan)}”</h3>
      <p>
        Anyone who opens this link can add a copy of the plan, as it is now, to their own plans
        {link?.recipes ? (
          <>
            , with the {link.recipes} saved Cauldron {noun(link.recipes, 'recipe')} it uses
          </>
        ) : null}
        .
      </p>
      {failed ? (
        <p className="warn-text">This plan couldn’t be put in a link.</p>
      ) : (
        <input
          ref={field}
          className="share-link"
          readOnly
          value={link?.url ?? 'Making the link…'}
          aria-label="Link to the plan"
          onFocus={(e) => e.target.select()}
        />
      )}
      <div className="tree-dialog-actions">
        <button type="button" className="primary" autoFocus onClick={copy} disabled={!link}>
          {copied ? '✓ Copied' : 'Copy link'}
        </button>
        <button type="button" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      <p className="tree-dialog-tip">
        Every row keeps the recipe and machine you see here, whatever their own default recipes. It runs at their
        upgrade levels, and your build checklist isn’t included.
      </p>
    </dialog>
  )
}
