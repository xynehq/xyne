// Small colored dot used to surface per-entry state (e.g. an in-flight
// ingest). Pending pulses gently so users notice it's still working.

import { cn } from "@/lib/utils"
import type { EntryIndicator } from "./types"

type Props = {
  indicator: EntryIndicator
  // "card" sits absolute in a card corner; "inline" flows with text.
  variant?: "card" | "inline"
}

const TONE: Record<EntryIndicator["tone"], string> = {
  pending: "bg-amber-400",
  failed: "bg-red-500",
  ready: "bg-emerald-500",
}

export function StatusBadge({ indicator, variant = "inline" }: Props): JSX.Element {
  const dot = (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full ring-2 ring-surface-elevated",
        TONE[indicator.tone],
        indicator.tone === "pending" && "animate-pulse",
      )}
    />
  )
  if (variant === "card") {
    return (
      <span
        className="absolute right-2.5 top-2.5 inline-flex"
        role="status"
        aria-label={indicator.label}
        title={indicator.label}
      >
        {dot}
      </span>
    )
  }
  return (
    <span
      className="inline-flex flex-shrink-0"
      role="status"
      aria-label={indicator.label}
      title={indicator.label}
    >
      {dot}
    </span>
  )
}
