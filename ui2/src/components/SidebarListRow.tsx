import type { ReactNode } from "react"

type Props = {
  title: string
  active?: boolean
  onClick?: () => void
  actions?: ReactNode
  ariaCurrent?: "page" | undefined
  buttonRef?: (el: HTMLButtonElement | null) => void
}

export function SidebarListRow({
  title,
  active = false,
  onClick,
  actions,
  ariaCurrent,
  buttonRef,
}: Props): JSX.Element {
  return (
    <div className="group relative">
      <button
        type="button"
        ref={buttonRef}
        onClick={onClick}
        aria-current={ariaCurrent}
        className={
          "flex h-9 w-full items-center rounded-lg pl-2.5 text-left text-[13px] leading-tight transition-colors duration-150 " +
          (actions ? "pr-9 " : "pr-2.5 ") +
          (active
            ? "bg-secondary text-foreground"
            : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
        }
      >
        <span className="block min-w-0 flex-1 truncate">
          {title || "Untitled"}
        </span>
      </button>
      {actions ? (
        <div className="absolute inset-y-0 right-1.5 flex items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          {actions}
        </div>
      ) : null}
    </div>
  )
}
