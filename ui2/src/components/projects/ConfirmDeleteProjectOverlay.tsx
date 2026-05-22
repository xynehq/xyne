// Portal-rendered confirmation overlay for soft-deleting a project. Reused
// by both the project detail page (top-right ⋯ → Delete) and the sidebar
// project row's context menu so the wording + tone stay consistent.

import { useState } from "react"
import { createPortal } from "react-dom"

type Props = {
  name: string
  onCancel: () => void
  onConfirm: () => Promise<void>
}

export function ConfirmDeleteProjectOverlay({
  name,
  onCancel,
  onConfirm,
}: Props): JSX.Element | null {
  const [busy, setBusy] = useState(false)
  if (typeof document === "undefined") return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        type="button"
        aria-label="Cancel"
        aria-hidden
        tabIndex={-1}
        disabled={busy}
        onClick={busy ? undefined : onCancel}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-[420px] overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-2xl animate-scale-in"
      >
        <div className="px-5 pt-4">
          <h2 className="text-[15px] font-semibold text-foreground">
            Delete <span className="text-foreground">{name}</span>?
          </h2>
          <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground">
            Your chats will stay — they just won&apos;t be grouped here anymore.
          </p>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2 px-5 pb-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-md px-3 text-[12.5px] text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={(): void => {
              setBusy(true)
              void onConfirm().catch((): void => {
                setBusy(false)
              })
            }}
            className="inline-flex h-8 items-center rounded-md bg-destructive px-3 text-[12.5px] font-medium text-destructive-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
