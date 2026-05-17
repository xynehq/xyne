import type { LucideIcon } from "lucide-react"

type Props = {
  icon: LucideIcon
  label: string
  collapsed?: boolean
  active?: boolean
  onClick?: () => void
  shortcut?: string
  ariaCurrent?: "page" | undefined
}

export function SidebarNavItem({
  icon,
  label,
  collapsed = false,
  active = false,
  onClick,
  shortcut,
  ariaCurrent,
}: Props): JSX.Element {
  const Icon = icon
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-current={ariaCurrent}
        title={label}
        className={
          "grid h-9 w-9 place-items-center rounded-lg transition-colors duration-150 " +
          (active
            ? "bg-secondary text-foreground"
            : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
        }
      >
        <Icon className="h-4 w-4" aria-hidden strokeWidth={1.75} />
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={ariaCurrent}
      className={
        "group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors duration-150 " +
        (active
          ? "bg-secondary font-medium text-foreground"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
      }
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden strokeWidth={1.75} />
      <span className="flex-1 truncate text-left">{label}</span>
      {shortcut ? (
        <kbd className="hidden rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10.5px] font-medium tracking-wide text-muted-foreground group-hover:text-foreground/70 sm:inline-block">
          {shortcut}
        </kbd>
      ) : null}
    </button>
  )
}
