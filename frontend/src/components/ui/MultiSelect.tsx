import React, { useState, useRef, useEffect } from 'react'
import { Check, X } from 'lucide-react'

interface Option {
  value: string
  label: string
}

interface MultiSelectProps {
  options: Option[]
  value: string[]
  onChange: (selected: string[]) => void
  placeholder?: string
  disabled?: boolean
}

export const MultiSelect: React.FC<MultiSelectProps> = ({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false)
        setSearchQuery('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const filteredOptions = options.filter(option =>
    option.label.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const toggleOption = (optionValue: string) => {
    if (disabled) return

    if (value.includes(optionValue)) {
      onChange(value.filter(v => v !== optionValue))
    } else {
      onChange([...value, optionValue])
    }
  }

  const removeOption = (optionValue: string, e: React.MouseEvent) => {
    if (disabled) return
    e.stopPropagation()
    onChange(value.filter(v => v !== optionValue))
  }

  const handleSelectAll = () => {
    if (disabled) return

    // Check if all filtered options are selected
    const allFilteredSelected = filteredOptions.every(option =>
      value.includes(option.value)
    )

    if (allFilteredSelected) {
      // Deselect all filtered options
      const filteredValues = filteredOptions.map(o => o.value)
      onChange(value.filter(v => !filteredValues.includes(v)))
    } else {
      // Select all filtered options (merge with existing selections)
      const newValues = [...value]
      filteredOptions.forEach(option => {
        if (!newValues.includes(option.value)) {
          newValues.push(option.value)
        }
      })
      onChange(newValues)
    }
  }

  const allFilteredSelected = filteredOptions.length > 0 &&
    filteredOptions.every(option => value.includes(option.value))

  const selectedLabels = value.map(v =>
    options.find(o => o.value === v)?.label || v
  )

  return (
    <div ref={ref} className="relative">
      {/* Trigger Button */}
      <div
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className={`min-h-[42px] px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 transition-colors ${
          disabled
            ? 'cursor-not-allowed opacity-50 bg-gray-50 dark:bg-gray-900'
            : 'cursor-pointer hover:border-gray-400 dark:hover:border-gray-500'
        }`}
      >
        {value.length === 0 ? (
          <span className="text-gray-400 dark:text-gray-500 text-sm">
            {placeholder}
          </span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {selectedLabels.map((label, index) => (
              <span
                key={value[index]}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-xs"
              >
                {label}
                {!disabled && (
                  <X
                    className="w-3 h-3 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                    onClick={(e) => removeOption(value[index], e)}
                  />
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Dropdown */}
      {isOpen && !disabled && (
        <div className="absolute z-50 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg max-h-60 overflow-hidden">
          {/* Search */}
          <div className="p-2 border-b border-gray-200 dark:border-gray-700">
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-orange-500"
              onClick={(e) => e.stopPropagation()}
            />
          </div>

          {/* Options List */}
          <div className="max-h-48 overflow-y-auto">
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                No options found
              </div>
            ) : (
              <>
                {/* Select All Option */}
                <div
                  onClick={handleSelectAll}
                  className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-750"
                >
                  <div
                    className={`w-4 h-4 rounded border flex items-center justify-center ${
                      allFilteredSelected
                        ? 'bg-black dark:bg-white border-black dark:border-white'
                        : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600'
                    }`}
                  >
                    {allFilteredSelected && (
                      <Check className="w-3 h-3 text-white dark:text-black" strokeWidth={3} />
                    )}
                  </div>
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    Select All {searchQuery && `(${filteredOptions.length})`}
                  </span>
                </div>

                {/* Individual Options */}
                {filteredOptions.map((option) => (
                  <div
                    key={option.value}
                    onClick={() => toggleOption(option.value)}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                  >
                    <div
                      className={`w-4 h-4 rounded border flex items-center justify-center ${
                        value.includes(option.value)
                          ? 'bg-black dark:bg-white border-black dark:border-white'
                          : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600'
                      }`}
                    >
                      {value.includes(option.value) && (
                        <Check className="w-3 h-3 text-white dark:text-black" strokeWidth={3} />
                      )}
                    </div>
                    <span className="text-sm text-gray-900 dark:text-gray-100">
                      {option.label}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
