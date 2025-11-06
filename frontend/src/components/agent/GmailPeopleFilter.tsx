import React, { useState, useEffect } from 'react'
import { Plus, X as LucideX } from 'lucide-react'

interface GmailPeopleFields {
  from: string[]
  to: string[]
  cc: string[]
  bcc: string[]
}

interface GmailPeopleFilterProps {
  filterValue?: string
  onFilterChange: (value: string) => void
}

const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
export const isValidEmail = (email: string): boolean => {
  return emailRegex.test(email.trim())
}

export const GmailPeopleFilter: React.FC<GmailPeopleFilterProps> = ({
  filterValue,
  onFilterChange,
}) => {
  const [peopleFields, setPeopleFields] = useState<GmailPeopleFields>({
    from: [],
    to: [],
    cc: [],
    bcc: [],
  })

  const [peopleInputs, setPeopleInputs] = useState<{
    from: string
    to: string
    cc: string
    bcc: string
  }>({
    from: '',
    to: '',
    cc: '',
    bcc: '',
  })

  const [showError, setShowError] = useState<{
    from: boolean
    to: boolean
    cc: boolean
    bcc: boolean
  }>({
    from: false,
    to: false,
    cc: false,
    bcc: false,
  })

  // Parse existing filter values on mount or when filterValue changes
  useEffect(() => {
    if (!filterValue) return

    const filters = filterValue.split(', ').filter(f => f.trim())
    const newFields: GmailPeopleFields = {
      from: [],
      to: [],
      cc: [],
      bcc: [],
    }

    filters.forEach(filter => {
      if (filter.startsWith('from:')) {
        newFields.from.push(filter.substring(5))
      } else if (filter.startsWith('to:')) {
        newFields.to.push(filter.substring(3))
      } else if (filter.startsWith('cc:')) {
        newFields.cc.push(filter.substring(3))
      } else if (filter.startsWith('bcc:')) {
        newFields.bcc.push(filter.substring(4))
      }
    })

    setPeopleFields(newFields)
  }, [filterValue])

  const buildFilterString = (fields: GmailPeopleFields) => {
    const filterParts: string[] = []
    if (fields.from.length > 0) filterParts.push(...fields.from.map(e => `from:${e}`))
    if (fields.to.length > 0) filterParts.push(...fields.to.map(e => `to:${e}`))
    if (fields.cc.length > 0) filterParts.push(...fields.cc.map(e => `cc:${e}`))
    if (fields.bcc.length > 0) filterParts.push(...fields.bcc.map(e => `bcc:${e}`))

    // Preserve existing timeline filters from the current filterValue
    const currentFilters = filterValue?.split(', ').filter(f => f.trim()) || []
    const existingTimelineFilters = currentFilters.filter(f => f.startsWith('~'))
    const combinedFilters = [...filterParts, ...existingTimelineFilters]

    return combinedFilters.join(', ')
  }

  const addEmail = (field: keyof GmailPeopleFields) => {
    const email = peopleInputs[field].trim()
    if (!email) return

    // Validate email for cc and bcc fields
    if (!isValidEmail(email)) {
      setShowError(prev => ({ ...prev, [field]: true }))
      return
    }

    // Clear error and add email
    setShowError(prev => ({ ...prev, [field]: false }))

    const newFields = {
      ...peopleFields,
      [field]: [...peopleFields[field], email],
    }
    setPeopleFields(newFields)
    setPeopleInputs(prev => ({
      ...prev,
      [field]: '',
    }))

    onFilterChange(buildFilterString(newFields))
  }

  const removeEmail = (field: keyof GmailPeopleFields, idx: number) => {
    const newEmails = peopleFields[field].filter((_, i) => i !== idx)
    const newFields = {
      ...peopleFields,
      [field]: newEmails,
    }
    setPeopleFields(newFields)
    onFilterChange(buildFilterString(newFields))
  }

  const handleKeyDown = (field: keyof GmailPeopleFields, e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.key === 'Enter' && peopleInputs[field].trim()) {
      addEmail(field)
    }
  }

  return (
    <div className="px-4 py-3 space-y-3">
      {(['from', 'to', 'cc', 'bcc'] as const).map((field) => (
        <div key={field} className="space-y-2">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400 uppercase">
            {field}
          </label>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <input
                type="text"
                placeholder={`Enter ${field} address`}
                value={peopleInputs[field]}
                onChange={(e) => {
                  setPeopleInputs(prev => ({
                    ...prev,
                    [field]: e.target.value,
                  }))
                  // Clear error when user starts typing
                  if (showError[field]) {
                    setShowError(prev => ({ ...prev, [field]: false }))
                  }
                }}
                onKeyDown={(e) => handleKeyDown(field, e)}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                className={`flex-1 w-full px-3 py-2 text-sm border rounded-md bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-0 ${
                  showError[field]
                    ? 'border-red-500 dark:border-red-500 focus:border-red-500 dark:focus:border-red-500'
                    : 'border-gray-300 dark:border-gray-600 focus:border-gray-300 dark:focus:border-gray-600'
                }`}
              />
              {showError[field] && (
                <p className="mt-1 text-xs text-red-500 dark:text-red-400">
                  Please enter a valid email address
                </p>
              )}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                addEmail(field)
              }}
              className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          {/* Display added emails as pills */}
          {peopleFields[field].length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {peopleFields[field].map((email, idx) => (
                <div
                  key={idx}
                  className="inline-flex items-center gap-1.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 px-2.5 py-1 rounded-md text-xs"
                >
                  <span>{email}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeEmail(field, idx)
                    }}
                    className="hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm p-0.5"
                  >
                    <LucideX className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
