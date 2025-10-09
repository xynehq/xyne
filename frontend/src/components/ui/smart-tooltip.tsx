import React, { useCallback, useEffect, useRef, useState } from "react"

interface SmartTooltipProps {
  children: React.ReactElement
  content: string
  delayDuration?: number
  className?: string
}

// Smart tooltip wrapper component that adjusts position based on available space
export const SmartTooltip: React.FC<SmartTooltipProps> = ({
  children,
  content,
  delayDuration = 500,
  className = "",
}) => {
  const [isVisible, setIsVisible] = useState(false)
  const [position, setPosition] = useState<"top" | "bottom">("bottom")
  const triggerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  const checkPosition = useCallback(() => {
    if (!triggerRef.current) return

    const rect = triggerRef.current.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    const spaceBelow = viewportHeight - rect.bottom
    const spaceAbove = rect.top

    // If there's more space above and we're in the bottom half of the screen, show tooltip above
    if (spaceAbove > spaceBelow && rect.top > viewportHeight / 2) {
      setPosition("top")
    } else {
      setPosition("bottom")
    }
  }, [])

  const handleMouseEnter = useCallback(() => {
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    checkPosition()
    timeoutRef.current = setTimeout(() => {
      setIsVisible(true)
    }, delayDuration)
  }, [checkPosition, delayDuration])

  const handleMouseLeave = useCallback(() => {
    // Clear any pending timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    setIsVisible(false)
  }, [])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  return (
    <div
      ref={triggerRef}
      className={`relative inline-block ${className}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {isVisible && (
        <div
          ref={tooltipRef}
          className={`absolute z-50 px-3 py-2 text-xs text-white bg-gray-900 dark:bg-gray-800 rounded-lg shadow-lg whitespace-nowrap pointer-events-none ${
            position === "top"
              ? "bottom-full mb-2 left-1/2 -translate-x-1/2"
              : "top-full mt-2 left-1/2 -translate-x-1/2"
          }`}
        >
          {content}
          {/* Arrow */}
          <div
            className={`absolute left-1/2 -translate-x-1/2 w-0 h-0 ${
              position === "top"
                ? "top-full border-l-[6px] border-r-[6px] border-t-[6px] border-l-transparent border-r-transparent border-t-gray-900 dark:border-t-gray-800"
                : "bottom-full border-l-[6px] border-r-[6px] border-b-[6px] border-l-transparent border-r-transparent border-b-gray-900 dark:border-b-gray-800"
            }`}
          />
        </div>
      )}
    </div>
  )
}
