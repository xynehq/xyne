import React, { useState } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export interface Citation {
  url: string
  title: string
  itemId?: string
  clId?: string
  chunkIndex?: number
}

export const createCitationLink =
  (
    citations: Citation[] = [],
    onCitationClick?: (citation: Citation, chunkIndex?: number) => void,
    showTooltip: boolean = true,
  ) =>
  ({
    href,
    children,
    ...linkProps
  }: {
    href?: string
    children?: React.ReactNode
    [key: string]: any
  }) => {
    const [isTooltipOpen, setIsTooltipOpen] = useState(false)

    // Extract citation index from children (which should be the citation number like "1", "2", etc.)
    const citationIndex =
      typeof children === "string" ? parseInt(children) - 1 : -1

    // Get citation by index if valid, otherwise fall back to URL matching
    const citation =
      citationIndex >= 0 && citationIndex < citations.length
        ? citations[citationIndex]
        : href
          ? citations.find((c) => c.url === href)
          : undefined

    if (citation && citation.clId && citation.itemId && !(citation.title.endsWith(".pdf") && citation.chunkIndex !== undefined)) {
      return (
        <TooltipProvider delayDuration={200}>
          <Tooltip open={isTooltipOpen} onOpenChange={setIsTooltipOpen}>
            <TooltipTrigger asChild>
              <span
                {...linkProps}
                className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-[6px] py-[2px] mx-[2px] bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-800 text-black-700 dark:text-gray-300 rounded-full text-[10px] font-mono font-medium cursor-pointer transition-colors duration-150"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onCitationClick) {
                    if (citation.chunkIndex !== undefined) {
                      onCitationClick(citation, citation.chunkIndex)
                    } else {
                      onCitationClick(citation)
                    }
                  }
                  setIsTooltipOpen(false)
                }}
              >
                {children}
              </span>
            </TooltipTrigger>
            {showTooltip && (
            <TooltipContent
              side="top"
              align="center"
              className="max-w-sm p-0 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-700 shadow-lg rounded-lg overflow-hidden"
              onPointerDownOutside={(e) => {
                // Prevent closing when clicking inside the tooltip
                e.preventDefault()
              }}
            >
              <div
                className="flex items-start gap-3 p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onCitationClick) {
                    onCitationClick(citation)
                  }
                  setIsTooltipOpen(false)
                }}
              >
                {/* Document Icon */}
                <div className="flex-shrink-0 mt-0.5">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className="text-gray-600 dark:text-gray-400"
                  >
                    <path
                      d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                    <polyline
                      points="14,2 14,8 20,8"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                  </svg>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm text-gray-900 dark:text-gray-100 leading-tight truncate">
                    {citation.title.split("/").pop() || "Untitled Document"}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-tight truncate">
                    {citation.title.replace(/[^/]*$/, "") || "No file name"}
                  </div>
                </div>
              </div>
            </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
      )
    }

    // Regular link for non-citation URLs
    const isNumericChild =
      typeof children === "string" &&
      !isNaN(parseInt(children)) &&
      parseInt(children).toString() === children.trim()

    return (
      <a {...linkProps} href={href} target="_blank" rel="noopener noreferrer">
        {isNumericChild ? !(citation && citation.title?.endsWith(".pdf") && citation.chunkIndex !== undefined) ? (
          <span
            className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-[6px] py-[2px] mx-[2px] bg-gray-200 hover:bg-gray-300 dark:bg-gray-900 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-full text-[10px] font-mono font-medium cursor-pointer transition-colors duration-150 no-underline"
            style={{ textDecoration: "none" }}
          >
            {children}
          </span>
        ) : undefined : ( children )}
      </a>
    )
  }
