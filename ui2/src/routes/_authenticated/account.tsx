import { createFileRoute } from "@tanstack/react-router"
import { LogOut } from "lucide-react"
import { Topbar } from "@/components/Topbar"

export const Route = createFileRoute("/_authenticated/account")({
  component: AccountRoute,
})

function initials(email: string): string {
  const local = email.split("@")[0] ?? email
  const parts = local.split(/[._-]+/).filter(Boolean)
  const a = parts[0]?.[0] ?? "?"
  const b = parts[1]?.[0] ?? ""
  return (a + b).toUpperCase()
}

function AccountRoute(): JSX.Element {
  const { me } = Route.useRouteContext()
  return (
    <div className="flex h-full flex-col">
      <Topbar title="Account" />
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-10 animate-fade-up">
        {/* Identity */}
        <section className="flex items-center gap-4">
          <span
            aria-hidden
            className="grid h-14 w-14 place-items-center rounded-full bg-primary text-[16px] font-medium text-primary-foreground"
          >
            {initials(me.email)}
          </span>
          <div className="min-w-0">
            <h2 className="truncate font-display text-3xl leading-none">
              {me.email.split("@")[0]}
            </h2>
            <p className="mt-1 truncate text-[13px] text-muted-foreground">
              {me.email} · {me.role}
            </p>
          </div>
        </section>

        <div className="hairline" />

        {/* Profile */}
        <Card title="Profile" hint="Signed in via the shared xyne session.">
          <Row label="Email" value={me.email} mono />
          <Row label="Role" value={me.role} />
          <Row label="Token" value={me.tokenType} />
        </Card>

        {/* Workspace */}
        <Card title="Workspace" hint="Routing and permissions are scoped here.">
          <Row label="ID" value={me.workspaceId} mono />
        </Card>

        {/* Session */}
        <Card
          title="Session"
          hint="Tokens rotate automatically; sign out clears them on both surfaces."
          action={
            <a
              href="http://localhost:5173/v1/auth/logout"
              className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-3 text-[13px] text-foreground transition hover:border-destructive hover:text-destructive"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
              <span>Sign out</span>
            </a>
          }
        />
      </main>
    </div>
  )
}

function Card({
  title,
  hint,
  action,
  children,
}: {
  title: string
  hint?: string
  action?: JSX.Element
  children?: JSX.Element[] | JSX.Element
}): JSX.Element {
  return (
    <section>
      <header className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
          {hint && (
            <p className="mt-0.5 text-[12px] text-muted-foreground">{hint}</p>
          )}
        </div>
        {action}
      </header>
      {children && (
        <dl className="grid grid-cols-[7rem_1fr] gap-y-2.5 rounded-2xl border border-border bg-surface px-4 py-3 text-[13.5px]">
          {children}
        </dl>
      )}
    </section>
  )
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}): JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-[12.5px]" : ""}>{value}</dd>
    </>
  )
}
