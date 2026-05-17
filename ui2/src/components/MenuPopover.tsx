import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import type { LucideIcon } from "lucide-react"

// Hover-revealed dropdown menu. Trigger is a render-prop so the caller owns
// the trigger's exact look. The menu itself renders into document.body via a
// portal so it escapes ancestor `transform`/`overflow`/stacking contexts
// (otherwise sibling rows in a list can paint over it). Keyboard: open
// focuses first item; ↑/↓/Home/End cycle; Enter invokes; Escape closes and
// restores focus to the trigger.
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

const MENU_WIDTH = 160 // matches w-40
const MENU_GAP = 4

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
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  )

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
        restoreFocusRef.current = document.activeElement as HTMLElement
      }
      return !prev
    })
  }, [])

  // Position the portal-rendered menu next to the trigger.
  useLayoutEffect((): (() => void) | undefined => {
    if (!open) return undefined
    const place = (): void => {
      const wrap = wrapRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      const top = rect.bottom + MENU_GAP
      const left =
        align === "right" ? rect.right - MENU_WIDTH : rect.left
      setCoords({ top, left })
    }
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [open, align])

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node
      if (wrapRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      close(false)
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
      {open && coords
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-orientation="vertical"
              style={{
                position: "fixed",
                top: coords.top,
                left: coords.left,
                width: MENU_WIDTH,
              }}
              className="animate-fade-up z-[1000] overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg shadow-foreground/10"
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
                      close(false)
                      item.onClick()
                    }}
                    className={
                      "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors " +
                      (item.tone === "danger"
                        ? "text-destructive hover:bg-destructive/[0.08] focus:bg-destructive/[0.08] focus:outline-none"
                        : "text-foreground hover:bg-secondary focus:bg-secondary focus:outline-none")
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
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
