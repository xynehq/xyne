// Small reusable "give this thing a name" dialog. Same component drives New
// Folder + New Collection in the KB route — feature-agnostic so future flows
// (rename, new agent group, etc.) can reuse it.
//
// Behaviour: ESC dismisses, Enter submits (when valid), input autofocuses,
// click outside closes. Trims whitespace before validating. Disables submit
// while the async onSubmit is pending and surfaces server errors inline.

import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Loader2, X } from "lucide-react"
import { cn } from "@/lib/utils"

type Props = {
  open: boolean
  title: string
  description?: string
  label: string
  placeholder?: string
  helper?: string
  submitLabel?: string
  initialValue?: string
  onSubmit: (name: string) => Promise<void> | void
  onClose: () => void
  maxLength?: number
}

export function NameDialog({
  open,
  title,
  description,
  label,
  placeholder,
  helper,
  submitLabel = "Create",
  initialValue = "",
  onSubmit,
  onClose,
  maxLength = 255,
}: Props): JSX.Element | null {
  const [value, setValue] = useState<string>(initialValue)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<boolean>(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const labelId = useId()
  const descId = useId()
  const helperId = useId()
  const errorId = useId()

  // Reset state every time the dialog opens. Without this, a previous error
  // sticks around when the same dialog is reopened.
  useEffect((): void => {
    if (open) {
      setValue(initialValue)
      setError(null)
      setBusy(false)
    }
  }, [open, initialValue])

  // Autofocus the input + select existing text so rename flows let the user
  // overwrite immediately.
  useEffect((): (() => void) | undefined => {
    if (!open) {
      return undefined
    }
    // Defer to next frame so the input is mounted.
    const id = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 10)
    return (): void => {
      window.clearTimeout(id)
    }
  }, [open])

  // ESC closes (unless busy — don't dismiss an in-flight request).
  useEffect((): (() => void) | undefined => {
    if (!open) {
      return undefined
    }
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

  const trimmed = value.trim()
  const isValid = trimmed.length > 0 && trimmed.length <= maxLength

  const handleSubmit = async (): Promise<void> => {
    if (!isValid || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(trimmed)
      // Caller is responsible for closing on success (so it can chain a
      // refresh). We do nothing here.
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong"
      setError(msg)
      setBusy(false)
    }
  }

  // Backdrop click closes; clicks inside the panel stop here.
  const onBackdropMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget && !busy) {
      onClose()
    }
  }

  const describedBy = [description ? descId : null, helper ? helperId : null, error ? errorId : null]
    .filter((x): x is string => x !== null)
    .join(" ")

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="presentation"
      onMouseDown={onBackdropMouseDown}
    >
      {/* Scrim — strong enough to isolate foreground per UX guidance */}
      <div
        aria-hidden
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        aria-describedby={describedBy || undefined}
        className={cn(
          "relative z-10 w-full max-w-[420px] overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-2xl",
          "animate-scale-in",
        )}
        onMouseDown={(e) => {
          e.stopPropagation()
        }}
      >
        <div className="flex items-start justify-between gap-3 px-5 pb-2 pt-4">
          <div className="min-w-0">
            <h2
              id={labelId}
              className="text-[15px] font-semibold leading-tight text-foreground"
            >
              {title}
            </h2>
            {description ? (
              <p
                id={descId}
                className="mt-1 text-[12.5px] leading-snug text-muted-foreground"
              >
                {description}
              </p>
            ) : null}
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

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
          className="px-5 pb-4 pt-2"
        >
          <label
            htmlFor={`${labelId}-input`}
            className="mb-1.5 block text-[12px] font-medium text-foreground"
          >
            {label}
          </label>
          <input
            id={`${labelId}-input`}
            ref={inputRef}
            type="text"
            value={value}
            disabled={busy}
            maxLength={maxLength}
            placeholder={placeholder}
            aria-invalid={error !== null}
            aria-describedby={describedBy || undefined}
            onChange={(e) => {
              setValue(e.target.value)
              if (error) {
                setError(null)
              }
            }}
            className={cn(
              "block w-full rounded-lg border bg-surface px-3 py-2 text-[13.5px] text-foreground transition placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 disabled:opacity-60",
              error
                ? "border-red-400 focus:border-red-500 focus:ring-red-500/30 dark:border-red-700/60"
                : "border-border focus:border-ring focus:ring-ring/30",
            )}
          />

          {error ? (
            <p
              id={errorId}
              role="alert"
              className="mt-1.5 text-[11.5px] leading-snug text-red-600 dark:text-red-400"
            >
              {error}
            </p>
          ) : helper ? (
            <p
              id={helperId}
              className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground"
            >
              {helper}
            </p>
          ) : null}

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
              disabled={!isValid || busy}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition",
                "bg-foreground text-background hover:opacity-90",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              ) : null}
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
