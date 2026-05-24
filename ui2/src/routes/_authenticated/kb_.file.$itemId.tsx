// Standalone PDF viewer route. URL: /kb/file/:itemId?cl=:clId[&page=N]
//
// Thin wrapper around the shared <PdfViewer> — all virtualization, page
// indicator, zoom etc. live there so the CitationPanel can reuse the
// same component without an iframe.

import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"

import { DebugDock } from "@/components/DebugDock"
import { PdfViewer } from "@/components/PdfViewer"

type ViewerSearch = { cl?: string; page?: number }

export const Route = createFileRoute("/_authenticated/kb_/file/$itemId")({
  validateSearch: (raw: Record<string, unknown>): ViewerSearch => {
    const out: ViewerSearch = {}
    if (typeof raw["cl"] === "string" && raw["cl"] !== "") {
      out.cl = raw["cl"]
    }
    const pageRaw = raw["page"]
    const pageNum =
      typeof pageRaw === "string"
        ? Number(pageRaw)
        : typeof pageRaw === "number"
          ? pageRaw
          : NaN
    if (Number.isInteger(pageNum) && pageNum > 0) {
      out.page = pageNum
    }
    return out
  },
  component: PdfViewerRoute,
})

function PdfViewerRoute(): JSX.Element {
  const { itemId } = Route.useParams()
  const { cl, page } = Route.useSearch()
  const navigate = useNavigate()

  if (!cl) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-2 py-24 text-center">
        <p className="text-[14px] font-medium text-foreground">
          Missing collection
        </p>
        <p className="text-[12.5px] text-muted-foreground">
          This viewer link is missing the <code>cl</code> (collection) parameter.
        </p>
      </div>
    )
  }

  const goBack = (): void => {
    void navigate({ to: "/kb", search: { cl } })
  }

  return (
    <PdfViewer
      clId={cl}
      itemId={itemId}
      {...(page !== undefined ? { initialPage: page } : {})}
      // Render the DebugDock INSIDE the PdfViewer as rightSlot so
      // the toolbar above spans the union of PDF + DebugDock —
      // the user wanted the toolbar to claim the full width even
      // when the Vespa-document inspector opens on the right.
      rightSlot={<DebugDock />}
      leading={
        <button
          type="button"
          aria-label="Back to knowledge"
          onClick={goBack}
          className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
        </button>
      }
    />
  )
}
