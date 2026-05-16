import { Sparkles } from "lucide-react"

type Props = {
  name?: string | undefined
}

const timeGreeting = (now = new Date()): string => {
  const h = now.getHours()
  if (h < 5) {
    return "Working late"
  }
  if (h < 12) {
    return "Good morning"
  }
  if (h < 17) {
    return "Good afternoon"
  }
  return "Good evening"
}

const firstName = (email?: string): string | undefined => {
  if (!email) {
    return undefined
  }
  const local = email.split("@")[0] ?? ""
  const first = local.split(/[._-]+/)[0]
  if (!first) {
    return undefined
  }
  return first.charAt(0).toUpperCase() + first.slice(1)
}

export function EmptyState({ name }: Props): JSX.Element {
  const greet = timeGreeting()
  const display = firstName(name)

  return (
    <div className="relative isolate flex w-full max-w-2xl flex-col items-center gap-6 px-6 text-center animate-fade-up">
      <div className="halo pointer-events-none absolute inset-x-0 -top-10 -z-10 h-72" />

      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
        <Sparkles className="h-3 w-3" aria-hidden strokeWidth={1.75} />
        <span>xyne · workspace AI</span>
      </span>

      <h1 className="font-display text-5xl leading-[1.05] tracking-tight text-foreground sm:text-6xl">
        {greet}
        {display ? (
          <>
            ,{" "}
            <em className="italic text-foreground/90">{display}</em>
          </>
        ) : null}
        .
      </h1>

      <p className="max-w-md text-[15px] leading-relaxed text-muted-foreground">
        Ask anything across your workspace — drafts, decisions, code,
        documents. Answers stream back with citations from your sources.
      </p>
    </div>
  )
}
