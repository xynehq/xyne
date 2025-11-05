import React, { useState, useEffect } from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface TimelineFilterProps {
  filterValue?: string
  onFilterChange: (value: string) => void
  slackUsers?: Array<{ id: string; name: string }>
  selectedPeople?: Set<string>
  selectedChannels?: Set<string>
}

interface DateRangePickerProps {
  dateRange: { start: Date | null; end: Date | null }
  setDateRange: React.Dispatch<React.SetStateAction<{ start: Date | null; end: Date | null }>>
  currentMonth: Date
  setCurrentMonth: React.Dispatch<React.SetStateAction<Date>>
  onApply: () => void
  onCancel: () => void
}

const DateRangePicker: React.FC<DateRangePickerProps> = ({
  dateRange,
  setDateRange,
  currentMonth,
  setCurrentMonth,
  onApply,
  onCancel,
}) => {
  const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate()
  const firstDayOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getDay()
  
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const handleDateClick = (day: number) => {
    const clickedDate = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day)
    
    if (!dateRange.start || (dateRange.start && dateRange.end)) {
      setDateRange({ start: clickedDate, end: null })
    } else {
      if (clickedDate < dateRange.start) {
        setDateRange({ start: clickedDate, end: dateRange.start })
      } else {
        setDateRange({ start: dateRange.start, end: clickedDate })
      }
    }
  }
  
  const isDateInRange = (day: number) => {
    if (!dateRange.start) return false
    const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day)
    if (dateRange.end) {
      return date >= dateRange.start && date <= dateRange.end
    }
    return date.getTime() === dateRange.start.getTime()
  }
  
  const isDateSelected = (day: number) => {
    const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day)
    return (dateRange.start && date.getTime() === dateRange.start.getTime()) ||
           (dateRange.end && date.getTime() === dateRange.end.getTime())
  }
  
  const previousMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1))
  }
  
  const nextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1))
  }
  
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {monthNames[currentMonth.getMonth()]} {currentMonth.getFullYear()}
        </h3>
        <div className="flex gap-2">
          <button
            onClick={previousMonth}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          >
            <ChevronLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
          </button>
          <button
            onClick={nextMonth}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          >
            <ChevronRight className="w-5 h-5 text-gray-600 dark:text-gray-400" />
          </button>
        </div>
      </div>
      
      <div className="grid grid-cols-7 gap-1 mb-2">
        {dayNames.map(day => (
          <div key={day} className="text-center text-sm font-medium text-gray-500 dark:text-gray-400 py-2">
            {day}
          </div>
        ))}
      </div>
      
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: firstDayOfMonth }).map((_, i) => (
          <div key={`empty-${i}`} />
        ))}
        
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1
          const inRange = isDateInRange(day)
          const selected = isDateSelected(day)
          
          return (
            <button
              key={day}
              onClick={() => handleDateClick(day)}
              className={`
                aspect-square p-2 text-sm rounded-full
                ${selected ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900' : ''}
                ${inRange && !selected ? 'bg-gray-200 dark:bg-gray-700' : ''}
                ${!inRange && !selected ? 'hover:bg-gray-100 dark:hover:bg-gray-700' : ''}
                text-gray-900 dark:text-gray-100
              `}
            >
              {day}
            </button>
          )
        })}
      </div>
      
      <div className="flex gap-2 mt-4">
        <button
          onClick={onCancel}
          className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
        <button
          onClick={onApply}
          disabled={!dateRange.start || !dateRange.end}
          className="flex-1 px-4 py-2 text-sm font-medium text-white bg-gray-900 dark:bg-gray-100 dark:text-gray-900 rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Apply
        </button>
      </div>
    </div>
  )
}

export const TimelineFilter: React.FC<TimelineFilterProps> = ({
  filterValue,
  onFilterChange,
  slackUsers = [],
  selectedPeople = new Set(),
  selectedChannels = new Set(),
}) => {
  const [selectedTimeline, setSelectedTimeline] = useState<string | null>(null)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [dateRange, setDateRange] = useState<{ start: Date | null; end: Date | null }>({
    start: null,
    end: null,
  })
  const [currentMonth, setCurrentMonth] = useState(new Date())

  // Parse existing timeline filter (only one allowed)
  useEffect(() => {
    if (!filterValue) {
      setSelectedTimeline(null)
      return
    }

    const filters = filterValue.split(', ').filter(f => f.trim())
    const timelineFilters = filters.filter(f => f.startsWith('~')).map(f => f.substring(1))
    // Only take the first timeline filter if multiple exist
    setSelectedTimeline(timelineFilters.length > 0 ? timelineFilters[0] : null)
  }, [filterValue])

  const handleTimelineSelect = (timelineOption: { label: string; value: string }) => {
    if (timelineOption.label === 'Custom date') {
      setShowDatePicker(true)
      return
    }

    // If clicking the already selected timeline, deselect it
    const newSelection = selectedTimeline === timelineOption.label 
      ? null 
      : timelineOption.label

    setSelectedTimeline(newSelection)

    // Build filter string with single timeline
    const selectedTimelineNames = newSelection ? [`~${newSelection}`] : []
    
    // Preserve existing non-timeline filters
    const currentFilters = filterValue?.split(', ').filter(f => f.trim()) || []
    const existingNonTimelineFilters = currentFilters.filter(f => !f.startsWith('~'))
    
    const combinedFilters = [...selectedTimelineNames, ...existingNonTimelineFilters]
    onFilterChange(combinedFilters.join(', '))
  }

  const handleDateRangeApply = () => {
    if (dateRange.start && dateRange.end) {
      const formatDate = (date: Date) => {
        const day = String(date.getDate()).padStart(2, '0')
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const year = date.getFullYear()
        return `${day}/${month}/${year}`
      }
      
      const dateRangeString = `${formatDate(dateRange.start)} → ${formatDate(dateRange.end)}`
      
      // Replace any existing timeline selection
      setSelectedTimeline(dateRangeString)
      
      // Build filter string with single timeline
      const selectedTimelineNames = [`~${dateRangeString}`]
      
      // Preserve existing non-timeline filters
      const currentFilters = filterValue?.split(', ').filter(f => f.trim()) || []
      const existingNonTimelineFilters = currentFilters.filter(f => !f.startsWith('~'))
      
      const combinedFilters = [...selectedTimelineNames, ...existingNonTimelineFilters]
      onFilterChange(combinedFilters.join(', '))
      
      setShowDatePicker(false)
      setDateRange({ start: null, end: null })
    }
  }

  return (
    <>
      {!showDatePicker ? (
        <div className="px-2 max-h-60 overflow-y-auto">
          {[
            { label: 'Last week', value: 'last_week' },
            { label: 'Last month', value: 'last_month' },
            { label: 'Last 7 days', value: 'last_7_days' },
            { label: 'Last 14 days', value: 'last_14_days' },
            { label: 'Custom date', value: 'custom_date' }
          ].map((timelineOption) => (
            <DropdownMenuItem
              key={timelineOption.value}
              onSelect={(e) => {
                e.preventDefault()
                handleTimelineSelect(timelineOption)
              }}
              className="flex items-center cursor-pointer text-sm py-2 px-2 hover:!bg-gray-100 dark:hover:!bg-gray-700 focus:!bg-gray-100 dark:focus:!bg-gray-700 data-[highlighted]:!bg-gray-100 dark:data-[highlighted]:!bg-gray-700 rounded"
            >
              <input 
                type="checkbox" 
                className="mr-3" 
                checked={
                  selectedTimeline === timelineOption.label || 
                  (timelineOption.label === 'Custom date' && selectedTimeline?.includes('→'))
                }
                onChange={() => {}}
              />
              <span className="text-gray-700 dark:text-gray-200">{timelineOption.label}</span>
            </DropdownMenuItem>
          ))}
        </div>
      ) : (
        <div className="p-4">
          <DateRangePicker
            dateRange={dateRange}
            setDateRange={setDateRange}
            currentMonth={currentMonth}
            setCurrentMonth={setCurrentMonth}
            onApply={handleDateRangeApply}
            onCancel={() => {
              setShowDatePicker(false)
              setDateRange({ start: null, end: null })
            }}
          />
        </div>
      )}
    </>
  )
}
