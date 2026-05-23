// Inspector for the raw Vespa document an agent's search tools see.
//
// Layout:
//   • Metadata header — file name, docId, key scalar fields.
//   • Per-field collapsible sections, ordered by "scannability":
//       - chunks (text)         joined with chunks_map (pages)
//       - image_chunks (text)   joined with image_chunks_map
//       - chunks_map (raw)      per-chunk metadata cards
//       - image_chunks_map      per-chunk image metadata cards
//       - toc_chunks            string-list rows
//       - headings              string-list rows
//       - entities_involved     string-list rows
//       - referenced_ids        string-list rows
//       - pan_ids               string-list rows
//       - ai_summary            long-text block
//       - metadata              json block (string-typed JSON)
//       - bboxes_json           json block
//   • Bottom: "Show raw Vespa fields" expander dumps the whole
//     `fields` object for the rare case where the curated view
//     drops information.
//
// Sections that are missing/empty on a doc are silently omitted.
// Each section opens (chevron expand) to show its content the
// same way — chunk-text sections use cards with index + pages +
// the chunk's text; metadata sections use cards with index +
// page numbers + bbox; string-list sections use indented rows.

import { useEffect, useMemo, useState } from "react"
import { AlertCircle, ChevronRight, Hash, Loader2 } from "lucide-react"

import { getVespaDoc, type VespaDocInspect } from "@/lib/api"

type Props = {
  docId: string
  // Display name passed in by the opener so we don't flash the raw
  // docId before the fetch lands.
  name: string
}

type ChunkRow = {
  index: number
  text: string
  pages: number[]
}

type ChunkMeta = {
  chunk_index?: number
  page_numbers?: number[]
  block_labels?: string[]
  bbox_l?: number
  bbox_t?: number
  bbox_r?: number
  bbox_b?: number
  width?: number
  height?: number
  headings?: string[]
}

const stringify = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

// Strip Vespa's bolding markup. The default summary class on
// `kb_items` declares `bolding: on` for chunks, image_chunks, and
// toc_chunks, so when a query has terms to highlight the
// returned strings include <hi>…</hi> wrappers. The inspector is
// rendering raw text — drop the markup so it doesn't show up as
// literal <hi> tags.
const stripBolding = (s: string): string =>
  s.replace(/<\/?hi>/g, "")

// Pick the first array-valued field present from a list of
// candidate names. Vespa's summary class aliases the canonical
// fields:
//   chunks       → chunks_summary
//   image_chunks → image_chunks_summary
//   toc_chunks   → toc_chunks_summary
//   chunks_pos   → chunks_pos_summary
// so the inspector probes the summary name first and falls back
// to the canonical name (which is what the schema calls it).
const pickArray = (
  fields: Record<string, unknown>,
  names: ReadonlyArray<string>,
): unknown[] | null => {
  for (const n of names) {
    const v = fields[n]
    if (Array.isArray(v)) return v
  }
  return null
}

// Pull a text-array field out of fields and overlay page numbers
// from the parallel map field. Either may be missing on legacy
// docs.
const joinChunks = (
  chunks: unknown,
  map: unknown,
): ChunkRow[] => {
  if (!Array.isArray(chunks)) return []
  const byIndex = new Map<number, ChunkRow>()
  chunks.forEach((c, i) => {
    const raw =
      typeof c === "string"
        ? c
        : c && typeof c === "object" && "text" in c
          ? String((c as { text?: unknown }).text ?? "")
          : ""
    byIndex.set(i, { index: i, text: stripBolding(raw), pages: [] })
  })
  if (Array.isArray(map)) {
    for (const m of map as ChunkMeta[]) {
      if (typeof m?.chunk_index === "number" && byIndex.has(m.chunk_index)) {
        const row = byIndex.get(m.chunk_index)!
        if (Array.isArray(m.page_numbers)) row.pages = m.page_numbers
      }
    }
  }
  return Array.from(byIndex.values())
}

// Generic collapsible section. Header shows title + count badge;
// clicking the header toggles the body. Defaults: collapsed for
// `chunks_map` / raw / dumps; expanded for the primary text
// chunks section so the first thing the user sees is content.
function Section({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string
  count?: number
  defaultOpen?: boolean
  children: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="rounded-md border border-border/60 bg-surface-muted/15">
      <button
        type="button"
        onClick={(): void => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-secondary/40"
      >
        <ChevronRight
          className={
            "h-3 w-3 flex-shrink-0 text-muted-foreground/70 transition-transform " +
            (open ? "rotate-90" : "")
          }
          aria-hidden
          strokeWidth={2}
        />
        <span className="flex-1 font-mono text-[11.5px] font-medium text-foreground">
          {title}
        </span>
        {typeof count === "number" && (
          <span className="font-mono text-[10.5px] text-muted-foreground/70 tabular-nums">
            [{String(count)}]
          </span>
        )}
      </button>
      {open && <div className="border-t border-border/40 px-3 py-2">{children}</div>}
    </section>
  )
}

// Cards for chunk-text arrays. Reused for both `chunks` and
// `image_chunks` so behavior stays consistent.
function ChunkCards({ rows }: { rows: ChunkRow[] }): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
        Empty.
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {rows.map((ch) => (
        <article
          key={ch.index}
          className="rounded-md border border-border/60 bg-surface-muted/30 px-3 py-2"
        >
          <header className="mb-1 flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground/80">
            <span className="inline-flex items-center gap-0.5">
              <Hash className="h-3 w-3" aria-hidden strokeWidth={1.75} />
              {String(ch.index)}
            </span>
            {ch.pages.length > 0 && (
              <span className="text-muted-foreground/60">
                page {ch.pages.join(", ")}
              </span>
            )}
          </header>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-foreground/85">
            {ch.text || "(empty)"}
          </pre>
        </article>
      ))}
    </div>
  )
}

// Cards for chunks_map / image_chunks_map. Renders the metadata
// per chunk_index — page numbers, bbox, block_labels, headings,
// width/height. Skips fields that are absent.
function ChunkMetaCards({ entries }: { entries: ChunkMeta[] }): JSX.Element {
  if (entries.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
        Empty.
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {entries.map((m, i) => (
        <article
          key={`${String(m.chunk_index ?? i)}-${String(i)}`}
          className="rounded-md border border-border/60 bg-surface-muted/30 px-3 py-2"
        >
          <header className="mb-1 flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground/80">
            <span className="inline-flex items-center gap-0.5">
              <Hash className="h-3 w-3" aria-hidden strokeWidth={1.75} />
              {String(m.chunk_index ?? i)}
            </span>
            {Array.isArray(m.page_numbers) && m.page_numbers.length > 0 && (
              <span className="text-muted-foreground/60">
                page {m.page_numbers.join(", ")}
              </span>
            )}
          </header>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
            {Array.isArray(m.block_labels) && m.block_labels.length > 0 && (
              <>
                <dt className="text-muted-foreground/70">block_labels</dt>
                <dd className="break-words text-foreground/85">
                  {m.block_labels.join(", ")}
                </dd>
              </>
            )}
            {Array.isArray(m.headings) && m.headings.length > 0 && (
              <>
                <dt className="text-muted-foreground/70">headings</dt>
                <dd className="break-words text-foreground/85">
                  {m.headings.join(" › ")}
                </dd>
              </>
            )}
            {typeof m.bbox_l === "number" &&
              typeof m.bbox_t === "number" &&
              typeof m.bbox_r === "number" &&
              typeof m.bbox_b === "number" && (
                <>
                  <dt className="text-muted-foreground/70">bbox (l,t,r,b)</dt>
                  <dd className="text-foreground/85 tabular-nums">
                    {m.bbox_l.toFixed(2)}, {m.bbox_t.toFixed(2)},{" "}
                    {m.bbox_r.toFixed(2)}, {m.bbox_b.toFixed(2)}
                  </dd>
                </>
              )}
            {(typeof m.width === "number" || typeof m.height === "number") && (
              <>
                <dt className="text-muted-foreground/70">size (w×h)</dt>
                <dd className="text-foreground/85 tabular-nums">
                  {String(m.width ?? "?")} × {String(m.height ?? "?")}
                </dd>
              </>
            )}
          </dl>
        </article>
      ))}
    </div>
  )
}

function StringList({ items }: { items: string[] }): JSX.Element {
  if (items.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
        Empty.
      </div>
    )
  }
  return (
    <ol className="space-y-0.5 font-mono text-[11.5px] text-foreground/85">
      {items.map((s, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <span className="flex-shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
            {String(i)}
          </span>
          <span className="break-words">{s}</span>
        </li>
      ))}
    </ol>
  )
}

function TextBlock({ text }: { text: string }): JSX.Element {
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-foreground/85">
      {text || "(empty)"}
    </pre>
  )
}

// Treats a string-typed JSON field as JSON if it parses, else
// shows the raw string. Used for `metadata` and `bboxes_json`.
function JsonStringBlock({ value }: { value: string }): JSX.Element {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    parsed = null
  }
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/85">
      {parsed === null ? value : stringify(parsed)}
    </pre>
  )
}

// Singleton metadata strip up top — picks the handful of fields
// the user looks at first (app, entity, dates, summary length).
function MetaStrip({
  name,
  docId,
  fields,
}: {
  name: string
  docId: string
  fields: Record<string, unknown>
}): JSX.Element {
  const items: { k: string; v: string }[] = [
    { k: "docId", v: docId },
  ]
  for (const key of [
    "app",
    "entity",
    "document_id",
    "title",
    "duration",
    "width",
    "height",
  ] as const) {
    const v = fields[key]
    if (v !== undefined && v !== null && v !== "") {
      items.push({ k: key, v: String(v) })
    }
  }
  // dates as ms timestamps in vespa — render ISO for readability
  for (const key of ["document_date", "createdAt", "updatedAt"] as const) {
    const v = fields[key]
    if (typeof v === "number" && v > 0) {
      items.push({ k: key, v: new Date(v).toISOString().slice(0, 10) })
    }
  }
  return (
    <div className="border-b border-border bg-surface-muted/30 px-3 py-2">
      <div
        className="truncate text-[12.5px] font-medium text-foreground"
        title={name}
      >
        {name}
      </div>
      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10.5px]">
        {items.map(({ k, v }) => (
          <div key={k} className="flex min-w-0 gap-1">
            <dt className="flex-shrink-0 text-muted-foreground/70">{k}</dt>
            <dd className="truncate text-foreground/85" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function VespaDocView({ docId, name }: Props): JSX.Element {
  const [doc, setDoc] = useState<VespaDocInspect | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [rawOpen, setRawOpen] = useState<boolean>(false)

  useEffect((): (() => void) => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    getVespaDoc(docId)
      .then((d): void => {
        if (cancelled) return
        setDoc(d)
        setLoading(false)
      })
      .catch((e: unknown): void => {
        if (cancelled) return
        setErr(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return (): void => {
      cancelled = true
    }
  }, [docId])

  const sections = useMemo(() => {
    if (!doc) {
      return {
        chunks: [] as ChunkRow[],
        imageChunks: [] as ChunkRow[],
        chunksMap: [] as ChunkMeta[],
        imageChunksMap: [] as ChunkMeta[],
      }
    }
    const f = doc.fields
    return {
      chunks: joinChunks(
        pickArray(f, ["chunks_summary", "chunks"]),
        f["chunks_map"],
      ),
      imageChunks: joinChunks(
        pickArray(f, ["image_chunks_summary", "image_chunks"]),
        f["image_chunks_map"],
      ),
      chunksMap: Array.isArray(f["chunks_map"])
        ? (f["chunks_map"] as ChunkMeta[])
        : [],
      imageChunksMap: Array.isArray(f["image_chunks_map"])
        ? (f["image_chunks_map"] as ChunkMeta[])
        : [],
    }
  }, [doc])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden strokeWidth={1.75} />
        Loading Vespa document…
      </div>
    )
  }
  if (err) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertCircle className="h-5 w-5 text-destructive" aria-hidden strokeWidth={1.75} />
        <p className="text-[14px] font-medium text-foreground">
          Could not load the Vespa document
        </p>
        <p className="font-mono text-[11.5px] text-muted-foreground">{err}</p>
      </div>
    )
  }
  if (!doc) return <div />

  const f = doc.fields
  const tocChunks = (pickArray(f, ["toc_chunks_summary", "toc_chunks"]) ?? []).map(
    (s) => stripBolding(String(s)),
  )
  const headings = Array.isArray(f["headings"]) ? (f["headings"] as string[]) : []
  const blockLabels = Array.isArray(f["block_labels"])
    ? (f["block_labels"] as string[])
    : []
  const entitiesInvolved = Array.isArray(f["entities_involved"])
    ? (f["entities_involved"] as string[])
    : []
  const referencedIds = Array.isArray(f["referenced_ids"])
    ? (f["referenced_ids"] as string[])
    : []
  const panIds = Array.isArray(f["pan_ids"]) ? (f["pan_ids"] as string[]) : []
  const chunksPos = (pickArray(f, ["chunks_pos_summary", "chunks_pos"]) ?? []) as number[]
  const imageChunksPos = (pickArray(f, [
    "image_chunks_pos_summary",
    "image_chunks_pos",
  ]) ?? []) as number[]
  const aiSummary = typeof f["ai_summary"] === "string" ? (f["ai_summary"] as string) : ""
  const description =
    typeof f["description"] === "string" ? (f["description"] as string) : ""
  const metadata =
    typeof f["metadata"] === "string" ? (f["metadata"] as string) : ""
  const bboxesJson =
    typeof f["bboxes_json"] === "string" ? (f["bboxes_json"] as string) : ""

  return (
    <div className="flex h-full flex-col">
      <MetaStrip name={name} docId={doc.docId} fields={f} />

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {/* Primary: text chunks. Opens by default so the first
            thing the user sees is real content. */}
        {sections.chunks.length > 0 && (
          <Section title="chunks" count={sections.chunks.length} defaultOpen>
            <ChunkCards rows={sections.chunks} />
          </Section>
        )}

        {sections.imageChunks.length > 0 && (
          <Section title="image_chunks" count={sections.imageChunks.length}>
            <ChunkCards rows={sections.imageChunks} />
          </Section>
        )}

        {sections.chunksMap.length > 0 && (
          <Section title="chunks_map" count={sections.chunksMap.length}>
            <ChunkMetaCards entries={sections.chunksMap} />
          </Section>
        )}

        {sections.imageChunksMap.length > 0 && (
          <Section
            title="image_chunks_map"
            count={sections.imageChunksMap.length}
          >
            <ChunkMetaCards entries={sections.imageChunksMap} />
          </Section>
        )}

        {tocChunks.length > 0 && (
          <Section title="toc_chunks" count={tocChunks.length}>
            <StringList items={tocChunks} />
          </Section>
        )}

        {headings.length > 0 && (
          <Section title="headings" count={headings.length}>
            <StringList items={headings} />
          </Section>
        )}

        {blockLabels.length > 0 && (
          <Section title="block_labels" count={blockLabels.length}>
            <StringList items={blockLabels} />
          </Section>
        )}

        {entitiesInvolved.length > 0 && (
          <Section
            title="entities_involved"
            count={entitiesInvolved.length}
          >
            <StringList items={entitiesInvolved} />
          </Section>
        )}

        {referencedIds.length > 0 && (
          <Section title="referenced_ids" count={referencedIds.length}>
            <StringList items={referencedIds} />
          </Section>
        )}

        {panIds.length > 0 && (
          <Section title="pan_ids" count={panIds.length}>
            <StringList items={panIds} />
          </Section>
        )}

        {chunksPos.length > 0 && (
          <Section title="chunks_pos" count={chunksPos.length}>
            <StringList items={chunksPos.map((n) => String(n))} />
          </Section>
        )}

        {imageChunksPos.length > 0 && (
          <Section title="image_chunks_pos" count={imageChunksPos.length}>
            <StringList items={imageChunksPos.map((n) => String(n))} />
          </Section>
        )}

        {aiSummary && (
          <Section title="ai_summary">
            <TextBlock text={aiSummary} />
          </Section>
        )}

        {description && (
          <Section title="description">
            <TextBlock text={description} />
          </Section>
        )}

        {metadata && (
          <Section title="metadata">
            <JsonStringBlock value={metadata} />
          </Section>
        )}

        {bboxesJson && (
          <Section title="bboxes_json">
            <JsonStringBlock value={bboxesJson} />
          </Section>
        )}

        <div className="pt-2">
          <button
            type="button"
            onClick={(): void => setRawOpen((v) => !v)}
            className="inline-flex h-6 items-center rounded-md border border-border bg-surface-elevated px-2 text-[11px] text-muted-foreground transition hover:text-foreground"
          >
            {rawOpen ? "Hide raw Vespa fields" : "Show raw Vespa fields"}
          </button>
          {rawOpen && (
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-surface-muted/40 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-foreground/85">
              {stringify(f)}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
