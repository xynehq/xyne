import { Menu } from "lucide-react"
import { useSidebarMobile } from "@/hooks/useSidebarMobile"

type Props = {
  title?: string | undefined
}

export function Topbar({ title }: Props): JSX.Element {
  const { setOpen } = useSidebarMobile()
  return (
    <header
      className={
        "flex h-11 items-center gap-1 px-3 sm:px-4 " +
        (title ? "border-b border-border bg-background/70 backdrop-blur-md" : "")
      }
    >
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
      {title ? (
        <h1 className="truncate text-[13.5px] font-medium text-foreground">
          {title}
        </h1>
      ) : null}
    </header>
  )
}
