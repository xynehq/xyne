import { useState, type ReactNode } from "react"
import { X } from "lucide-react"

type Props = {
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: "danger" | "default"
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

export function InlineConfirmRow({
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  onCancel,
}: Props): JSX.Element {
  const [pending, setPending] = useState(false)
  const bg =
    tone === "danger" ? "bg-destructive/[0.08]" : "bg-secondary"
  const btn =
    tone === "danger"
      ? "bg-destructive text-destructive-foreground"
      : "bg-primary text-primary-foreground"

  return (
    <div
      className={
        "flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] " + bg
      }
    >
      <span className="min-w-0 flex-1 truncate text-foreground/80">
        {message}
      </span>
      <button
        type="button"
        onClick={onCancel}
        disabled={pending}
        aria-label={cancelLabel}
        title={cancelLabel}
        className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground disabled:opacity-50"
      >
        <X className="h-3.5 w-3.5" aria-hidden strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={() => {
          setPending(true)
          void (async (): Promise<void> => {
            try {
              await onConfirm()
            } finally {
              setPending(false)
            }
          })()
        }}
        disabled={pending}
        className={
          "inline-flex h-6 items-center rounded-md px-2 text-[11.5px] font-medium transition-opacity hover:opacity-90 disabled:opacity-60 " +
          btn
        }
      >
        {pending ? "…" : confirmLabel}
      </button>
    </div>
  )
}
