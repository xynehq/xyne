// Two-field modal for creating or editing a project. Mirrors NameDialog's
// portal + scrim + esc/click-outside behaviour but adds a description field
// alongside the name input. Reused by the sidebar's New-project flow and the
// project detail page's Edit-details flow (mode="edit" + initial values).

import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Loader2, X } from "lucide-react"
import { cn } from "@/lib/utils"

const NAME_MAX = 120
const DESC_MAX = 2000

type Props = {
  open: boolean
  mode: "create" | "edit"
  initialName?: string
  initialDescription?: string | null
  onSubmit: (input: {
    name: string
    description: string | null
  }) => Promise<void> | void
  onClose: () => void
}

export function CreateProjectModal({
  open,
  mode,
  initialName = "",
  initialDescription = "",
  onSubmit,
  onClose,
}: Props): JSX.Element | null {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const labelId = useId()
  const descId = useId()
  const errorId = useId()

  // Reset on every open so a previous error or stale value doesn't linger.
  useEffect((): void => {
    if (open) {
      setName(initialName)
      setDescription(initialDescription ?? "")
      setError(null)
      setBusy(false)
    }
  }, [open, initialName, initialDescription])

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined
    const id = window.setTimeout(() => {
      nameRef.current?.focus()
      nameRef.current?.select()
    }, 10)
    return (): void => {
      window.clearTimeout(id)
    }
  }, [open])

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

  if (!open || typeof document === "undefined") return null

  const trimmedName = name.trim()
  const trimmedDesc = description.trim()
  const isValid =
    trimmedName.length > 0 &&
    trimmedName.length <= NAME_MAX &&
    trimmedDesc.length <= DESC_MAX

  const submit = async (): Promise<void> => {
    if (!isValid || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit({
        name: trimmedName,
        description: trimmedDesc.length > 0 ? trimmedDesc : null,
      })
      // Caller closes on success (it might chain navigation / refresh).
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong"
      setError(msg)
      setBusy(false)
    }
  }

  const onBackdrop = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget && !busy) onClose()
  }

  const title = mode === "create" ? "New project" : "Edit project"
  const submitLabel = mode === "create" ? "Create project" : "Save changes"

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="presentation"
      onMouseDown={onBackdrop}
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        aria-describedby={descId}
        className={cn(
          "relative z-10 w-full max-w-[480px] overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-2xl",
          "animate-scale-in",
        )}
        onMouseDown={(e): void => {
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
            <p
              id={descId}
              className="mt-1 text-[12.5px] leading-snug text-muted-foreground"
            >
              Group related chats together. You can move conversations into a
              project from the sidebar.
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

        <form
          onSubmit={(e): void => {
            e.preventDefault()
            void submit()
          }}
          className="px-5 pb-4 pt-2"
        >
          <label
            htmlFor={`${labelId}-name`}
            className="mb-1.5 block text-[12px] font-medium text-foreground"
          >
            Name
          </label>
          <input
            id={`${labelId}-name`}
            ref={nameRef}
            type="text"
            value={name}
            disabled={busy}
            maxLength={NAME_MAX}
            placeholder="e.g. Quarterly research"
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            onChange={(e): void => {
              setName(e.target.value)
              if (error) setError(null)
            }}
            className={cn(
              "block w-full rounded-lg border bg-surface px-3 py-2 text-[13.5px] text-foreground transition placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 disabled:opacity-60",
              error
                ? "border-red-400 focus:border-red-500 focus:ring-red-500/30 dark:border-red-700/60"
                : "border-border focus:border-ring focus:ring-ring/30",
            )}
          />

          <label
            htmlFor={`${labelId}-desc`}
            className="mb-1.5 mt-3 block text-[12px] font-medium text-foreground"
          >
            Description
            <span className="ml-1 text-muted-foreground/70">(optional)</span>
          </label>
          <textarea
            id={`${labelId}-desc`}
            value={description}
            disabled={busy}
            maxLength={DESC_MAX}
            rows={3}
            placeholder="What's this project for? Anyone you share it with will see this."
            onChange={(e): void => {
              setDescription(e.target.value)
              if (error) setError(null)
            }}
            className="block w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-foreground transition placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
          />

          {error ? (
            <p
              id={errorId}
              role="alert"
              className="mt-2 text-[11.5px] leading-snug text-red-600 dark:text-red-400"
            >
              {error}
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
                "inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] font-medium text-foreground transition hover:bg-secondary",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {busy ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  strokeWidth={1.75}
                />
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
