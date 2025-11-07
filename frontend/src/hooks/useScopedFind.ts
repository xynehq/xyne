import { useCallback, useEffect, useState, useRef } from "react"
import { useDocumentOperations } from "@/contexts/DocumentOperationsContext"
import {
  findHighlightMatches,
  type HighlightMatch as ClientHighlightMatch,
} from "@/utils/textHighlighting"

type Options = {
  caseSensitive?: boolean
  highlightClass?: string
  activeClass?: string
  debug?: boolean // Enable debug logging
  documentId?: string // Document ID for caching
}

// Cache duration constant - defined at module scope to prevent re-declaration on each render
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

type CacheEntry = {
  matches: ClientHighlightMatch[]
  timestamp: number
}

type HighlightCache = {
  [key: string]: CacheEntry
}

const isScrollable = (element: HTMLElement): boolean => {
  const style = window.getComputedStyle(element)
  return (
    (style.overflowY === "auto" || 
     style.overflowY === "scroll" || 
     style.overflowY === "overlay") &&
    element.scrollHeight > element.clientHeight
  )
}

export function useScopedFind(
  containerRef: React.RefObject<HTMLElement>,
  opts: Options = {},
) {
  const { documentOperationsRef } = useDocumentOperations()
  const {
    caseSensitive = true,
    highlightClass = "bg-yellow-200/60 dark:bg-yellow-200/40 rounded-sm px-0.5 py-px",
    debug = false,
    documentId,
  } = opts

  // Cache for API responses
  const cacheRef = useRef<HighlightCache>({})

  // Cancellation token to prevent race conditions
  const callTokenRef = useRef<number>(0)

  const [matches, setMatches] = useState<HTMLElement[]>([])
  const [index, setIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(false)

  // Generate cache key based on document ID, chunk index, and options
  const generateCacheKey = useCallback(
    (
      docId: string | undefined,
      chunkIdx: number | null | undefined,
    ): string => {
      const keyComponents = [
        docId || "no-doc-id",
        chunkIdx !== null && chunkIdx !== undefined
          ? chunkIdx.toString()
          : "no-chunk-idx",
      ]
      return keyComponents.join("|")
    },
    [],
  )

  // Clean expired cache entries
  const cleanExpiredCache = useCallback(() => {
    const now = Date.now()
    const cache = cacheRef.current
    Object.keys(cache).forEach((key) => {
      if (now - cache[key].timestamp > CACHE_DURATION) {
        delete cache[key]
      }
    })
  }, [])

  // Extract text content from the container
  const extractContainerText = useCallback((container: HTMLElement): string => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = (n as Text).parentElement
        if (!p) return NodeFilter.FILTER_REJECT
        const tag = p.tagName.toLowerCase()
        if (tag === "script" || tag === "style") return NodeFilter.FILTER_REJECT
        if (!(n as Text).nodeValue?.trim()) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })

    let text = ""
    let node: Node | null
    while ((node = walker.nextNode())) {
      text += (node as Text).nodeValue
    }

    return text
  }, [])

  // Detect if we're in a PDF context
  const isPDFContext = useCallback((container: HTMLElement): boolean => {
    // Check if container or any parent has PDF-specific classes
    let element: HTMLElement | null = container
    while (element) {
      if (
        element.classList.contains("react-pdf__Page") ||
        element.classList.contains("pdf-page-wrapper") ||
        element.classList.contains("simple-pdf-viewer") ||
        element.querySelector(".react-pdf__Page") !== null
      ) {
        return true
      }
      element = element.parentElement
    }
    return false
  }, [])

  // Create highlight marks using <mark> elements (for non-PDF content)
  const createMarkHighlights = useCallback(
    (container: HTMLElement, match: ClientHighlightMatch): HTMLElement[] => {
      const marks: HTMLElement[] = []

      try {
        // Find all text nodes and their positions
        const walker = document.createTreeWalker(
          container,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode(n) {
              const p = (n as Text).parentElement
              if (!p) return NodeFilter.FILTER_REJECT
              const tag = p.tagName.toLowerCase()
              if (tag === "script" || tag === "style")
                return NodeFilter.FILTER_REJECT
              if (!n.nodeValue?.trim()) return NodeFilter.FILTER_REJECT
              return NodeFilter.FILTER_ACCEPT
            },
          },
        )

        const textNodes: { node: Text; start: number; end: number }[] = []
        let currentPos = 0
        let node: Node | null

        // Build a map of text nodes and their positions
        while ((node = walker.nextNode())) {
          const textNode = node as Text
          const nodeLength = textNode.nodeValue!.length
          textNodes.push({
            node: textNode,
            start: currentPos,
            end: currentPos + nodeLength,
          })
          currentPos += nodeLength
        }

        // Find all text nodes that intersect with our match
        const intersectingNodes = textNodes.filter(
          ({ start, end }) => start < match.endIndex && end > match.startIndex,
        )

        for (const { node: textNode, start: nodeStart } of intersectingNodes) {
          const startOffset = Math.max(0, match.startIndex - nodeStart)
          const endOffset = Math.min(
            textNode.nodeValue!.length,
            match.endIndex - nodeStart,
          )

          if (startOffset < endOffset) {
            try {
              const range = document.createRange()
              range.setStart(textNode, startOffset)
              range.setEnd(textNode, endOffset)

              // Create and insert the mark
              const mark = document.createElement("mark")
              mark.className = `${highlightClass}`
              mark.setAttribute("data-match-index", "0")

              try {
                range.surroundContents(mark)
                marks.push(mark)
              } catch (rangeError) {
                console.warn(
                  "Failed to wrap range with mark, trying alternative approach:",
                  rangeError,
                )

                // Alternative: split text node and insert mark
                const originalText = textNode.nodeValue!
                const beforeText = textNode.nodeValue!.substring(0, startOffset)
                const matchText = textNode.nodeValue!.substring(
                  startOffset,
                  endOffset,
                )
                const afterText = textNode.nodeValue!.substring(endOffset)

                try {
                  // Replace the text node content with before text
                  textNode.nodeValue = beforeText

                  // Create and insert the mark
                  const mark = document.createElement("mark")
                  mark.className = `${highlightClass}`
                  mark.setAttribute("data-match-index", "0")
                  mark.textContent = matchText

                  // Insert mark after the text node
                  textNode.parentNode!.insertBefore(mark, textNode.nextSibling)
                  marks.push(mark)

                  // Insert remaining text after the mark
                  if (afterText) {
                    const afterNode = document.createTextNode(afterText)
                    mark.parentNode!.insertBefore(afterNode, mark.nextSibling)
                  }
                } catch (fallbackError) {
                  // Restore original text on error
                  textNode.nodeValue = originalText
                  console.error(
                    "Fallback highlighting approach failed:",
                    fallbackError,
                  )
                }
              }
            } catch (error) {
              console.warn(
                "Error processing text node for highlighting:",
                error,
              )
            }
          }
        }
      } catch (error) {
        console.error("Error creating highlight marks:", error)
      }

      return marks
    },
    [highlightClass],
  )

  // Create highlight overlays using positioned spans (for PDF content)
  const createOverlayHighlights = useCallback(
    (container: HTMLElement, match: ClientHighlightMatch): HTMLElement[] => {
      const marks: HTMLElement[] = []

      try {
        // Find all text nodes and their positions
        const walker = document.createTreeWalker(
          container,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode(n) {
              const p = (n as Text).parentElement
              if (!p) return NodeFilter.FILTER_REJECT
              const tag = p.tagName.toLowerCase()
              if (tag === "script" || tag === "style")
                return NodeFilter.FILTER_REJECT
              if (!n.nodeValue?.trim()) return NodeFilter.FILTER_REJECT
              return NodeFilter.FILTER_ACCEPT
            },
          },
        )

        const textNodes: { node: Text; start: number; end: number }[] = []
        let currentPos = 0
        let node: Node | null

        // Build a map of text nodes and their positions
        while ((node = walker.nextNode())) {
          const textNode = node as Text
          const nodeLength = textNode.nodeValue!.length
          textNodes.push({
            node: textNode,
            start: currentPos,
            end: currentPos + nodeLength,
          })
          currentPos += nodeLength
        }

        // Find all text nodes that intersect with our match
        const intersectingNodes = textNodes.filter(
          ({ start, end }) => start < match.endIndex && end > match.startIndex,
        )

        for (const { node: textNode, start: nodeStart } of intersectingNodes) {
          const startOffset = Math.max(0, match.startIndex - nodeStart)
          const endOffset = Math.min(
            textNode.nodeValue!.length,
            match.endIndex - nodeStart,
          )

          if (startOffset < endOffset) {
            try {
              const range = document.createRange()
              range.setStart(textNode, startOffset)
              range.setEnd(textNode, endOffset)

              const rects = range.getClientRects()

              // Find a suitable positioning context for the highlight overlay
              let pageWrapper: HTMLElement | null = textNode.parentElement

              // Look for PDF-specific wrappers first
              while (pageWrapper && pageWrapper !== container) {
                if (
                  pageWrapper.classList.contains("pdf-page-wrapper") ||
                  pageWrapper.classList.contains("react-pdf__Page")
                ) {
                  break
                }
                pageWrapper = pageWrapper.parentElement
              }

              // If no PDF wrapper found, look for any positioned element
              if (!pageWrapper || pageWrapper === container) {
                pageWrapper = textNode.parentElement
                while (pageWrapper && pageWrapper !== container) {
                  const style = window.getComputedStyle(pageWrapper)
                  if (
                    style.position === "relative" ||
                    style.position === "absolute"
                  ) {
                    break
                  }
                  pageWrapper = pageWrapper.parentElement
                }
              }

              // Fall back to container
              if (!pageWrapper || pageWrapper === container) {
                pageWrapper = container
              }

              const pageStyle = window.getComputedStyle(pageWrapper)
              if (pageStyle.position === "static") {
                pageWrapper.style.position = "relative"
              }

              let overlayContainer = pageWrapper.querySelector<HTMLElement>(
                "[data-highlight-overlay]",
              )
              if (!overlayContainer) {
                overlayContainer = document.createElement("div")
                overlayContainer.setAttribute("data-highlight-overlay", "true")
                overlayContainer.style.cssText = `
                  position: absolute;
                  top: 0;
                  left: 0;
                  width: 100%;
                  height: 100%;
                  pointer-events: none;
                  z-index: 999;
                `
                pageWrapper.appendChild(overlayContainer)
              }

              const pageRect = pageWrapper.getBoundingClientRect()

              for (let i = 0; i < rects.length; i++) {
                const rect = rects[i]

                if (rect.width === 0 || rect.height === 0) continue

                const overlay = document.createElement("span")
                overlay.className = "pdf-highlight-overlay"
                overlay.setAttribute("data-match-index", "0")

                const left = rect.left - pageRect.left
                const top = rect.top - pageRect.top

                overlay.style.cssText = `
                  position: absolute;
                  left: ${left}px;
                  top: ${top}px;
                  width: ${rect.width}px;
                  height: ${rect.height}px;
                  background-color: rgba(250, 204, 21, 0.4);
                  pointer-events: none;
                  z-index: 1000;
                  border-radius: 2px;
                `

                overlayContainer.appendChild(overlay)
                marks.push(overlay)
              }
            } catch (error) {
              console.warn("Error creating overlay highlight:", error)
            }
          }
        }
      } catch (error) {
        console.error("Error creating overlay highlights:", error)
      }

      return marks
    },
    [],
  )

  // Main highlight creation function that chooses the right strategy
  const createHighlightMarks = useCallback(
    (container: HTMLElement, match: ClientHighlightMatch): HTMLElement[] => {
      const isPDF = isPDFContext(container)

      if (debug) {
        console.log(`Using ${isPDF ? "overlay" : "mark"} highlighting strategy`)
      }

      return isPDF
        ? createOverlayHighlights(container, match)
        : createMarkHighlights(container, match)
    },
    [isPDFContext, createOverlayHighlights, createMarkHighlights, debug],
  )

  const clearHighlights = useCallback(() => {
    const root = containerRef.current
    if (!root) return

    // Clear mark-based highlights
    const marks = root.querySelectorAll<HTMLElement>("mark[data-match-index]")
    marks.forEach((m) => {
      const parent = m.parentNode!
      // unwrap <mark>
      while (m.firstChild) parent.insertBefore(m.firstChild, m)
      parent.removeChild(m)
      parent.normalize() // merge adjacent text nodes
    })

    // Clear overlay-based highlights (for PDFs)
    const overlayContainers = root.querySelectorAll<HTMLElement>(
      "[data-highlight-overlay]",
    )
    overlayContainers.forEach((container) => {
      container.remove()
    })

    const individualOverlays = root.querySelectorAll<HTMLElement>(
      ".pdf-highlight-overlay",
    )
    individualOverlays.forEach((overlay) => {
      overlay.remove()
    })

    setMatches([])
    setIndex(0)
  }, [containerRef])

  // Wait for text layer to be fully rendered and positioned
  const waitForTextLayerReady = useCallback(
    async (container: HTMLElement, timeoutMs = 5000): Promise<string> => {
      return new Promise((resolve) => {
        const startTime = Date.now()
        let lastTextLength = 0
        let text = ""
        let stableCount = 0
        const requiredStableChecks = 3

        const checkTextLayer = () => {
          const currentTime = Date.now()
          if (currentTime - startTime > timeoutMs) {
            if (debug) {
              console.log("Text layer wait timeout reached")
            }
            resolve(text)
            return
          }

          // Extract current text length
          text = extractContainerText(container)
          const currentTextLength = text.length

          if (debug && currentTextLength !== lastTextLength) {
            console.log(
              `Text layer length changed: ${lastTextLength} -> ${currentTextLength}`,
            )
          }

          // Check if text length has stabilized
          if (currentTextLength === lastTextLength && currentTextLength > 0) {
            stableCount++
            if (stableCount >= requiredStableChecks) {
              if (debug) {
                console.log(
                  `Text layer stabilized at length ${currentTextLength}`,
                )
              }
              resolve(text)
              return
            }
          } else {
            stableCount = 0
          }

          lastTextLength = currentTextLength

          // Use requestAnimationFrame for the next check to ensure DOM updates are processed
          requestAnimationFrame(() => {
            setTimeout(checkTextLayer, 50) // Check every 50ms
          })
        }

        // Start checking after one animation frame
        requestAnimationFrame(checkTextLayer)
      })
    },
    [extractContainerText, debug],
  )

  const highlightText = useCallback(
    async (
      text: string,
      chunkIndex: number,
      pageIndex?: number,
      waitForTextLayer: boolean = false,
    ): Promise<boolean> => {
      // Increment call token to track this invocation
      const currentToken = ++callTokenRef.current
      
      if (debug) {
        console.log("highlightText called with:", text, "token:", currentToken)
      }

      const root = containerRef.current
      if (!root) {
        if (debug) console.log("No container ref found")
        return false
      }

      if (debug) {
        console.log("Container found:", root)
      }

      clearHighlights()
      if (!text) return false

      setIsLoading(true)

      try {
        let containerText = ""
        // For PDFs, ensure the page is rendered before extracting text
        if (documentOperationsRef?.current?.goToPage) {
          if (debug) {
            console.log("PDF or Spreadsheet detected", pageIndex)
          }
          if (pageIndex !== undefined && pageIndex >= 0) {
            if (debug) {
              console.log("Going to page or subsheet:", pageIndex)
            }
            await documentOperationsRef.current.goToPage(pageIndex)

            // Wait for text layer to be fully rendered and positioned
            if (debug) {
              console.log("Waiting for text layer to be ready...")
            }
            containerText = await waitForTextLayerReady(root)
            if (debug) {
              console.log("Text layer ready, proceeding with highlighting")
            }
          } else {
            if (debug) {
              console.log(
                "No page or subsheet index provided, skipping highlight",
              )
            }
            return false
          }
        } else {
          if (waitForTextLayer) {
            containerText = await waitForTextLayerReady(root)
          } else {
            containerText = extractContainerText(root)
          }
        }

        if (debug) {
          console.log("Container text extracted, length:", containerText.length)
        }

        // Clean expired cache entries
        cleanExpiredCache()

        // Generate cache key
        const canUseCache = !!documentId
        const cacheKey = canUseCache
          ? generateCacheKey(documentId, chunkIndex)
          : ""

        // Check cache first (only if safe)
        const cachedEntry = canUseCache ? cacheRef.current[cacheKey] : undefined
        let matches: ClientHighlightMatch[]

        if (
          cachedEntry &&
          Date.now() - cachedEntry.timestamp < CACHE_DURATION
        ) {
          if (debug) {
            console.log("Using cached result for key:", cacheKey)
          }
          
          // Check if this call is still the latest before using cached results
          if (currentToken !== callTokenRef.current) {
            if (debug) {
              console.log("Stale call detected after cache lookup, aborting")
            }
            return false
          }
          
          matches = cachedEntry.matches
        } else {
          if (debug) {
            console.log(
              "Cache miss, computing highlights client-side for key:",
              cacheKey,
            )
          }

          // Use client-side highlighting instead of API call
          const result = findHighlightMatches(text, containerText, {
            caseSensitive,
          })

          if (debug) {
            console.log("Client-side highlighting result:", result)
          }

          if (
            !result.success ||
            !result.matches ||
            result.matches.length === 0
          ) {
            if (debug) {
              console.log("No matches found:", result.message)
            }
            return false
          }

          // Check if this call is still the latest before processing results
          if (currentToken !== callTokenRef.current) {
            if (debug) {
              console.log("Stale call detected after computing matches, aborting")
            }
            return false
          }

          matches = result.matches

          // Only cache successful responses and only when safe
          if (canUseCache) {
            cacheRef.current[cacheKey] = {
              matches,
              timestamp: Date.now(),
            }

            if (debug) {
              console.log("Cached successful result for key:", cacheKey)
            }
          } else if (!canUseCache && debug) {
            console.log("Skipping cache write (no documentId)")
          }
        }

        // Check if this call is still the latest before creating DOM highlights
        if (currentToken !== callTokenRef.current) {
          if (debug) {
            console.log("Stale call detected before creating highlights, aborting")
          }
          return false
        }

        // Create highlight marks for all matches
        const allMarks: HTMLElement[] = []
        let longestMatchIndex = 0
        let longestMatchLength = 0

        matches.forEach((match, matchIndex) => {
          const marks = createHighlightMarks(root, match)

          marks.forEach((mark) => {
            mark.setAttribute("data-match-index", matchIndex.toString())
          })

          allMarks.push(...marks)

          if (match.length > longestMatchLength) {
            longestMatchLength = match.length
            longestMatchIndex = allMarks.length - marks.length
          }
        })

        if (debug) {
          console.log(
            `Created ${allMarks.length} highlight marks from ${matches.length} matches`,
          )
          console.log(
            `Longest match index: ${longestMatchIndex} with length: ${longestMatchLength}`,
          )
        }

        // Final check before updating state
        if (currentToken !== callTokenRef.current) {
          if (debug) {
            console.log("Stale call detected before state update, aborting and cleaning up DOM")
          }
          // Clean up the highlights we just created since this call is stale
          allMarks.forEach((mark) => {
            if (mark.parentNode) {
              if (mark.tagName === "MARK") {
                // Unwrap mark elements
                while (mark.firstChild) {
                  mark.parentNode.insertBefore(mark.firstChild, mark)
                }
                mark.parentNode.removeChild(mark)
              } else {
                // Remove overlay elements
                mark.remove()
              }
            }
          })
          return false
        }

        setMatches(allMarks)
        setIndex(longestMatchIndex)

        return allMarks.length > 0
      } catch (error) {
        console.error("Error during client-side highlighting:", error)
        return false
      } finally {
        // Only update loading state if this is still the latest call
        if (currentToken === callTokenRef.current) {
          setIsLoading(false)
        }
      }
    },
    [
      clearHighlights,
      containerRef,
      extractContainerText,
      createHighlightMarks,
      caseSensitive,
      debug,
      documentId,
      generateCacheKey,
      cleanExpiredCache,
    ],
  )

  const scrollToMatch = useCallback(
    (matchIndex: number = 0) => {
      if (!matches.length || !containerRef.current) return false
      const bounded =
        ((matchIndex % matches.length) + matches.length) % matches.length

      const container = containerRef.current
      const target = matches[bounded]

      // Check if container is scrollable, if not find the scrollable parent

      let scrollParent: HTMLElement = container
      
      if (!isScrollable(container)) {
        // Container is not scrollable, find the scrollable parent
        let parent = container.parentElement
        while (parent) {
          if (isScrollable(parent)) {
            scrollParent = parent
            break
          }
          parent = parent.parentElement
        }
        
        // If no scrollable parent found, use document element
        if (!parent) {
          scrollParent = document.documentElement
        }
      }

      // Use custom scroll logic for proper centering
      if (scrollParent !== document.documentElement) {
        const containerRect = scrollParent.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()

        const targetTop = targetRect.top - containerRect.top
        const containerHeight = scrollParent.clientHeight
        const targetHeight = targetRect.height

        const scrollTop =
          scrollParent.scrollTop +
          targetTop -
          containerHeight / 2 +
          targetHeight / 2

        scrollParent.scrollTo({
          top: Math.max(0, scrollTop),
          behavior: "smooth",
        })
      } else {
        target.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "smooth",
        })
      }

      setIndex(bounded)
      return true
    },
    [matches, containerRef],
  )

  // Auto-scroll to the current index (which is set to the longest match) whenever matches update
  useEffect(() => {
    if (matches.length) {
      // Small delay to ensure DOM is fully updated, especially for mark elements
      const timeoutId = setTimeout(() => {
        scrollToMatch(index)
      }, 50)
      
      return () => clearTimeout(timeoutId)
    }
  }, [matches, index, scrollToMatch])

  // Clean up when container unmounts
  useEffect(() => () => clearHighlights(), [clearHighlights])

  // Clean up expired cache entries periodically
  useEffect(() => {
    const interval = setInterval(() => {
      cleanExpiredCache()
    }, CACHE_DURATION / 2) // Clean every 2.5 minutes

    return () => clearInterval(interval)
  }, [cleanExpiredCache])

  return {
    highlightText,
    clearHighlights,
    scrollToMatch,
    matches,
    index,
    isLoading,
  }
}
