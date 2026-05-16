import { Link } from "@tanstack/react-router"
import { MessageSquarePlus, Search } from "lucide-react"
import { BrandMark } from "./BrandMark"

function initials(email: string): string {
  const local = email.split("@")[0] ?? email
  const parts = local.split(/[._-]+/).filter(Boolean)
  const a = parts[0]?.[0] ?? "?"
  const b = parts[1]?.[0] ?? ""
  return (a + b).toUpperCase()
}

type Props = {
  me?: { email: string; role: string } | undefined
}

export function Sidebar({ me }: Props): JSX.Element {
  return (
    <aside className="hidden h-full w-14 flex-shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar py-3 md:flex">
      <Link
        to="/"
        aria-label="Home"
        className="grid h-9 w-9 place-items-center rounded-md transition hover:bg-secondary"
      >
        <BrandMark withWordmark={false} size="md" />
      </Link>

      <div className="mt-3 flex w-full flex-col items-center gap-1">
        <Link
          to="/"
          aria-label="New chat"
          title="New chat"
          className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          activeProps={{
            className:
              "grid h-9 w-9 place-items-center rounded-md text-foreground bg-secondary",
          }}
        >
          <MessageSquarePlus className="h-4 w-4" aria-hidden strokeWidth={1.75} />
        </Link>

        <button
          type="button"
          aria-label="Search"
          title="Search conversations  (⌘K)"
          className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <Search className="h-4 w-4" aria-hidden strokeWidth={1.75} />
        </button>
      </div>

      <div className="flex-1" />

      <Link
        to="/account"
        aria-label="Account"
        title={me?.email ?? "Account"}
        className="grid h-9 w-9 place-items-center rounded-full bg-primary text-[11px] font-medium text-primary-foreground transition hover:opacity-90"
        activeProps={{
          className:
            "grid h-9 w-9 place-items-center rounded-full bg-primary text-[11px] font-medium text-primary-foreground ring-2 ring-ring ring-offset-2 ring-offset-sidebar",
        }}
      >
        {me ? initials(me.email) : "··"}
      </Link>
    </aside>
  )
}
