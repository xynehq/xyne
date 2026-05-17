// Tiny no-library toast. Renders into document.body via a portal so it
// floats above the rest of the app. Use via the `toast` singleton.

import { createPortal } from "react-dom"
import { useEffect, useState } from "react"
import { CheckCircle2, XCircle, X } from "lucide-react"

type Kind = "success" | "error"
type ToastEntry = { id: number; kind: Kind; text: string }

type Listener = (entries: ToastEntry[]) => void

let nextId = 1
let entries: ToastEntry[] = []
const listeners = new Set<Listener>()

const emit = (): void => {
  for (const l of listeners) {
    l(entries)
  }
}

const push = (kind: Kind, text: string): void => {
  const id = nextId
  nextId += 1
  entries = [...entries, { id, kind, text }]
  emit()
  // Auto-dismiss after 4s. User can also click x.
  setTimeout(() => {
    entries = entries.filter((e) => e.id !== id)
    emit()
  }, 4000)
}

export const toast = {
  success: (text: string): void => {
    push("success", text)
  },
  error: (text: string): void => {
    push("error", text)
  },
}

export function ToastHost(): JSX.Element | null {
  const [items, setItems] = useState<ToastEntry[]>(entries)
  useEffect((): (() => void) => {
    const listener: Listener = (next): void => {
      setItems(next)
    }
    listeners.add(listener)
    return (): void => {
      listeners.delete(listener)
    }
  }, [])
  if (typeof document === "undefined") {
    return null
  }
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {items.map((e) => (
        <div
          key={e.id}
          className={
            "pointer-events-auto flex w-80 max-w-[90vw] items-start gap-2 rounded-xl border px-3 py-2 text-[13px] shadow-lg backdrop-blur-md " +
            (e.kind === "success"
              ? "border-emerald-200 bg-emerald-50/95 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/80 dark:text-emerald-100"
              : "border-red-200 bg-red-50/95 text-red-900 dark:border-red-900/40 dark:bg-red-950/80 dark:text-red-100")
          }
        >
          {e.kind === "success" ? (
            <CheckCircle2 className="mt-px h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
          ) : (
            <XCircle className="mt-px h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
          )}
          <span className="min-w-0 flex-1 break-words">{e.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              entries = entries.filter((x) => x.id !== e.id)
              emit()
            }}
            className="flex-shrink-0 opacity-60 transition hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}
