import { useCallback, useEffect, useState, useRef } from "react"
import { api } from "@/api"
import { useDocumentOperations } from "@/contexts/DocumentOperationsContext"

type Options = {
  caseSensitive?: boolean
  highlightClass?: string
  activeClass?: string
  debug?: boolean // Enable debug logging
  documentId?: string // Document ID for caching
}

type HighlightMatch = {
  startIndex: number
  endIndex: number
  length: number
  similarity: number
  highlightedText: string
  originalLine?: string
  processedLine?: string
}

type HighlightResponse = {
  success: boolean
  matches?: HighlightMatch[]
  totalMatches?: number
  message?: string
  debug?: any
}

type CacheEntry = {
  response: HighlightResponse
  timestamp: number
}

type HighlightCache = {
  [key: string]: CacheEntry
}

// Cache duration constant - defined at module scope to prevent re-declaration on each render
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

export function useScopedFind(
  containerRef: React.RefObject<HTMLElement>,
  opts: Options = {},
) {
  const { documentOperationsRef } = useDocumentOperations()
  const {
    caseSensitive = true,
    debug = false,
    documentId,
  } = opts

  // Cache for API responses
  const cacheRef = useRef<HighlightCache>({})

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

  // Create highlight marks based on backend response
  const createHighlightMarks = useCallback(
    (container: HTMLElement, match: HighlightMatch): HTMLElement[] => {
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

            
              let pageWrapper: HTMLElement | null = textNode.parentElement
              while (pageWrapper && pageWrapper !== container) {
                if (pageWrapper.classList.contains('pdf-page-wrapper') ||
                    pageWrapper.classList.contains('react-pdf__Page')) {
                  break
                }
                pageWrapper = pageWrapper.parentElement
              }

            
              if (!pageWrapper || pageWrapper === container) {
                pageWrapper = textNode.parentElement
                while (pageWrapper && pageWrapper !== container) {
                  const style = window.getComputedStyle(pageWrapper)
                  if (style.position === 'relative' || style.position === 'absolute') {
                    break
                  }
                  pageWrapper = pageWrapper.parentElement
                }
              }

              
              if (!pageWrapper || pageWrapper === container) {
                console.warn('No page wrapper found, using container')
                pageWrapper = container
              }

            
              const pageStyle = window.getComputedStyle(pageWrapper)
              if (pageStyle.position === 'static') {
                pageWrapper.style.position = 'relative'
              }

         
              let overlayContainer = pageWrapper.querySelector<HTMLElement>('.highlight-overlay-layer')
              if (!overlayContainer) {
                overlayContainer = document.createElement('div')
                overlayContainer.className = 'highlight-overlay-layer'
                pageWrapper.appendChild(overlayContainer)
              }

             
              const pageRect = pageWrapper.getBoundingClientRect()


              for (let i = 0; i < rects.length; i++) {
                const rect = rects[i]

                if (rect.width === 0 || rect.height === 0) continue

                const overlay = document.createElement('span')
                overlay.className = 'pdf-highlight-overlay'
                overlay.setAttribute('data-match-index', '0')

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
                  z-index: 10;
                  border-radius: 2px;
                `

                overlayContainer.appendChild(overlay)
                marks.push(overlay)
              }
            } catch (error) {
              console.warn(
                "Error creating overlay highlight:",
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
    [],
  )

  const clearHighlights = useCallback(() => {
    const root = containerRef.current
    if (!root) return

   
    const overlayContainers = root.querySelectorAll<HTMLElement>('.highlight-overlay-layer')
    overlayContainers.forEach((container) => {
      container.remove()
    })

   
    const individualOverlays = root.querySelectorAll<HTMLElement>('.pdf-highlight-overlay')
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
      if (debug) {
        console.log("highlightText called with:", text)
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
          if (pageIndex !== undefined) {
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
        let result: HighlightResponse

        if (
          cachedEntry &&
          Date.now() - cachedEntry.timestamp < CACHE_DURATION
        ) {
          if (debug) {
            console.log("Using cached result for key:", cacheKey)
          }
          result = cachedEntry.response
        } else {
          if (debug) {
            console.log("Cache miss, making API call for key:", cacheKey)
          }

          const response = await api.highlight.$post({
            json: {
              chunkText: text,
              documentContent: containerText,
              options: {
                caseSensitive,
              },
            },
          })

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`)
          }

          result = await response.json()

          // Only cache successful responses and only when safe
          if (result.success && canUseCache) {
            cacheRef.current[cacheKey] = {
              response: result,
              timestamp: Date.now(),
            }

            if (debug) {
              console.log("Cached successful result for key:", cacheKey)
            }
          } else if (result.success && !canUseCache && debug) {
            console.log("Skipping cache write (no documentId)")
          } else {
            if (debug) {
              console.log("Not caching failed response for key:", cacheKey)
            }
          }
        }

        if (debug) {
          console.log("Backend response:", result)
        }

        if (!result.success || !result.matches || result.matches.length === 0) {
          if (debug) {
            console.log("No matches found:", result.message)
          }
          return false
        }

        // Create highlight marks for all matches
        const allMarks: HTMLElement[] = []
        let longestMatchIndex = 0
        let longestMatchLength = 0

        
        result.matches.forEach((match, matchIndex) => {
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
            `Created ${allMarks.length} highlight marks from ${result.matches.length} matches`,
          )
          console.log(
            `Longest match index: ${longestMatchIndex} with length: ${longestMatchLength}`,
          )
        }

        setMatches(allMarks)
        setIndex(longestMatchIndex)

        return allMarks.length > 0
      } catch (error) {
        console.error("Error during backend highlighting:", error)
        return false
      } finally {
        setIsLoading(false)
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

      if (container.scrollHeight > container.clientHeight) {
        const containerRect = container.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()

        const targetTop = targetRect.top - containerRect.top
        const containerHeight = container.clientHeight
        const targetHeight = targetRect.height

        const scrollTop =
          container.scrollTop +
          targetTop -
          containerHeight / 2 +
          targetHeight / 2

        container.scrollTo({
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
      scrollToMatch(index)
    }
  }, [matches, index])

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
