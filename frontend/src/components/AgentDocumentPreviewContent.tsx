import React, { useMemo, useState } from "react"
import MarkdownPreview from "@uiw/react-markdown-preview"
import { BookOpen, Lightbulb, ExternalLink } from "lucide-react"
import { useTheme } from "@/components/ThemeContext"
import { MermaidCodeWrapper } from "@/hooks/useMermaidRenderer"
import { processMessage, createTableComponents } from "@/utils/chatUtils.tsx"

export interface AgentDocumentPayload {
  externalId?: string
  title?: string
  agentName: string
  content: string
  summary?: string | null
  reasoning?: string | null
  citations?: AgentSourceCitation[]
  confidence?: number | null
  createdAt: string
}

export interface AgentSourceCitation {
  docId: string
  title: string
  url?: string
  app: string
  entity: string
  chunkContent?: string
}

interface AgentDocumentPreviewContentProps {
  document: AgentDocumentPayload
}

/**
 * Validates and normalizes a URL string to ensure it's safe to use as an href.
 * Only allows http: and https: schemes. Returns null if unsafe or invalid.
 */
function normalizeSafeHref(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null
    }
    return parsed.href
  } catch {
    return null
  }
}

/**
 * Tables for agent preview: avoid `minWidth: 100%` + `dark:bg-slate-800` on `<table>` from
 * createTableComponents — that combo leaves a wide slate strip on the right in narrow panels
 * when column content is shorter than the container.
 */
function createAgentDocumentTableComponents() {
  const base = createTableComponents()
  return {
    ...base,
    table: ({ node, ...props }: any) => (
      <div className="my-2 w-full min-w-0 max-w-full overflow-x-auto">
        <table
          style={{
            borderCollapse: "collapse",
            borderStyle: "hidden",
            tableLayout: "auto",
            maxWidth: "100%",
          }}
          className="bg-transparent dark:bg-transparent"
          {...props}
        />
      </div>
    ),
  }
}

/** Same Markdown pipeline as assistant messages in chat.tsx (minus citation links). */
function AgentResponseMarkdown({ source }: { source: string }) {
  const { theme } = useTheme()
  const tableComponents = useMemo(() => createAgentDocumentTableComponents(), [])
  const components = useMemo(
    () => ({
      code: MermaidCodeWrapper,
      ...tableComponents,
      h1: ({ node, ...props }: any) => (
        <h1
          style={{ fontSize: "1.6em" }}
          className="dark:text-gray-100"
          {...props}
        />
      ),
      h2: ({ node, ...props }: any) => (
        <h2 style={{ fontSize: "1.2em" }} {...props} />
      ),
      h3: ({ node, ...props }: any) => (
        <h3 style={{ fontSize: "1em" }} {...props} />
      ),
      h4: ({ node, ...props }: any) => (
        <h4 style={{ fontSize: "0.8em" }} {...props} />
      ),
      h5: ({ node, ...props }: any) => (
        <h5 style={{ fontSize: "0.7em" }} {...props} />
      ),
      h6: ({ node, ...props }: any) => (
        <h6 style={{ fontSize: "0.68em" }} {...props} />
      ),
      ul: ({ node, ...props }: any) => (
        <ul
          style={{
            listStyleType: "disc",
            paddingLeft: "1.5rem",
            marginBottom: "1rem",
          }}
          {...props}
        />
      ),
      ol: ({ node, ...props }: any) => (
        <ol
          style={{
            listStyleType: "decimal",
            paddingLeft: "1.5rem",
            marginBottom: "1rem",
          }}
          {...props}
        />
      ),
      li: ({ node, ...props }: any) => (
        <li
          style={{
            marginBottom: "0.25rem",
          }}
          {...props}
        />
      ),
    }),
    [tableComponents],
  )

  const processed = processMessage(source, undefined, [], [])

  return (
    <div className="markdown-content w-full min-w-0">
      <MarkdownPreview
        source={processed}
        wrapperElement={{
          "data-color-mode": theme,
        }}
        style={{
          padding: 0,
          backgroundColor: "transparent",
          color: theme === "dark" ? "#F1F3F4" : "#1C1D1F",
          maxWidth: "100%",
          overflowWrap: "break-word",
          wordBreak: "break-word",
          minWidth: 0,
        }}
        components={components}
      />
    </div>
  )
}

/**
 * Tabbed body for delegated agent output (used inside CitationPreview).
 */
const AgentDocumentPreviewContent: React.FC<AgentDocumentPreviewContentProps> = ({
  document: doc,
}) => {
  const [activeTab, setActiveTab] = useState<"content" | "reasoning" | "sources">(
    "content",
  )

  const citations = doc.citations ?? []

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-[#1E1E1E] shrink-0">
        <button
          type="button"
          onClick={() => setActiveTab("content")}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === "content"
              ? "text-blue-600 border-b-2 border-blue-600"
              : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
          }`}
        >
          <BookOpen className="w-4 h-4" />
          Output
        </button>
        {doc.reasoning ? (
          <button
            type="button"
            onClick={() => setActiveTab("reasoning")}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === "reasoning"
                ? "text-blue-600 border-b-2 border-blue-600"
                : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
            }`}
          >
            <Lightbulb className="w-4 h-4" />
            Reasoning
          </button>
        ) : null}
        {citations.length > 0 ? (
          <button
            type="button"
            onClick={() => setActiveTab("sources")}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === "sources"
                ? "text-blue-600 border-b-2 border-blue-600"
                : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
            }`}
          >
            <ExternalLink className="w-4 h-4" />
            Sources ({citations.length})
          </button>
        ) : null}
      </div>

      <div className="flex-1 overflow-auto p-6 min-h-0">
        {activeTab === "content" && (
          <div className="max-w-none">
            {doc.summary ? (
              <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg mb-6 border-l-4 border-blue-400">
                <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-300 mb-2">
                  Summary
                </h4>
                <div className="text-sm text-blue-800 dark:text-blue-200">
                  <AgentResponseMarkdown source={doc.summary} />
                </div>
              </div>
            ) : null}
            <AgentResponseMarkdown source={doc.content} />
            {doc.confidence != null ? (
              <div className="mt-6 pt-4 border-t dark:border-gray-700">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Confidence:</span>
                  <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-500 rounded-full"
                      style={{ width: `${Number(doc.confidence) * 100}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium">
                    {Math.round(Number(doc.confidence) * 100)}%
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {activeTab === "reasoning" && doc.reasoning ? (
          <div className="max-w-none">
            <div className="bg-amber-50 dark:bg-amber-900/20 p-4 rounded-lg border-l-4 border-amber-400">
              <h4 className="text-sm font-semibold text-amber-900 dark:text-amber-300 mb-2">
                Agent Reasoning
              </h4>
            </div>
            <div className="mt-4">
              <AgentResponseMarkdown source={doc.reasoning} />
            </div>
          </div>
        ) : null}

        {activeTab === "sources" && citations.length > 0 ? (
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">
              Documents Used by Agent
            </h4>
            {citations.map((c, idx) => (
              <div
                key={idx}
                className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <h5 className="font-medium text-gray-900 dark:text-gray-100 truncate">
                      {c.title || "Untitled Document"}
                    </h5>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {c.app} • {c.entity}
                    </p>
                    {c.chunkContent ? (
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 line-clamp-3">
                        {c.chunkContent}
                      </p>
                    ) : null}
                  </div>
                  {(() => {
                    const safeUrl = normalizeSafeHref(c.url)
                    return safeUrl ? (
                      <a
                        href={safeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 text-gray-400 hover:text-blue-600 shrink-0"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    ) : null
                  })()}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default AgentDocumentPreviewContent
