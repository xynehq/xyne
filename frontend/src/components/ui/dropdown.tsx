import React, { useState, useRef, useEffect } from "react"
import { ChevronDown, Check } from "lucide-react"
import { cn } from "@/lib/utils"

interface DropdownOption {
  value: string
  label: string
  disabled?: boolean
  icon?: React.ReactNode
}

interface DropdownProps {
  options: DropdownOption[]
  value?: string
  placeholder?: string
  onSelect: (value: string) => void
  disabled?: boolean
  className?: string
  variant?: "default" | "outline" | "ghost"
  size?: "sm" | "md" | "lg"
  showCheck?: boolean
  searchable?: boolean
  loading?: boolean
  error?: boolean
  maxHeight?: string
  position?: "bottom" | "top" | "auto"
  width?: string
  rounded?: string
  border?: string
  fontSize?: string
}

const Dropdown: React.FC<DropdownProps> = ({
  options,
  value,
  placeholder = "Select an option",
  onSelect,
  disabled = false,
  className,
  variant = "default",
  size = "md",
  showCheck = true,
  searchable = false,
  loading = false,
  error = false,
  maxHeight = "200px",
  position = "auto",
  width,
  rounded,
  border,
  fontSize,
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [dropdownPosition, setDropdownPosition] = useState<"bottom" | "top">("bottom")
  const dropdownRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Filter options based on search term
  const filteredOptions = searchable
    ? options.filter(option =>
        option.label.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : options

  // Find selected option
  const selectedOption = options.find(option => option.value === value)

  // Handle position calculation
  useEffect(() => {
    if (isOpen && position === "auto" && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      const spaceBelow = viewportHeight - rect.bottom
      const spaceAbove = rect.top
      
      // If there's more space above than below and not enough space below for dropdown
      if (spaceAbove > spaceBelow && spaceBelow < 200) {
        setDropdownPosition("top")
      } else {
        setDropdownPosition("bottom")
      }
    } else if (position !== "auto") {
      setDropdownPosition(position)
    }
  }, [isOpen, position])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setSearchTerm("")
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside)
      // Focus search input if searchable
      if (searchable && searchInputRef.current) {
        setTimeout(() => searchInputRef.current?.focus(), 100)
      }
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [isOpen, searchable])

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return

      if (event.key === "Escape") {
        setIsOpen(false)
        setSearchTerm("")
        triggerRef.current?.focus()
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [isOpen])

  const handleSelect = (optionValue: string) => {
    if (disabled) return
    
    onSelect(optionValue)
    setIsOpen(false)
    setSearchTerm("")
    triggerRef.current?.focus()
  }

  const handleToggle = () => {
    if (disabled) return
    setIsOpen(!isOpen)
    if (isOpen) {
      setSearchTerm("")
    }
  }

  // Variant styles - Updated to use lighter gray colors
  const getVariantStyles = () => {
    if (border) {
      // Use external border prop
      switch (variant) {
        case "outline":
          return `bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-500 text-gray-900 dark:text-gray-100`
        case "ghost":
          return "border-none bg-transparent hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-900 dark:text-gray-100"
        default:
          return `bg-gray-50 dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-500 text-gray-900 dark:text-gray-100`
      }
    }
    
    // Default lighter border colors
    switch (variant) {
      case "outline":
        return "border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-500 text-gray-900 dark:text-gray-100"
      case "ghost":
        return "border-none bg-transparent hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-900 dark:text-gray-100"
      default:
        return "border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-500 text-gray-900 dark:text-gray-100"
    }
  }

  // Size styles - Updated to use external fontSize when provided
  const getSizeStyles = () => {
    const textSize = fontSize || "text-sm"
    switch (size) {
      case "sm":
        return `h-8 px-2 ${textSize}`
      case "lg":
        return `h-12 px-4 ${textSize}`
      default:
        return `h-10 px-3 ${textSize}`
    }
  }

  const triggerClassName = cn(
    "relative w-full flex items-center justify-between transition-colors focus:outline-none",
    rounded ? "" : "rounded-lg",
    getSizeStyles(),
    getVariantStyles(),
    {
      "cursor-not-allowed opacity-50": disabled,
      "border-red-500 dark:border-red-400": error,
    },
    className
  )

  const dropdownClassName = cn(
    "absolute z-50 mt-1 bg-white dark:bg-gray-900 shadow-lg overflow-hidden w-full",
    border ? "" : "border border-gray-200 dark:border-gray-600",
    rounded ? "" : "rounded-lg",
    {
      "bottom-full mb-1 mt-0": dropdownPosition === "top",
    }
  )

  return (
    <div 
      className="relative" 
      ref={dropdownRef} 
      style={{
        ...(width ? { width } : {}),
        ...(rounded ? { borderRadius: rounded } : {})
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className={triggerClassName}
        style={{
          ...(rounded ? { borderRadius: rounded } : {}),
          ...(border ? { border: isOpen ? "1px solid #000000" : border } : {}),
          ...(isOpen && !border ? { border: "1px solid #000000" } : {})
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2 flex-1 text-left">
          {selectedOption?.icon && (
            <span className="flex-shrink-0">{selectedOption.icon}</span>
          )}
          <span className={cn(
            "truncate",
            !selectedOption && "text-gray-500 dark:text-gray-400",
            selectedOption && "text-gray-900 dark:text-gray-100"
          )}>
            {selectedOption?.label || placeholder}
          </span>
        </div>
        
        <div className="flex items-center gap-2">
          {loading && (
            <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 dark:border-t-gray-400 rounded-full animate-spin" />
          )}
          <ChevronDown 
            className={cn(
              "w-4 h-4 text-gray-400 transition-transform",
              isOpen && "rotate-180"
            )} 
          />
        </div>
      </button>

      {isOpen && (
        <div 
          className={dropdownClassName}
          style={{
            ...(rounded ? { borderRadius: rounded } : {}),
            ...(border ? { border: border } : {})
          }}
        >
          {searchable && (
            <div className="p-2 border-b border-gray-200 dark:border-gray-600">
              <input
                ref={searchInputRef}
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search options..."
                className={cn(
                  "w-full px-2 py-1 border rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500",
                  border ? "" : "border-gray-200 dark:border-gray-600",
                  fontSize || "text-sm"
                )}
                style={border ? { border: border } : {}}
              />
            </div>
          )}
          
          <div 
            className="overflow-y-auto"
            style={{ maxHeight }}
          >
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                {searchable && searchTerm ? "No options found" : "No options available"}
              </div>
            ) : (
              filteredOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelect(option.value)}
                  disabled={option.disabled}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-none text-gray-900 dark:text-gray-100",
                    fontSize || "text-sm",
                    {
                      "bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-medium": option.value === value,
                      "cursor-not-allowed opacity-50": option.disabled,
                    }
                  )}
                >
                  {option.icon && (
                    <span className="flex-shrink-0">{option.icon}</span>
                  )}
                  <span className="flex-1 truncate">{option.label}</span>
                  {showCheck && option.value === value && (
                    <Check className="w-4 h-4 text-gray-700 dark:text-gray-300" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default Dropdown
export type { DropdownOption, DropdownProps }