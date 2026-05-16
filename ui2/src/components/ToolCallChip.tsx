import { useState } from "react"
import {
  ChevronRight,
  AlertTriangle,
  Loader2,
  Check,
} from "lucide-react"

type Props = {
  name: string
  args: unknown
  result?: { output: unknown; isError: boolean }
}

const stringify = (v: unknown): string => {
  if (typeof v === "string") {
    return v
  }
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export function ToolCallChip({ name, args, result }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const status: "running" | "done" | "error" = result
    ? result.isError
      ? "error"
      : "done"
    : "running"

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60 text-[12.5px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-surface-muted/60"
      >
        <ChevronRight
          className={
            "h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform " +
            (open ? "rotate-90" : "")
          }
          aria-hidden
        />
        <span className="font-mono text-[12px] text-foreground/85">
          {name}
        </span>
        <span className="ml-auto inline-flex items-center text-muted-foreground">
          {status === "running" && (
            <Loader2
              className="h-3 w-3 animate-spin"
              aria-hidden
            />
          )}
          {status === "done" && (
            <Check
              className="h-3 w-3 text-foreground/60"
              aria-hidden
              strokeWidth={2.5}
            />
          )}
          {status === "error" && (
            <AlertTriangle
              className="h-3 w-3 text-destructive"
              aria-hidden
            />
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-border/60 bg-surface-muted/30">
          <Section title="Arguments">
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-foreground/85">
              {stringify(args)}
            </pre>
          </Section>
          {result && (
            <>
              <div className="mx-3 h-px bg-border/60" />
              <Section title="Result">
                <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-foreground/85">
                  {stringify(result.output)}
                </pre>
              </Section>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="px-3 py-2">
      <div className="pb-1 text-[9.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
        {title}
      </div>
      {children}
    </div>
  )
}
