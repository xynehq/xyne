import { Link } from "@tanstack/react-router"
import { Bot, Globe, Star } from "lucide-react"
import type { Agent } from "@/lib/api"

type Props = {
  agent: Agent
  starred: boolean
  onToggleStar: (externalId: string) => void
}

export function AgentCard({
  agent,
  starred,
  onToggleStar,
}: Props): JSX.Element {
  return (
    <Link
      to="/agents/$agentId"
      params={{ agentId: agent.externalId }}
      className="group relative flex h-full flex-col gap-3 rounded-2xl border border-border bg-surface p-4 transition hover:-translate-y-0.5 hover:border-ring hover:bg-surface-elevated hover:shadow-lg"
    >
      {/* Star — absolute so it doesn't shift card layout when toggled. Stops
          propagation so clicking the star doesn't navigate into the agent. */}
      <button
        type="button"
        aria-label={starred ? "Unstar agent" : "Star agent"}
        title={starred ? "Starred" : "Star"}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onToggleStar(agent.externalId)
        }}
        className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
      >
        <Star
          className={`h-3.5 w-3.5 transition ${
            starred
              ? "fill-amber-400 text-amber-400 group-hover:scale-110"
              : "text-muted-foreground"
          }`}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>

      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-secondary text-foreground"
        >
          <Bot className="h-5 w-5" strokeWidth={1.6} />
        </span>
        <div className="min-w-0 pr-7">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[14px] font-medium text-foreground">
              {agent.name}
            </h3>
          </div>
          <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
            {agent.model}
          </p>
        </div>
      </div>

      <p className="line-clamp-2 min-h-[2.5rem] text-[12.5px] leading-snug text-muted-foreground">
        {agent.description || (
          <span className="italic text-muted-foreground/70">
            No description.
          </span>
        )}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        {agent.isPublic && (
          <Pill icon={<Globe className="h-3 w-3" aria-hidden strokeWidth={1.75} />}>
            Public
          </Pill>
        )}
        {agent.isRagOn && <Pill>RAG</Pill>}
        {agent.allowWebSearch && <Pill>Web</Pill>}
      </div>
    </Link>
  )
}

function Pill({
  children,
  icon,
}: {
  children: React.ReactNode
  icon?: JSX.Element
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-secondary/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
      {icon}
      {children}
    </span>
  )
}
