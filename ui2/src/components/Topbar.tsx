import { Menu } from "lucide-react"
import { useSidebarMobile } from "@/hooks/useSidebarMobile"

type Props = {
  title: string
  /** Extreme-right slot, e.g. the citation panel toggle. */
  rightSlot?: React.ReactNode
}

export function Topbar({ title, rightSlot }: Props): JSX.Element {
  const { setOpen } = useSidebarMobile()
  return (
    <header className="flex items-center gap-1 border-b border-border bg-background/70 px-3 py-2 backdrop-blur-md sm:px-4">
      <button
        type="button"
        onClick={(): void => {
          setOpen(true)
        }}
        aria-label="Open sidebar"
        aria-controls="app-sidebar"
        className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground md:hidden"
      >
        <Menu className="h-4 w-4" aria-hidden strokeWidth={1.75} />
      </button>
      <h1 className="truncate flex-1 text-[13.5px] font-medium text-foreground">
        {title}
      </h1>
      {rightSlot}
    </header>
  )
}
