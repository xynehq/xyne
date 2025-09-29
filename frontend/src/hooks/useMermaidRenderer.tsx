import React, { useState, useEffect, useRef, useCallback, useMemo } from "react"
import mermaid from "mermaid"
import { getCodeString } from "rehype-rewrite"
import { createPortal } from "react-dom"
import {
  TransformWrapper,
  TransformComponent,
  useControls,
} from "react-zoom-pan-pinch"
import {
  ZoomIn,
  ZoomOut,
  RefreshCw,
  Plus,
  Minus,
  Maximize2,
  X,
} from "lucide-react"

// Initialize mermaid with secure configuration to prevent syntax errors
mermaid.initialize({
  startOnLoad: false,
  theme: "default",
  securityLevel: "strict",
  fontFamily: "monospace",
  logLevel: "fatal", // Minimize mermaid console logs
  suppressErrorRendering: true, // Suppress error rendering if available
  flowchart: {
    useMaxWidth: true,
  },
  sequence: {
    useMaxWidth: true,
  },
})

// Utility function to suppress console logs for a specific operation
function suppressLogs<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const originals = ["error", "warn", "log", "info", "debug"].map((k) => [
    k,
    (console as any)[k],
  ])
  originals.forEach(([k]) => ((console as any)[k] = () => {}))
  try {
    const result = fn()
    if (result instanceof Promise) {
      return result.finally(() => {
        originals.forEach(([k, v]) => ((console as any)[k] = v))
      })
    } else {
      originals.forEach(([k, v]) => ((console as any)[k] = v))
      return result
    }
  } catch (error) {
    originals.forEach(([k, v]) => ((console as any)[k] = v))
    throw error
  }
}

// Generate random ID for mermaid elements
const randomid = () => parseInt(String(Math.random() * 1e15), 10).toString(36)

// Custom hook for mermaid rendering logic
export const useMermaidRenderer = () => {
  const demoid = useRef(`dome${randomid()}`)
  const containerRef = useRef<HTMLElement | null>(null)
  const [lastValidMermaid, setLastValidMermaid] = useState<string>("")
  const [lastValidSvg, setLastValidSvg] = useState<string>("")
  const [lastRenderedContainer, setLastRenderedContainer] =
    useState<HTMLElement | null>(null)
  const mermaidRenderTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Function to validate if mermaid syntax looks complete
  const isMermaidSyntaxValid = async (code: string): Promise<boolean> => {
    if (!code || code.trim() === "") return false

    const trimmedCode = code.trim()

    const mermaidPatterns = [
      /^graph\s+(TD|TB|BT|RL|LR)\s*\n/i,
      /^flowchart\s+(TD|TB|BT|RL|LR)\s*\n/i,
      /^sequenceDiagram\s*\n/i,
      /^classDiagram\s*\n/i,
      /^stateDiagram\s*\n/i,
      /^stateDiagram-v2\s*\n/i,
      /^erDiagram\s*\n/i,
      /^journey\s*\n/i,
      /^gantt\s*\n/i,
      /^pie\s*\n/i,
      /^gitgraph\s*\n/i,
      /^mindmap\s*\n/i,
      /^timeline\s*\n/i,
      // Additional or experimental diagram types
      /^zenuml\s*\n/i,
      /^quadrantChart\s*\n/i,
      /^requirementDiagram\s*\n/i,
      /^userJourney\s*\n/i,
      // Optional aliasing/loose matching for future compatibility
      /^flowchart\s*\n/i,
      /^graph\s*\n/i,
      /^C4Context\s*\n/i,
    ]

    // Check if it starts with a valid mermaid diagram type
    const hasValidStart = mermaidPatterns.some((pattern) =>
      pattern.test(trimmedCode),
    )
    if (!hasValidStart) return false

    // Try to parse with mermaid to validate syntax
    try {
      // Use scoped console suppression to avoid global hijacking
      return await suppressLogs(async () => {
        await mermaid.parse(trimmedCode)
        return true
      })
    } catch (error) {
      // Invalid syntax
      return false
    }
  }

  // Debounced function to validate and render mermaid
  const debouncedMermaidRender = useCallback(
    async (code: string) => {
      const currentContainer = containerRef.current
      if (!currentContainer) return

      // Clear any existing timeout
      if (mermaidRenderTimeoutRef.current) {
        clearTimeout(mermaidRenderTimeoutRef.current)
      }

      const trimmedCode = code.trim()

      // Check if container is unexpectedly empty when we should have content
      if (
        lastValidSvg &&
        lastValidMermaid &&
        trimmedCode &&
        currentContainer.innerHTML.trim() === "" &&
        trimmedCode.length >= lastValidMermaid.length * 0.8 // Allow for small variations
      ) {
        // Container was corrupted, restore last valid SVG
        currentContainer.innerHTML = lastValidSvg
        console.log("Container was empty, restored last valid diagram")
      }

      // If code is empty, only clear if we don't have a valid diagram
      if (!trimmedCode) {
        if (!lastValidMermaid) {
          currentContainer.innerHTML = ""
          setLastValidSvg("")
        }
        return
      }

      // Skip rendering if the code hasn't changed and we already have a valid render in the same container
      // BUT allow re-rendering if the container has changed (e.g., switching to fullscreen)
      if (
        lastValidMermaid === trimmedCode &&
        lastRenderedContainer === currentContainer &&
        currentContainer.innerHTML.includes("<svg")
      ) {
        return
      }

      // Check if syntax looks valid (async now)
      const isValid = await isMermaidSyntaxValid(trimmedCode)
      if (!isValid) {
        // If we have a previous valid render AND the current code is shorter than the last valid one,
        // it's likely still being streamed, so keep showing the previous version
        if (lastValidMermaid && trimmedCode.length < lastValidMermaid.length) {
          return
        }

        // If we have a previous valid render but current code is longer and invalid,
        // it might be a syntax error, so keep showing the previous version
        if (lastValidMermaid && trimmedCode.length >= lastValidMermaid.length) {
          return
        }

        // Only show loading state if we don't have any previous valid diagram
        if (!lastValidMermaid) {
          currentContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: monospace;">
          <div>Mermaid Chart..</div>
          <div style="margin-top: 10px; font-size: 12px;">Streaming mermaid</div>
        </div>`
        }
        return
      }

      // Debounce the actual rendering to avoid too many rapid attempts
      mermaidRenderTimeoutRef.current = setTimeout(async () => {
        try {
          // Additional safety: validate the code before rendering
          if (!trimmedCode) {
            if (!lastValidMermaid) {
              currentContainer.innerHTML = ""
              setLastValidMermaid("")
              setLastValidSvg("")
            }
            return
          }

          // Sanitize the code to prevent potential issues
          const sanitizedCode = trimmedCode
            .replace(/javascript:/gi, "") // Remove javascript: protocols
            .replace(/data:/gi, "") // Remove data: protocols
            .replace(/<script[^>]*>.*?<\/script>/gis, "") // Remove script tags

          if (!sanitizedCode) {
            // If we have a last valid SVG, restore it instead of showing error
            if (lastValidSvg) {
              currentContainer.innerHTML = lastValidSvg
              console.log("Invalid sanitized code, restored last valid diagram")
            } else {
              currentContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: monospace;">
              <div>📊 Mermaid Diagram</div>
              <div style="margin-top: 10px; font-size: 12px; color: #999;">Invalid diagram content</div>
            </div>`
            }
            return
          }

          // Use scoped console suppression during rendering
          try {
            await suppressLogs(async () => {
              // Render with additional error boundary
              const { svg } = await mermaid.render(
                demoid.current,
                sanitizedCode,
              )

              // Validate that we got valid SVG
              if (!svg || !svg.includes("<svg")) {
                throw new Error("Invalid SVG generated")
              }

              currentContainer.innerHTML = svg
              setLastValidMermaid(sanitizedCode)
              setLastValidSvg(svg)
              setLastRenderedContainer(currentContainer)
            })
          } catch (error: any) {
            // Completely suppress all error details from users

            // Always gracefully handle any mermaid errors by either:
            // 1. Restoring the last valid diagram if we have one
            // 2. Showing a loading/placeholder state if no valid diagram exists
            // 3. Never showing syntax error messages to users

            if (lastValidMermaid && lastValidSvg) {
              // Restore the last valid diagram by re-rendering it
              currentContainer.innerHTML = lastValidSvg
              console.log("Mermaid render failed, restored last valid diagram")
              return
            } else {
              // Show a generic processing state instead of error details
              currentContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: monospace;">
              <div>📊 Mermaid Diagram</div>
              <div style="margin-top: 10px; font-size: 12px; color: #999;">Processing diagram content...</div>
            </div>`
            }
          }
        } catch (outerError: any) {
          // Final fallback error handling
          if (lastValidMermaid && lastValidSvg) {
            // Restore the last valid diagram as final fallback
            currentContainer.innerHTML = lastValidSvg
            console.log(
              "Mermaid render failed completely, restored last valid diagram",
            )
          } else {
            currentContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: monospace;">
            <div>📊 Mermaid Diagram</div>
            <div style="margin-top: 10px; font-size: 12px; color: #999;">Unable to render diagram</div>
          </div>`
          }
        }
      }, 150)
    },
    [lastValidMermaid, lastValidSvg, lastRenderedContainer],
  )

  const refElement = useCallback(
    (node: HTMLElement | null) => {
      if (node !== null) {
        containerRef.current = node

        // Immediately restore last valid SVG if we have one (important for fullscreen transitions)
        if (lastValidSvg && node.innerHTML.trim() === "") {
          node.innerHTML = lastValidSvg
          console.log(
            "Immediately restored SVG to new container (likely fullscreen transition)",
          )
        }
      }
    },
    [lastValidSvg],
  )

  // Cleanup function
  useEffect(() => {
    return () => {
      if (mermaidRenderTimeoutRef.current) {
        clearTimeout(mermaidRenderTimeoutRef.current)
      }
    }
  }, [])

  return {
    debouncedMermaidRender,
    refElement,
    demoid: demoid.current,
    lastValidMermaid, // Expose this so the component can use it for re-rendering
    lastValidSvg, // Expose the last valid SVG for debugging or manual restoration
  }
}

// Mermaid Controls Component
interface MermaidControlsProps {
  showHeightControls?: boolean
  onHeightChange?: (delta: number) => void
  isFullscreen?: boolean
}

const MermaidControls: React.FC<MermaidControlsProps> = ({
  showHeightControls = true,
  onHeightChange,
  isFullscreen = false,
}) => {
  const { zoomIn, zoomOut, resetTransform, centerView } = useControls()
  const buttonBaseClass =
    "bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 p-1.5 shadow-md z-10 transition-colors"
  const iconSize = 12

  const handleResetAndCenter = () => {
    resetTransform()
    // Small delay to ensure reset is complete before centering
    setTimeout(() => {
      centerView()
    }, 10)
  }

  const adjustHeight = (delta: number) => {
    onHeightChange?.(delta)
  }

  return (
    <div className="absolute top-2 left-2 flex space-x-1 z-20 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
      <button
        onClick={() => zoomIn()}
        className={`${buttonBaseClass} rounded-l-md`}
        title="Zoom In"
      >
        <ZoomIn size={iconSize} />
      </button>
      <button
        onClick={() => zoomOut()}
        className={`${buttonBaseClass}`}
        title="Zoom Out"
      >
        <ZoomOut size={iconSize} />
      </button>
      <button
        onClick={handleResetAndCenter}
        className={`${buttonBaseClass} ${!showHeightControls || isFullscreen ? "rounded-r-md" : ""}`}
        title="Reset View"
      >
        <RefreshCw size={iconSize} />
      </button>
      {!isFullscreen && showHeightControls && (
        <>
          <button
            onClick={() => adjustHeight(-100)}
            className={`${buttonBaseClass}`}
            title="Decrease Height"
          >
            <Minus size={iconSize} />
          </button>
          <button
            onClick={() => adjustHeight(100)}
            className={`${buttonBaseClass} rounded-r-md`}
            title="Increase Height"
          >
            <Plus size={iconSize} />
          </button>
        </>
      )}
    </div>
  )
}

// Main Mermaid Renderer Component
interface MermaidRendererProps {
  code: string
  className?: string
  containerHeight?: number
  onHeightChange?: (height: number) => void
  showHeightControls?: boolean
}

const MermaidRendererComponent: React.FC<MermaidRendererProps> = ({
  code,
  className = "",
  containerHeight = 600,
  onHeightChange,
  showHeightControls = true,
}) => {
  const {
    debouncedMermaidRender,
    refElement,
    demoid,
    lastValidMermaid,
    lastValidSvg,
  } = useMermaidRenderer()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [localHeight, setLocalHeight] = useState(containerHeight)

  // Create a stable key based on code content to prevent unnecessary remounts
  const stableKey = useMemo(() => {
    const validCode = code?.trim() || lastValidMermaid
    return validCode
      ? `mermaid-${validCode.substring(0, 50).replace(/\s+/g, "-")}`
      : "mermaid-empty"
  }, [code, lastValidMermaid])

  // Check if this is a mermaid code block
  const isMermaid =
    className && /^language-mermaid/.test(className.toLocaleLowerCase())

  // Re-render mermaid when code changes
  useEffect(() => {
    if (isMermaid && code) {
      debouncedMermaidRender(code)
    }
  }, [debouncedMermaidRender, code, isMermaid])

  // Get reference to the main mermaid container for cloning
  const mainContainerRef = useRef<HTMLDivElement>(null)

  const handleFullscreen = () => {
    setIsFullscreen(!isFullscreen)
  }

  // Handle escape key and body scroll lock
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isFullscreen) {
        setIsFullscreen(false)
      }
    }

    if (isFullscreen) {
      document.addEventListener("keydown", handleEscape)
      document.body.style.overflow = "hidden"
    } else {
      document.body.style.overflow = "unset"
    }

    return () => {
      document.removeEventListener("keydown", handleEscape)
      document.body.style.overflow = "unset"
    }
  }, [isFullscreen])

  const adjustHeight = (delta: number) => {
    const newHeight = Math.max(200, Math.min(1200, localHeight + delta))
    setLocalHeight(newHeight)
    onHeightChange?.(newHeight)
  }

  if (!isMermaid) {
    return null
  }

  // Simple fullscreen modal that clones the mermaid content
  const FullscreenModal = () => {
    if (!isFullscreen) return null

    const handleBackdropClick = (e: React.MouseEvent) => {
      // Only close if clicking directly on the backdrop, not on child elements
      if (e.target === e.currentTarget) {
        setIsFullscreen(false)
      }
    }

    return createPortal(
      <div
        className="fixed inset-0 bg-white dark:bg-gray-100 z-50"
        onClick={handleBackdropClick}
      >
        {/* Close button */}
        <button
          onClick={() => setIsFullscreen(false)}
          className="absolute top-6 right-6 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 p-3 rounded-full shadow-lg z-20 transition-colors"
          title="Exit Fullscreen"
        >
          <X size={16} />
        </button>

        {/* Fullscreen mermaid content */}
        <div
          className="w-full h-full flex items-center justify-center p-8"
          onClick={(e) => e.stopPropagation()}
        >
          <TransformWrapper
            initialScale={1}
            minScale={0.1}
            maxScale={10}
            centerOnInit={true}
            wheel={{ step: 0.1 }}
            limitToBounds={false}
          >
            {({ zoomIn, zoomOut, resetTransform }) => (
              <>
                <TransformComponent
                  wrapperStyle={{
                    width: "100%",
                    height: "100%",
                    cursor: "grab",
                  }}
                  contentStyle={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <div
                    dangerouslySetInnerHTML={{
                      __html:
                        lastValidSvg ||
                        '<div style="color: #666; font-size: 18px;">Loading diagram...</div>',
                    }}
                  />
                </TransformComponent>

                {/* Zoom controls for fullscreen */}
                <div className="absolute top-6 left-6 flex gap-2 z-20">
                  <button
                    onClick={() => zoomIn()}
                    className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 p-2 rounded-lg shadow-lg transition-colors"
                    title="Zoom In"
                  >
                    <ZoomIn size={16} />
                  </button>
                  <button
                    onClick={() => zoomOut()}
                    className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 p-2 rounded-lg shadow-lg transition-colors"
                    title="Zoom Out"
                  >
                    <ZoomOut size={16} />
                  </button>
                  <button
                    onClick={() => resetTransform()}
                    className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 p-2 rounded-lg shadow-lg transition-colors"
                    title="Reset Zoom"
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
              </>
            )}
          </TransformWrapper>
        </div>
      </div>,
      document.body,
    )
  }

  return (
    <>
      {/* Main mermaid container - always rendered normally */}
      <div
        ref={mainContainerRef}
        className="group relative mb-6 overflow-hidden w-full"
        style={{
          height: `${localHeight}px`,
          minHeight: "200px",
          maxHeight: "1200px",
        }}
      >
        <TransformWrapper
          key={`${stableKey}-transform`}
          initialScale={1.5}
          minScale={0.5}
          maxScale={7}
          limitToBounds={true}
          centerOnInit={true}
          centerZoomedOut={true}
          doubleClick={{ disabled: true }}
          wheel={{ step: 0.1 }}
          panning={{ velocityDisabled: true }}
        >
          <TransformComponent
            wrapperStyle={{
              width: "100%",
              height: `${localHeight}px`,
              cursor: "grab",
              backgroundColor: "transparent",
            }}
            contentStyle={{
              width: "100%",
              height: "100%",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <div style={{ display: "inline-block" }}>
              <code id={demoid} style={{ display: "none" }} />
              <code
                ref={refElement}
                data-name="mermaid"
                className={`mermaid ${className}`}
                style={{
                  display: "inline-block",
                  backgroundColor: "transparent",
                }}
              />
            </div>
          </TransformComponent>
          <MermaidControls
            showHeightControls={showHeightControls}
            onHeightChange={adjustHeight}
            isFullscreen={false}
          />
          {/* Fullscreen button */}
          <div className="absolute bottom-2 right-2 z-20 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <button
              onClick={handleFullscreen}
              className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 p-1.5 shadow-md z-10 transition-colors rounded-md"
              title="Fullscreen"
            >
              <Maximize2 size={12} />
            </button>
          </div>
        </TransformWrapper>
      </div>

      {/* Fullscreen modal */}
      <FullscreenModal />
    </>
  )
}

// Memoize MermaidRenderer to prevent unnecessary re-renders
const MemoizedMermaidRenderer = React.memo(
  MermaidRendererComponent,
  (prevProps, nextProps) => {
    return (
      prevProps.code === nextProps.code &&
      prevProps.className === nextProps.className &&
      prevProps.containerHeight === nextProps.containerHeight &&
      prevProps.showHeightControls === nextProps.showHeightControls
    )
  },
)

// Export the memoized version
export { MemoizedMermaidRenderer as MermaidRenderer }

// Simple Mermaid Code Component for embedding in MarkdownPreview
const MermaidCodeComponent = ({
  inline,
  children,
  className,
  ...props
}: any) => {
  const [containerHeight, setContainerHeight] = useState(600)

  const isMermaid = useMemo(
    () => className && /^language-mermaid/.test(className.toLocaleLowerCase()),
    [className],
  )

  // Debug logging for inline code detection
  const codeString = useMemo(
    () => (typeof children === "string" ? children : String(children || "")),
    [children],
  )

  // Extract code content from children
  const codeContent = useMemo(() => {
    if (props.node && props.node.children && props.node.children.length > 0) {
      return getCodeString(props.node.children)
    } else if (typeof children === "string") {
      return children
    } else if (
      Array.isArray(children) &&
      children.length > 0 &&
      typeof children[0] === "string"
    ) {
      return children[0]
    }
    return ""
  }, [props.node, children])

  // Handle mermaid diagrams
  if (isMermaid) {
    return (
      <MemoizedMermaidRenderer
        code={codeContent}
        className={className}
        containerHeight={containerHeight}
        onHeightChange={setContainerHeight}
        showHeightControls={true}
      />
    )
  }

  // Enhanced inline detection - fallback if inline prop is not set correctly
  const isActuallyInline =
    inline ||
    (!className && !codeContent.includes("\n") && codeString.trim().length > 0)

  // For regular code blocks, render as plain text without boxing
  if (!isActuallyInline) {
    return (
      <pre
        className="text-sm block w-full my-2 font-mono"
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "break-word",
          wordBreak: "break-word",
          maxWidth: "100%",
          color: "inherit",
          background: "none",
          border: "none",
          padding: 0,
          margin: 0,
        }}
      >
        <code style={{ background: "none", color: "inherit" }}>{children}</code>
      </pre>
    )
  }

  return (
    <code
      className={`${className || ""} font-mono bg-gray-100 dark:bg-gray-800 rounded-md px-2 py-1 text-xs`}
      style={{
        overflowWrap: "break-word",
        wordBreak: "break-word",
        maxWidth: "100%",
        color: "inherit",
        display: "inline",
        fontSize: "0.75rem",
        verticalAlign: "baseline",
      }}
    >
      {children}
    </code>
  )
}

// Export the memoized component
export const MermaidCode = React.memo(
  MermaidCodeComponent,
  (prevProps: any, nextProps: any) => {
    // Only re-render if essential props change
    return (
      prevProps.children === nextProps.children &&
      prevProps.className === nextProps.className &&
      prevProps.inline === nextProps.inline
    )
  },
)

// Create a wrapper component that satisfies MarkdownPreview component requirements
export const MermaidCodeWrapper = (props: any) => <MermaidCode {...props} />
