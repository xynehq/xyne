import { ThemeToggle } from "./ThemeToggle"

type Props = {
  title: string
}

export function Topbar({ title }: Props): JSX.Element {
  return (
    <header className="flex items-center justify-between border-b border-border bg-background/70 px-4 py-2 backdrop-blur-md">
      <h1 className="truncate text-[13.5px] font-medium text-foreground">
        {title}
      </h1>

      <div className="flex items-center gap-2">
        <ThemeToggle />
      </div>
    </header>
  )
}
