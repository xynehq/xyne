import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronRight as ChevronRightIcon,
  Copy,
  FileJson,
  Layers,
  Loader2,
  Settings,
  Square,
  Terminal,
  X,
  XCircle,
  Zap,
} from "lucide-react"
import { Topbar } from "@/components/Topbar"
import {
  type Agent,
  ApiError,
  type ExtractAttemptDebug,
  type ExtractResult,
  getAgent,
  runExtractor,
} from "@/lib/api"
import {
  type ExpandSignal,
  JsonTree,
} from "@/components/JsonTree"
import { DebugChip } from "@/components/DebugPanel"
import { DebugDock } from "@/components/DebugDock"
import { appendDebugEvent, type DebugEvent } from "@/lib/debug-store"
import { preferencesStore } from "@/lib/preferences"

export const Route = createFileRoute("/_authenticated/extractors/$extractorId/")({
  component: ExtractorUseRoute,
})

type ThinkingLevel = "minimal" | "low" | "medium" | "high"

function ExtractorUseRoute(): JSX.Element {
  const { extractorId } = Route.useParams()

  const [agent, setAgent] = useState<Agent | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [input, setInput] = useState("")
  // The thinking level + retry budget are sticky per-browser — running
  // many extractions usually means you want the same dials each time.
  const [thinking, setThinking] = useState<ThinkingLevel>(
    () => readPersisted<ThinkingLevel>("thinking", "low"),
  )
  const [maxRetries, setMaxRetries] = useState<number>(
    () => readPersisted<number>("maxRetries", 2),
  )
  useEffect((): void => {
    writePersisted("thinking", thinking)
  }, [thinking])
  useEffect((): void => {
    writePersisted("maxRetries", maxRetries)
  }, [maxRetries])

  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [result, setResult] = useState<ExtractResult | null>(null)
  const [jsonSignal, setJsonSignal] = useState<ExpandSignal | null>(null)
  const [liveRunIdsState, setLiveRunIdsState] = useState<string[]>([])
  const [apiModalOpen, setApiModalOpen] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const startedAtRef = useRef<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect((): (() => void) => {
    let cancelled = false
    setAgent(null)
    setLoadError(null)
    getAgent(extractorId)
      .then((a): void => {
        if (!cancelled) setAgent(a)
      })
      .catch((err: Error): void => {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiError && err.status === 404
              ? "This extractor doesn't exist, or you don't have access."
              : err.message,
          )
        }
      })
    return (): void => {
      cancelled = true
    }
  }, [extractorId])

  // Tick a 1Hz timer while running so the user sees something move during
  // long extractions (Vespa search + model call can be 10–60s).
  useEffect((): (() => void) | undefined => {
    if (!running) return undefined
    const id = window.setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsedMs(Date.now() - startedAtRef.current)
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [running])

  const run = async (): Promise<void> => {
    if (!input.trim() || running) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRunning(true)
    setRunError(null)
    setResult(null)
    setLiveRunIdsState([])
    startedAtRef.current = Date.now()
    setElapsedMs(0)
    const liveRunIds: string[] = []
    // Read at run-time (not on render) so flipping the debug toggle
    // in Account takes effect immediately on the next run, same as
    // chat does.
    const prefs = preferencesStore.get()
    try {
      const r = await runExtractor(
        extractorId,
        {
          input,
          thinkingLevel: thinking,
          maxRetries,
          ...(prefs.debugMode
            ? {
                debug: true,
                debugVerbosity: prefs.debugVerbosity,
              }
            : {}),
        },
        (frame): void => {
          // Push debug events into the shared store as they arrive,
          // so the DebugChip + DebugDock light up live (same store
          // the chat path uses).
          if (frame.kind === "debug_event") {
            appendDebugEvent(frame.runId, frame.event as DebugEvent)
            if (!liveRunIds.includes(frame.runId)) {
              liveRunIds.push(frame.runId)
              setLiveRunIdsState((prev) =>
                prev.includes(frame.runId) ? prev : [...prev, frame.runId],
              )
            }
          }
        },
        ctrl.signal,
      )
      setResult(r)
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        setRunError("Aborted")
      } else {
        const message =
          err instanceof ApiError ? err.message : (err as Error).message
        setRunError(message || "Extraction failed.")
      }
    } finally {
      setRunning(false)
      abortRef.current = null
      startedAtRef.current = null
    }
  }

  const stop = (): void => {
    abortRef.current?.abort()
  }

  const extractorName = agent?.name ?? "Extractor"

  return (
    <div className="flex h-full">
      <div className="flex h-full min-w-0 flex-1 flex-col">
      <Topbar title={agent ? agent.name : "Extractor"} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/70 px-5 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link
            to="/extractors"
            aria-label="Back to extractors"
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          </Link>
          <nav
            aria-label="Extractor path"
            className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground"
          >
            <Link
              to="/extractors"
              className="inline-flex items-center rounded-md px-1.5 py-0.5 transition hover:bg-secondary hover:text-foreground"
            >
              Extractors
            </Link>
            <ChevronRightIcon
              className="h-3.5 w-3.5 text-muted-foreground/60"
              aria-hidden
              strokeWidth={1.75}
            />
            <span
              aria-current="page"
              className="max-w-[36ch] truncate rounded-md px-1.5 py-0.5 font-medium text-foreground"
              title={extractorName}
            >
              {extractorName}
            </span>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(): void => setApiModalOpen(true)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 text-[12px] text-foreground transition hover:bg-secondary"
            title="Show a copy-paste curl for the /extract endpoint"
          >
            <Terminal
              className="h-3.5 w-3.5"
              aria-hidden
              strokeWidth={1.75}
            />
            Use via API
          </button>
          <Link
            to="/extractors/$extractorId/edit"
            params={{ extractorId }}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 text-[12px] text-foreground transition hover:bg-secondary"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
            Edit configuration
          </Link>
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto w-full max-w-5xl space-y-5">
          {loadError ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-4 text-[13.5px] text-destructive">
              {loadError}
            </div>
          ) : !agent ? (
            <div className="flex flex-col gap-4">
              <div className="h-32 w-full animate-breathe rounded-md bg-surface-elevated" />
              <div className="h-10 w-full animate-breathe rounded-md bg-surface-elevated" />
            </div>
          ) : (
            <>
              {!agent.isExtractor ? (
                <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-[13px] text-amber-700 dark:text-amber-300">
                  <AlertTriangle
                    className="mt-0.5 h-4 w-4 flex-shrink-0"
                    aria-hidden
                    strokeWidth={1.75}
                  />
                  <div>
                    This agent isn't marked as an extractor.{" "}
                    <Link
                      to="/extractors/$extractorId/edit"
                      params={{ extractorId }}
                      className="underline"
                    >
                      Open settings
                    </Link>{" "}
                    to enable the extractor mode.
                  </div>
                </div>
              ) : null}

              <section className="space-y-2">
                <div className="flex items-end justify-between gap-2">
                  <div>
                    <h2 className="text-[14px] font-medium text-foreground">
                      Prompt
                    </h2>
                    <p className="text-[12px] text-muted-foreground">
                      What you want extracted, in natural language. The
                      agent will use its tools to locate the source
                      document(s) and emit JSON matching the schema you
                      configured.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                    <label className="inline-flex items-center gap-1">
                      Thinking
                      <select
                        value={thinking}
                        onChange={(e): void =>
                          setThinking(e.target.value as ThinkingLevel)
                        }
                        disabled={running}
                        className="h-7 rounded-md border border-border bg-background px-1.5 text-[12px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                      >
                        <option value="minimal">minimal</option>
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                      </select>
                    </label>
                    <label className="inline-flex items-center gap-1">
                      Max retries
                      <input
                        type="number"
                        min={0}
                        max={10}
                        value={maxRetries}
                        onChange={(e): void => {
                          const n = parseInt(e.target.value, 10)
                          setMaxRetries(Number.isFinite(n) ? n : 2)
                        }}
                        disabled={running}
                        className="h-7 w-14 rounded-md border border-border bg-background px-2 text-[12px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                      />
                    </label>
                  </div>
                </div>
                <textarea
                  value={input}
                  onChange={(e): void => setInput(e.target.value)}
                  placeholder={`e.g. Extract order QJA/MN/CFID/CFID-SEC5/32160/2025-26 from the SEBI corpus.`}
                  disabled={running}
                  rows={6}
                  className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-[13.5px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground">
                    {input.trim().length === 0
                      ? "Enter some input to run."
                      : `${String(input.length)} characters`}
                  </p>
                  <div className="flex items-center gap-2">
                    {running ? (
                      <>
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <Loader2
                            className="h-3.5 w-3.5 animate-spin"
                            aria-hidden
                            strokeWidth={2}
                          />
                          Running… {formatElapsed(elapsedMs)}
                        </span>
                        <button
                          type="button"
                          onClick={stop}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 text-[12.5px] text-foreground transition hover:bg-secondary"
                        >
                          <Square
                            className="h-3.5 w-3.5"
                            aria-hidden
                            strokeWidth={1.75}
                          />
                          Stop
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={(): void => {
                          void run()
                        }}
                        disabled={input.trim().length === 0 || !agent.isExtractor}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Zap
                          className="h-3.5 w-3.5"
                          aria-hidden
                          strokeWidth={1.75}
                        />
                        Run extraction
                      </button>
                    )}
                  </div>
                </div>
                {runError ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
                    {runError}
                  </div>
                ) : null}
                {liveRunIdsState.length > 0 ? (
                  <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-surface-muted/20 px-3 py-2">
                    {liveRunIdsState.map((rid) => (
                      <DebugChip key={rid} runId={rid} />
                    ))}
                  </div>
                ) : null}
              </section>

              {result ? (
                <ResultPanel
                  result={result}
                  jsonSignal={jsonSignal}
                  onExpandAll={(): void =>
                    setJsonSignal({ token: Date.now(), expand: true })
                  }
                  onCollapseAll={(): void =>
                    setJsonSignal({ token: Date.now(), expand: false })
                  }
                />
              ) : null}
            </>
          )}
        </div>
      </main>
      </div>
      <DebugDock />
      {apiModalOpen ? (
        <ApiCurlModal
          extractorId={extractorId}
          thinking={thinking}
          maxRetries={maxRetries}
          onClose={(): void => setApiModalOpen(false)}
        />
      ) : null}
    </div>
  )
}

function ApiCurlModal({
  extractorId,
  thinking,
  maxRetries,
  onClose,
}: {
  extractorId: string
  thinking: ThinkingLevel
  maxRetries: number
  onClose: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect((): (() => void) => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return (): void => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const body = JSON.stringify(
    {
      input: "<your prompt to extract>",
      thinkingLevel: thinking,
      maxRetries,
    },
    null,
    2,
  )
  const origin =
    typeof window !== "undefined" ? window.location.origin : "<HOST>"
  const url = `${origin}/v2/agents/${encodeURIComponent(extractorId)}/extract`
  const curl = [
    `curl -X POST '${url}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'Cookie: AccessToken=<paste-your-AccessToken-cookie-here>' \\`,
    `  -d '${body.replace(/'/g, `'"'"'`)}'`,
  ].join("\n")

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(curl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="api-curl-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl"
        onClick={(e): void => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Terminal
              className="h-4 w-4 text-muted-foreground"
              aria-hidden
              strokeWidth={1.75}
            />
            <h2
              id="api-curl-title"
              className="text-[13.5px] font-medium text-foreground"
            >
              Use this extractor via API
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          </button>
        </div>
        <div className="space-y-3 overflow-auto p-4">
          <p className="text-[12.5px] text-muted-foreground">
            <code className="rounded bg-surface-muted/40 px-1 py-0.5">
              POST /v2/agents/:id/extract
            </code>{" "}
            returns a single JSON envelope:{" "}
            <code className="rounded bg-surface-muted/40 px-1 py-0.5">
              {"{ ok, value | errors, attempts, tokenUsage, debug[] }"}
            </code>
            . Status is 200 on validation success, 422 on final
            failure. Replace the{" "}
            <code className="rounded bg-surface-muted/40 px-1 py-0.5">
              AccessToken
            </code>{" "}
            cookie with the one your browser uses (DevTools → Application
            → Cookies for this site). Use{" "}
            <code className="rounded bg-surface-muted/40 px-1 py-0.5">
              /extract/stream
            </code>{" "}
            instead of{" "}
            <code className="rounded bg-surface-muted/40 px-1 py-0.5">
              /extract
            </code>{" "}
            for an SSE stream of debug events.
          </p>
          <div className="relative">
            <pre className="max-h-[400px] overflow-auto rounded-md border border-border bg-surface-muted/30 p-3 pr-12 font-mono text-[12px] leading-relaxed text-foreground">
              {curl}
            </pre>
            <button
              type="button"
              onClick={(): void => {
                void copy()
              }}
              className="absolute right-2 top-2 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11.5px] text-muted-foreground transition hover:text-foreground"
              title="Copy curl"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3" aria-hidden strokeWidth={2} />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" aria-hidden strokeWidth={1.75} />
                  Copy
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const STORAGE_PREFIX = "extractorRun"
function readPersisted<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}:${key}`)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
function writePersisted<T>(key: string, value: T): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      `${STORAGE_PREFIX}:${key}`,
      JSON.stringify(value),
    )
  } catch {
    /* quota / disabled storage — ignore */
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${String(s)}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m)}m ${String(r)}s`
}

function ResultPanel({
  result,
  jsonSignal,
  onExpandAll,
  onCollapseAll,
}: {
  result: ExtractResult
  jsonSignal: ExpandSignal | null
  onExpandAll: () => void
  onCollapseAll: () => void
}): JSX.Element {
  const ok = result.ok
  const [copied, setCopied] = useState(false)
  const copyValue = async (): Promise<void> => {
    const text = ok
      ? JSON.stringify(result.value, null, 2)
      : JSON.stringify(
          { errors: result.errors, lastRawText: result.lastRawText },
          null,
          2,
        )
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* older browsers / insecure contexts */
    }
  }
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {ok ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2
                className="h-3.5 w-3.5"
                aria-hidden
                strokeWidth={1.75}
              />
              Valid
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[12px] font-medium text-destructive">
              <XCircle
                className="h-3.5 w-3.5"
                aria-hidden
                strokeWidth={1.75}
              />
              Failed validation
            </span>
          )}
          <span className="text-[12px] text-muted-foreground">
            {String(result.attempts)} attempt
            {result.attempts === 1 ? "" : "s"} ·{" "}
            {String(result.tokenUsage.input)} in /{" "}
            {String(result.tokenUsage.output)} out
          </span>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-surface-elevated">
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
          <div className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
            <FileJson
              className="h-3.5 w-3.5"
              aria-hidden
              strokeWidth={1.75}
            />
            Output
          </div>
          <div className="flex items-center gap-1">
            {ok ? (
              <>
                <button
                  type="button"
                  onClick={onExpandAll}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-muted/40 px-2 text-[11px] text-muted-foreground transition hover:text-foreground"
                >
                  <Layers className="h-3 w-3" aria-hidden strokeWidth={1.75} />
                  Expand all
                </button>
                <button
                  type="button"
                  onClick={onCollapseAll}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-muted/40 px-2 text-[11px] text-muted-foreground transition hover:text-foreground"
                >
                  <Layers
                    className="h-3 w-3 rotate-180"
                    aria-hidden
                    strokeWidth={1.75}
                  />
                  Collapse all
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={(): void => {
                void copyValue()
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-muted/40 px-2 text-[11px] text-muted-foreground transition hover:text-foreground"
              title={ok ? "Copy JSON" : "Copy errors + last raw text"}
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3" aria-hidden strokeWidth={2} />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" aria-hidden strokeWidth={1.75} />
                  Copy
                </>
              )}
            </button>
          </div>
        </div>
        <div className="max-h-[480px] overflow-auto p-3 font-mono text-[12px] leading-relaxed">
          {ok ? (
            <JsonTree value={result.value} signal={jsonSignal} />
          ) : (
            <div className="space-y-2">
              <p className="text-[12px] text-muted-foreground">
                The agent didn't produce a JSON that conforms to the schema
                across {String(result.attempts)} attempt
                {result.attempts === 1 ? "" : "s"}. The last raw output and
                per-attempt errors are below.
              </p>
              <ul className="space-y-1">
                {result.errors.map((e, i) => (
                  <li
                    key={i}
                    className="text-[12px] text-destructive"
                  >
                    <span className="font-mono text-foreground">
                      {e.path}
                    </span>
                    <span className="text-muted-foreground"> — </span>
                    {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <details className="rounded-2xl border border-border bg-surface-elevated">
        <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[12.5px] font-medium text-foreground hover:bg-secondary/40">
          <span className="inline-flex items-center gap-2">
            <ChevronDown
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden
              strokeWidth={1.75}
            />
            Attempts ({result.debug.length})
          </span>
          <span className="text-[11.5px] text-muted-foreground">
            raw text + validation errors per attempt
          </span>
        </summary>
        <div className="space-y-2 border-t border-border/60 p-3">
          {result.debug.map((a) => (
            <AttemptCard
              key={a.attempt}
              attempt={a}
              conversationId={result.conversationId}
            />
          ))}
        </div>
      </details>
    </section>
  )
}

function AttemptCard({
  attempt,
  conversationId,
}: {
  attempt: ExtractAttemptDebug
  conversationId: string
}): JSX.Element {
  const [expanded, setExpanded] = useState(!attempt.ok)
  return (
    <div className="rounded-md border border-border/60 bg-background/40">
      <div className="flex w-full items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={(): void => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left text-[12px] text-foreground hover:opacity-80"
        >
          <ChevronRight
            className={
              "h-3 w-3 transition-transform " + (expanded ? "rotate-90" : "")
            }
            aria-hidden
            strokeWidth={2}
          />
          {attempt.ok ? (
            <CheckCircle2
              className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400"
              aria-hidden
              strokeWidth={1.75}
            />
          ) : (
            <XCircle
              className="h-3.5 w-3.5 text-destructive"
              aria-hidden
              strokeWidth={1.75}
            />
          )}
          <span className="font-medium">Attempt {String(attempt.attempt)}</span>
          <span className="text-muted-foreground">
            {String(attempt.durationMs)} ms
          </span>
        </button>
        <DebugChip runId={attempt.runId} conversationId={conversationId} />
      </div>
      {expanded ? (
        <div className="space-y-2 border-t border-border/60 px-3 py-2 text-[12px]">
          {!attempt.ok && attempt.errors && attempt.errors.length > 0 ? (
            <div>
              <p className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
                Validation errors
              </p>
              <ul className="space-y-0.5">
                {attempt.errors.map((e, i) => (
                  <li key={i} className="text-destructive">
                    <span className="font-mono text-foreground">{e.path}</span>
                    <span className="text-muted-foreground"> — </span>
                    {e.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <p className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
              Raw text
            </p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-surface-muted/30 p-2 font-mono text-[11.5px] text-foreground">
              {attempt.rawText || "(empty)"}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  )
}
