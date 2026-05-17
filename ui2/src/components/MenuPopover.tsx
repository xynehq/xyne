import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

// Hover-revealed dropdown menu. The trigger is a render-prop so the consumer
// owns the trigger button's exact look (kebab, chevron, avatar, whatever).
//
// Keyboard contract:
//   - Open: focus moves to first menu item.
//   - ↑ / ↓ / Home / End cycle through items.
//   - Enter on a focused item invokes it and closes.
//   - Escape closes and restores focus to the element that was focused
//     before opening (typically the trigger button).
//   - Mousedown outside closes silently (no focus restoration — user clicked
//     elsewhere intentionally).
export type MenuItem = {
  icon?: LucideIcon
  label: string
  onClick: () => void
  tone?: "default" | "danger"
}

type TriggerArgs = {
  open: boolean
  toggle: () => void
}

type Props = {
  trigger: (args: TriggerArgs) => ReactNode
  items: MenuItem[]
  align?: "left" | "right"
  className?: string
}

export function MenuPopover({
  trigger,
  items,
  align = "right",
  className,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false)
    if (restoreFocus && restoreFocusRef.current) {
      const el = restoreFocusRef.current
      requestAnimationFrame(() => {
        el.focus()
      })
    }
    restoreFocusRef.current = null
  }, [])

  const toggle = useCallback((): void => {
    setOpen((prev) => {
      if (!prev) {
        // About to open: remember what had focus so Escape can restore it.
        restoreFocusRef.current = document.activeElement as HTMLElement
      }
      return !prev
    })
  }, [])

  // Outside click closes (no focus restore — focus moves to wherever the user
  // clicked). Escape closes + restores focus to the trigger.
  useEffect((): (() => void) | undefined => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        close(false)
      }
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault()
        close(true)
      }
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, close])

  // Focus the first item on open + handle arrow-key navigation while open.
  useEffect((): (() => void) | undefined => {
    if (!open) return undefined
    const buttons = (): HTMLButtonElement[] =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']",
        ) ?? [],
      )

    buttons()[0]?.focus()

    const onKey = (e: globalThis.KeyboardEvent): void => {
      const list = buttons()
      if (list.length === 0) return
      const idx = list.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === "ArrowDown") {
        e.preventDefault()
        list[(idx + 1 + list.length) % list.length]?.focus()
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        list[(idx - 1 + list.length) % list.length]?.focus()
      } else if (e.key === "Home") {
        e.preventDefault()
        list[0]?.focus()
      } else if (e.key === "End") {
        e.preventDefault()
        list[list.length - 1]?.focus()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className={"relative " + (className ?? "")}>
      {trigger({ open, toggle })}
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-orientation="vertical"
          className={
            "animate-fade-up absolute top-[calc(100%+4px)] z-30 w-40 overflow-hidden rounded-xl border border-border bg-surface-elevated p-1 shadow-lg shadow-foreground/[0.06] " +
            (align === "right" ? "right-0" : "left-0")
          }
        >
          {items.map((item, i) => {
            const Icon = item.icon
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                onClick={(e): void => {
                  e.stopPropagation()
                  // Item handles the action itself — no focus restoration
                  // because the trigger may not exist after the action runs
                  // (e.g. row gets replaced by an inline editor).
                  close(false)
                  item.onClick()
                }}
                className={
                  "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors focus:outline-none " +
                  (item.tone === "danger"
                    ? "text-destructive hover:bg-destructive/[0.08] focus-visible:bg-destructive/[0.08]"
                    : "text-foreground hover:bg-secondary focus-visible:bg-secondary")
                }
              >
                {Icon ? (
                  <Icon
                    className="h-3.5 w-3.5"
                    aria-hidden
                    strokeWidth={1.75}
                  />
                ) : null}
                <span className="flex-1 text-left">{item.label}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
