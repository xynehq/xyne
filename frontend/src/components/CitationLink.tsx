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
  kbId?: string
}

export const createCitationLink =
  (
    citations: Citation[] = [],
    onCitationClick?: (citation: Citation) => void,
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

    // Identify if this link matches one of our citations by URL
    const citation = href ? citations.find((c) => c.url === href) : undefined

    if (citation) {
      return (
        <TooltipProvider delayDuration={200}>
          <Tooltip open={isTooltipOpen} onOpenChange={setIsTooltipOpen}>
            <TooltipTrigger asChild>
              <span
                {...linkProps}
                className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-[6px] py-[2px] mx-[2px] bg-gray-200 hover:bg-gray-300 dark:bg-gray-900 dark:hover:bg-gray-800 text-black-700 dark:text-gray-300 rounded-full text-[10px] font-mono font-medium cursor-pointer transition-colors duration-150"
              >
                {children}
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="center"
              className="max-w-sm p-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg rounded-lg overflow-hidden"
              onPointerDownOutside={(e) => {
                // Prevent closing when clicking inside the tooltip
                e.preventDefault()
              }}
            >
              <div
                className="flex items-start gap-3 p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
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
          </Tooltip>
        </TooltipProvider>
      )
    }

    // Regular link for non-citation URLs
    return (
      <a
        {...linkProps}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-[6px] py-[2px] mx-[2px] bg-gray-200 hover:bg-gray-300 dark:bg-gray-900 dark:hover:bg-gray-800 text-black-700 dark:text-gray-300 rounded-full text-[10px] font-mono font-medium cursor-pointer transition-colors duration-150"
      >
        {children}
      </a>
    )
  }
