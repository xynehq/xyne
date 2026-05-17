// Path-style breadcrumb. The "root" label/icon is configurable so this works
// for any hierarchical section (Knowledge, Agent groups, …). Empty path
// renders just the root.

import { ChevronRight, Home } from "lucide-react"
import type { ReactNode } from "react"
import { splitPath } from "@/lib/files"

type Props = {
  path: string
  onNavigate: (path: string) => void
  // Label for the root entry. Defaults to "Home".
  rootLabel?: string
  // Glyph for the root entry. Defaults to a small Home icon. Pass `null` to
  // omit (label-only root).
  rootIcon?: ReactNode | null
  // Separator between segments. Defaults to a small ChevronRight.
  separator?: ReactNode
  // aria-label for the nav element.
  ariaLabel?: string
}

const DefaultSeparator = (
  <ChevronRight
    className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60"
    aria-hidden
    strokeWidth={1.75}
  />
)

const DefaultRootIcon = (
  <Home className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
)

export function PathBreadcrumb({
  path,
  onNavigate,
  rootLabel = "Home",
  rootIcon = DefaultRootIcon,
  separator = DefaultSeparator,
  ariaLabel = "Path",
}: Props): JSX.Element {
  const segs = splitPath(path)
  const rootIsCurrent = segs.length === 0
  return (
    <nav
      aria-label={ariaLabel}
      className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground"
    >
      <button
        type="button"
        onClick={() => {
          onNavigate("")
        }}
        aria-current={rootIsCurrent ? "page" : undefined}
        className={
          rootIsCurrent
            ? "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-medium text-foreground"
            : "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition hover:bg-secondary hover:text-foreground"
        }
      >
        {rootIcon}
        <span>{rootLabel}</span>
      </button>
      {segs.map((seg, i) => {
        const isLast = i === segs.length - 1
        const target = segs.slice(0, i + 1).join("/")
        return (
          <span key={target} className="flex min-w-0 items-center gap-1">
            {separator}
            <button
              type="button"
              onClick={() => {
                onNavigate(target)
              }}
              aria-current={isLast ? "page" : undefined}
              className={
                isLast
                  ? "max-w-[28ch] truncate rounded-md px-1.5 py-0.5 font-medium text-foreground"
                  : "max-w-[20ch] truncate rounded-md px-1.5 py-0.5 transition hover:bg-secondary hover:text-foreground"
              }
              title={seg}
            >
              {seg}
            </button>
          </span>
        )
      })}
    </nav>
  )
}
