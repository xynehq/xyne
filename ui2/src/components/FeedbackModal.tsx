// Modal that opens when a user clicks the thumbs-up or thumbs-down action on
// an assistant message. The thumb selection pre-fills `rating`; the user can
// optionally flip it inside the modal, pick category chips, write a freeform
// comment, and toggle the share-chat-for-eval consent.
//
// Mirrors v1's FeedbackModal in intent but rebuilt against ui2's design
// tokens + the portal-based NameDialog scrim/animation pattern. All silent
// context (model, latency, retrieved sources, etc.) is snapshotted on the
// server from the message + run record — the client only sends what the user
// explicitly chose.

import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Loader2, ThumbsDown, ThumbsUp, X } from "lucide-react"
import { cn } from "@/lib/utils"

export type FeedbackRating = "like" | "dislike"

export type FeedbackSubmission = {
  rating: FeedbackRating
  tags: string[]
  comment?: string
  shareChat: boolean
}

type Props = {
  open: boolean
  initialRating: FeedbackRating
  onSubmit: (payload: FeedbackSubmission) => Promise<void>
  onClose: () => void
}

// Predefined option chips. Same wording as v1 so users who've rated before
// see familiar prompts.
const OPTIONS: Record<FeedbackRating, readonly string[]> = {
  like: [
    "Response time was quick",
    "Answer was accurate and to the point",
    "Citations were relevant and added value",
    "Reasoning was clear",
  ],
  dislike: [
    "No response was received or an error occurred",
    "Response took too long",
    "Answer was entirely incorrect",
    "Citations were inaccurate or irrelevant",
    "Reasoning was unclear",
  ],
} as const

export function FeedbackModal({
  open,
  initialRating,
  onSubmit,
  onClose,
}: Props): JSX.Element | null {
  const [rating, setRating] = useState<FeedbackRating>(initialRating)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [comment, setComment] = useState<string>("")
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const titleId = useId()
  const descId = useId()

  // Reset on open. Without this, a previous submission's state would leak
  // back the next time the same modal instance is reused.
  useEffect((): void => {
    if (open) {
      setRating(initialRating)
      setSelected(new Set())
      setComment("")
      setBusy(false)
      setError(null)
    }
  }, [open, initialRating])

  // ESC closes unless we're mid-submit.
  useEffect((): (() => void) | undefined => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    return (): void => {
      window.removeEventListener("keydown", onKey)
    }
  }, [open, busy, onClose])

  if (!open || typeof document === "undefined") {
    return null
  }

  const isPositive = rating === "like"
  const options = OPTIONS[rating]

  const toggleOption = (opt: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(opt)) {
        next.delete(opt)
      } else {
        next.add(opt)
      }
      return next
    })
  }

  const handleSubmit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const payload: FeedbackSubmission = {
        rating,
        tags: Array.from(selected),
        shareChat: true,
      }
      const trimmed = comment.trim()
      if (trimmed.length > 0) payload.comment = trimmed
      await onSubmit(payload)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong"
      setError(msg)
      setBusy(false)
    }
  }

  const onBackdropMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget && !busy) {
      onClose()
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="presentation"
      onMouseDown={onBackdropMouseDown}
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className={cn(
          "relative z-10 w-full max-w-[520px] overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-2xl",
          "animate-scale-in",
        )}
        onMouseDown={(e) => {
          e.stopPropagation()
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 pb-2 pt-4">
          <div className="min-w-0">
            <h2
              id={titleId}
              className="text-[15px] font-semibold leading-tight text-foreground"
            >
              {isPositive
                ? "Thanks for letting us know!"
                : "Sorry your experience wasn't the best"}
            </h2>
            <p
              id={descId}
              className="mt-1 text-[12.5px] leading-snug text-muted-foreground"
            >
              {isPositive
                ? "Your feedback helps us keep the good stuff coming."
                : "Sharing your feedback helps us improve for everyone."}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>

        {/* Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
          className="px-5 pb-4 pt-2"
        >
          {/* Rating toggle — pre-selected, user can flip */}
          <div className="mb-4 flex items-center gap-1.5">
            <RatingPill
              icon={ThumbsUp}
              label="Helpful"
              active={rating === "like"}
              disabled={busy}
              onClick={() => setRating("like")}
            />
            <RatingPill
              icon={ThumbsDown}
              label="Not helpful"
              active={rating === "dislike"}
              disabled={busy}
              onClick={() => setRating("dislike")}
            />
          </div>

          {/* Predefined option chips */}
          <p className="mb-2 text-[12px] font-medium text-foreground">
            {isPositive
              ? "What worked well? (optional)"
              : "What went wrong? (optional)"}
          </p>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {options.map((opt) => {
              const isSelected = selected.has(opt)
              return (
                <button
                  key={opt}
                  type="button"
                  disabled={busy}
                  onClick={() => toggleOption(opt)}
                  className={cn(
                    "inline-flex items-center rounded-full border px-2.5 py-1 text-[11.5px] transition disabled:opacity-50",
                    isSelected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-surface text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                  aria-pressed={isSelected}
                >
                  {opt}
                </button>
              )
            })}
          </div>

          {/* Free-text comment */}
          <label className="mb-1.5 block text-[12px] font-medium text-foreground">
            Add details (optional)
          </label>
          <textarea
            ref={textareaRef}
            value={comment}
            disabled={busy}
            maxLength={4000}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What would have made this better?"
            className={cn(
              "block w-full resize-y rounded-lg border bg-surface px-3 py-2 text-[13px] leading-relaxed text-foreground transition placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 disabled:opacity-60",
              "min-h-[160px] border-border focus:border-ring focus:ring-ring/30",
            )}
          />

          {error ? (
            <p
              role="alert"
              className="mt-3 text-[11.5px] leading-snug text-red-600 dark:text-red-400"
            >
              {error}
            </p>
          ) : null}

          {/* Footer */}
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="inline-flex h-8 items-center rounded-md px-3 text-[12.5px] text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition",
                "bg-primary text-primary-foreground hover:opacity-90",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {busy ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  strokeWidth={1.75}
                />
              ) : null}
              Submit feedback
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}

function RatingPill({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: typeof ThumbsUp
  label: string
  active: boolean
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  const Glyph = icon
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition disabled:opacity-50",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border bg-surface text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      <Glyph className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
      {label}
    </button>
  )
}
