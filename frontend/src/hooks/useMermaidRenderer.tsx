import React, { useState, useEffect, useRef, useCallback } from "react"
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
  Minimize2,
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
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const [lastValidMermaid, setLastValidMermaid] = useState<string>("")
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
      if (!container) return

      // Clear any existing timeout
      if (mermaidRenderTimeoutRef.current) {
        clearTimeout(mermaidRenderTimeoutRef.current)
      }

      // If code is empty, clear the container
      if (!code || code.trim() === "") {
        container.innerHTML = ""
        setLastValidMermaid("")
        return
      }

      // Skip rendering if the code hasn't changed and we already have a valid render in the same container
      // BUT allow re-rendering if the container has changed (e.g., switching to fullscreen)
      if (
        lastValidMermaid === code.trim() &&
        lastRenderedContainer === container &&
        container.innerHTML.includes("<svg")
      ) {
        return
      }

      // Check if syntax looks valid (async now)
      const isValid = await isMermaidSyntaxValid(code)
      if (!isValid) {
        // If we have a previous valid render, keep showing it
        if (lastValidMermaid) {
          return
        } else {
          // Show loading state for incomplete syntax
          container.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: monospace;">
          <div>Mermaid Chart..</div>
          <div style="margin-top: 10px; font-size: 12px;">Streaming mermaid</div>
        </div>`
          return
        }
      }

      // Debounce the actual rendering to avoid too many rapid attempts
      mermaidRenderTimeoutRef.current = setTimeout(async () => {
        try {
          // Additional safety: validate the code before rendering
          if (!code || code.trim().length === 0) {
            container.innerHTML = ""
            setLastValidMermaid("")
            return
          }

          // Sanitize the code to prevent potential issues
          const sanitizedCode = code
            .replace(/javascript:/gi, "") // Remove javascript: protocols
            .replace(/data:/gi, "") // Remove data: protocols
            .replace(/<script[^>]*>.*?<\/script>/gis, "") // Remove script tags
            .trim()

          if (!sanitizedCode) {
            container.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: monospace;">
            <div>📊 Mermaid Diagram</div>
            <div style="margin-top: 10px; font-size: 12px; color: #999;">Invalid diagram content</div>
          </div>`
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

              container.innerHTML = svg
              setLastValidMermaid(sanitizedCode)
              setLastRenderedContainer(container)
            })
          } catch (error: any) {
            // Completely suppress all error details from users

            // Always gracefully handle any mermaid errors by either:
            // 1. Keeping the last valid diagram if we have one
            // 2. Showing a loading/placeholder state if no valid diagram exists
            // 3. Never showing syntax error messages to users

            if (lastValidMermaid) {
              // Keep showing the last valid diagram - don't change anything
              return
            } else {
              // Show a generic processing state instead of error details
              container.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: monospace;">
              <div>📊 Mermaid Diagram</div>
              <div style="margin-top: 10px; font-size: 12px; color: #999;">Processing diagram content...</div>
            </div>`
            }
          }
        } catch (outerError: any) {
          // Final fallback error handling
          container.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: monospace;">
          <div>📊 Mermaid Diagram</div>
          <div style="margin-top: 10px; font-size: 12px; color: #999;">Unable to render diagram</div>
        </div>`
        }
      }, 300)
    },
    [container, lastValidMermaid],
  )

  const refElement = useCallback((node: HTMLElement | null) => {
    if (node !== null) {
      setContainer(node)
    }
  }, [])

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

export const MermaidRenderer: React.FC<MermaidRendererProps> = ({
  code,
  className = "",
  containerHeight = 600,
  onHeightChange,
  showHeightControls = true,
}) => {
  const { debouncedMermaidRender, refElement, demoid, lastValidMermaid } =
    useMermaidRenderer()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [localHeight, setLocalHeight] = useState(containerHeight)

  // Check if this is a mermaid code block
  const isMermaid =
    className && /^language-mermaid/.test(className.toLocaleLowerCase())

  useEffect(() => {
    if (isMermaid) {
      debouncedMermaidRender(code)
    }
  }, [debouncedMermaidRender, code, isMermaid])

  // Re-render mermaid when switching to/from fullscreen
  useEffect(() => {
    if (isMermaid && (code || lastValidMermaid)) {
      // Small delay to ensure the new container is ready
      const timer = setTimeout(() => {
        const codeToRender = code || lastValidMermaid
        debouncedMermaidRender(codeToRender)
      }, 150) // Increased delay to ensure container is fully ready

      return () => clearTimeout(timer)
    }
  }, [isFullscreen, isMermaid, code, lastValidMermaid, debouncedMermaidRender])

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

  const containerStyle = isFullscreen
    ? {
        position: "fixed" as const,
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        backgroundColor: "rgba(248, 250, 252, 0.98)",
        zIndex: 50,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }
    : {
        width: "100%",
        height: `${localHeight}px`,
        minHeight: "200px",
        maxHeight: "1200px",
      }

  // Transform wrapper configuration for different view modes
  const transformConfig = isFullscreen
    ? {
        initialScale: 1,
        minScale: 0.1,
        maxScale: 10,
        limitToBounds: false,
        centerOnInit: true,
        centerZoomedOut: true,
        doubleClick: { disabled: true },
        wheel: { step: 0.1 },
        panning: { velocityDisabled: false },
      }
    : {
        initialScale: 1.5,
        minScale: 0.5,
        maxScale: 7,
        limitToBounds: true,
        centerOnInit: true,
        centerZoomedOut: true,
        doubleClick: { disabled: true },
        wheel: { step: 0.1 },
        panning: { velocityDisabled: true },
      }

  const renderContent = () => (
    <div
      className={`group relative mb-6 overflow-hidden ${isFullscreen ? "w-full h-full" : "w-full"}`}
      style={containerStyle}
    >
      <TransformWrapper
        key={`mermaid-transform-${isFullscreen ? "fullscreen" : "normal"}`}
        initialScale={transformConfig.initialScale}
        minScale={transformConfig.minScale}
        maxScale={transformConfig.maxScale}
        limitToBounds={transformConfig.limitToBounds}
        centerOnInit={transformConfig.centerOnInit}
        centerZoomedOut={transformConfig.centerZoomedOut}
        doubleClick={transformConfig.doubleClick}
        wheel={transformConfig.wheel}
        panning={transformConfig.panning}
      >
        <TransformComponent
          wrapperStyle={{
            width: "100%",
            height: isFullscreen ? "100vh" : `${localHeight}px`,
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
          isFullscreen={isFullscreen}
        />
        <div className="absolute bottom-2 right-2 z-20 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <button
            onClick={handleFullscreen}
            className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 p-1.5 shadow-md z-10 transition-colors rounded-md"
            title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        </div>
      </TransformWrapper>
      {isFullscreen && (
        <button
          onClick={handleFullscreen}
          className="absolute top-4 right-4 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 p-2 rounded-full shadow-lg z-20 transition-colors"
          title="Exit Fullscreen"
        >
          <X size={16} />
        </button>
      )}
    </div>
  )

  // For fullscreen, render at the root level to ensure it's above everything
  if (isFullscreen) {
    return createPortal(renderContent(), document.body)
  }

  return renderContent()
}

// Simple Mermaid Code Component for embedding in MarkdownPreview
export const MermaidCode = ({ inline, children, className, ...props }: any) => {
  const [containerHeight, setContainerHeight] = useState(600)

  const isMermaid =
    className && /^language-mermaid/.test(className.toLocaleLowerCase())

  // Debug logging for inline code detection
  const codeString =
    typeof children === "string" ? children : String(children || "")

  // Extract code content from children
  let codeContent = ""
  if (props.node && props.node.children && props.node.children.length > 0) {
    codeContent = getCodeString(props.node.children)
  } else if (typeof children === "string") {
    codeContent = children
  } else if (
    Array.isArray(children) &&
    children.length > 0 &&
    typeof children[0] === "string"
  ) {
    codeContent = children[0]
  }

  // Handle mermaid diagrams
  if (isMermaid) {
    return (
      <MermaidRenderer
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
    (!className && !codeString.includes("\n") && codeString.trim().length > 0)

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
