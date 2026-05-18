import { useEffect, useRef, useState } from "react"
import { D2 } from "@terrastruct/d2"

// The D2 compiler is a WASM module — instantiating it is expensive, so we keep
// a single lazily-created instance shared by every diagram on the page.
let sharedD2: D2 | null = null
function getD2(): D2 {
  if (!sharedD2) sharedD2 = new D2()
  return sharedD2
}

type Props = {
  /** Raw D2 source from the ```d2 fenced block. */
  code: string
  /**
   * True while the assistant message is still streaming. When pending, the
   * `code` arrives incomplete token-by-token and compile failures are
   * expected — we show a placeholder instead of an error until the stream
   * settles.
   */
  pending?: boolean
}

type State =
  | { status: "idle" }
  | { status: "ok"; svg: string }
  | { status: "error"; message: string }

/**
 * Renders a D2 diagram from a fenced ```d2 code block.
 *
 * Compilation is debounced (250ms) so a streaming message doesn't recompile on
 * every token, and stale results are discarded via a monotonic request id.
 */
export function D2Diagram({ code, pending = false }: Props): JSX.Element {
  const [state, setState] = useState<State>({ status: "idle" })
  const reqId = useRef(0)

  useEffect(() => {
    const source = code.trim()
    if (!source) {
      setState({ status: "idle" })
      return
    }
    const id = ++reqId.current
    let cancelled = false

    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const d2 = getD2()
          const result = await d2.compile(source)
          const svg = await d2.render(result.diagram, result.renderOptions)
          if (cancelled || id !== reqId.current) return
          setState({ status: "ok", svg })
        } catch (err) {
          if (cancelled || id !== reqId.current) return
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    }, 250)

    return (): void => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code])

  if (state.status === "ok") {
    return (
      <div
        className="my-3 overflow-x-auto rounded-xl border border-border bg-white p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        // SVG is produced by the D2 WASM compiler from the model's diagram
        // source — not arbitrary user HTML.
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    )
  }

  // A genuine compile error, but only worth surfacing once the stream is done;
  // mid-stream the source is simply incomplete.
  if (state.status === "error" && !pending) {
    return (
      <div className="my-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-[13px] text-destructive">
        <div className="mb-1 font-medium">Couldn&apos;t render diagram</div>
        <div className="mb-2 opacity-80">{state.message}</div>
        <pre className="overflow-x-auto whitespace-pre rounded-lg bg-background/60 p-2 text-foreground/80">
          {code}
        </pre>
      </div>
    )
  }

  // Still streaming, or first compile not finished yet.
  return (
    <div className="my-3 flex items-center gap-2 rounded-xl border border-border bg-secondary/40 px-3 py-2.5 text-[13px] text-muted-foreground">
      <span className="h-2 w-2 animate-pulse rounded-full bg-muted-foreground/60" />
      Rendering diagram…
    </div>
  )
}
