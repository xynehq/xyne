import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Calendar } from "lucide-react"
import { useState, useEffect, useRef } from "react"

export type LastUpdated =
  | "anytime"
  | "pastDay"
  | "pastWeek"
  | "pastMonth"
  | "pastYear"
  | "custom"

interface SearchFiltersProps {
  onLastUpdated: (value: LastUpdated) => void;
  filter: any;
}

interface DateRange {
  from: Date | null;
  to: Date | null;
}

export function SearchFilters({ onLastUpdated, filter }: SearchFiltersProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [selectedOption, setSelectedOption] = useState<string>("All time")
  const [lastUpdated, setLastUpdated] = useState<LastUpdated>(filter.lastUpdated || "anytime")
  const [dateRange, setDateRange] = useState<DateRange>({
    from: null,
    to: null
  })

  const initialRightMonth = new Date()
  initialRightMonth.setDate(1)
  
  const initialLeftMonth = new Date(initialRightMonth)
  initialLeftMonth.setMonth(initialLeftMonth.getMonth() - 1)

  const [currentMonthLeft, setCurrentMonthLeft] = useState(initialLeftMonth)
  const [currentMonthRight, setCurrentMonthRight] = useState(initialRightMonth)
  const [customSelection, setCustomSelection] = useState(false)
  const [showYearPickerLeft, setShowYearPickerLeft] = useState(false)
  const [showYearPickerRight, setShowYearPickerRight] = useState(false)
  const [showMonthPickerLeft, setShowMonthPickerLeft] = useState(false)
  const [showMonthPickerRight, setShowMonthPickerRight] = useState(false)

  const yearPickerLeftRef = useRef<HTMLDivElement>(null)
  const yearPickerRightRef = useRef<HTMLDivElement>(null)
  const monthPickerLeftRef = useRef<HTMLDivElement>(null)
  const monthPickerRightRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        yearPickerLeftRef.current &&
        !yearPickerLeftRef.current.contains(event.target as Node)
      ) {
        setShowYearPickerLeft(false)
      }
      if (
        yearPickerRightRef.current &&
        !yearPickerRightRef.current.contains(event.target as Node)
      ) {
        setShowYearPickerRight(false)
      }
      if (
        monthPickerLeftRef.current &&
        !monthPickerLeftRef.current.contains(event.target as Node)
      ) {
        setShowMonthPickerLeft(false)
      }
      if (
        monthPickerRightRef.current &&
        !monthPickerRightRef.current.contains(event.target as Node)
      ) {
        setShowMonthPickerRight(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [])

  function formatDate(date: Date | null) {
    if (!date) return ""
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
  }

  function formatMonthYear(date: Date) {
    return date.toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric'
    })
  }

  function formatMonth(date: Date) {
    return date.toLocaleDateString('en-US', { month: 'long' })
  }

  function formatYear(date: Date) {
    return date.getFullYear().toString()
  }

  function addDays(date: Date, days: number) {
    const result = new Date(date)
    result.setDate(result.getDate() + days)
    return result
  }

  function subtractDays(date: Date, days: number) {
    const result = new Date(date)
    result.setDate(result.getDate() - days)
    return result
  }

  function startOfWeek(date: Date) {
    const result = new Date(date)
    const day = result.getDay()
    result.setDate(result.getDate() - day)
    return result
  }

  function endOfWeek(date: Date) {
    const result = startOfWeek(date)
    result.setDate(result.getDate() + 6)
    return result
  }

  function startOfMonth(date: Date) {
    return new Date(date.getFullYear(), date.getMonth(), 1)
  }

  function endOfMonth(date: Date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0)
  }

  function subtractMonths(date: Date, months: number) {
    const result = new Date(date)
    result.setMonth(result.getMonth() - months)
    return result
  }

  const today = new Date()
  const presetOptions: Array<{ label: string; lastUpdated: LastUpdated; getValue: () => DateRange }> = [
    { label: "Today", lastUpdated: "pastDay", getValue: () => ({ from: today, to: today }) },
    { label: "Last 7 days", lastUpdated: "pastWeek", getValue: () => ({ from: subtractDays(today, 7), to: today }) },
    { label: "Last 14 days", lastUpdated: "pastWeek", getValue: () => ({ from: subtractDays(today, 14), to: today }) },
    { label: "Last 30 days", lastUpdated: "pastMonth", getValue: () => ({ from: subtractDays(today, 30), to: today }) },
    { label: "This week", lastUpdated: "pastWeek", getValue: () => ({ from: startOfWeek(today), to: endOfWeek(today) }) },
    { label: "This month", lastUpdated: "pastMonth", getValue: () => ({ from: startOfMonth(today), to: endOfMonth(today) }) },
    { label: "Last month", lastUpdated: "pastMonth", getValue: () => ({ from: startOfMonth(subtractMonths(today, 1)), to: endOfMonth(subtractMonths(today, 1)) }) },
    { label: "All time", lastUpdated: "anytime", getValue: () => ({ from: null, to: null }) },
  ]

  const handleOptionClick = (option: { label: string; lastUpdated: LastUpdated; getValue: () => DateRange }) => {
    setCustomSelection(false)
    setSelectedOption(option.label)
    setLastUpdated(option.lastUpdated)
    const newRange = option.getValue()
    setDateRange(newRange)
  }

  const handlePrevMonthLeft = () => {
    setCurrentMonthLeft(prev => {
      const newMonth = new Date(prev)
      newMonth.setMonth(newMonth.getMonth() - 1)
      return newMonth
    })
  }

  const handleNextMonthLeft = () => {
    setCurrentMonthLeft(prev => {
      const newMonth = new Date(prev)
      newMonth.setMonth(newMonth.getMonth() + 1)
      return newMonth
    })
  }

  const handlePrevMonthRight = () => {
    setCurrentMonthRight(prev => {
      const newMonth = new Date(prev)
      newMonth.setMonth(newMonth.getMonth() - 1)
      return newMonth
    })
  }

  const handleNextMonthRight = () => {
    setCurrentMonthRight(prev => {
      const newMonth = new Date(prev)
      newMonth.setMonth(newMonth.getMonth() + 1)
      return newMonth
    })
  }

  const handleDateClick = (date: Date) => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
  
    if (date > today) {
      return
    }
  
    setCustomSelection(true)
    setSelectedOption("Custom")
    setLastUpdated("custom")
    
    if (!dateRange.from || (dateRange.from && dateRange.to)) {
      setDateRange({ from: date, to: null })
    } else if (dateRange.from && !dateRange.to) {
      if (date < dateRange.from) {
        setDateRange({ from: date, to: dateRange.from })
      } else {
        setDateRange({ from: dateRange.from, to: date })
      }
    }
  }

  const handleApply = () => {
    onLastUpdated(lastUpdated)
    setIsOpen(false)
  }

  const handleCancel = () => {
    setDateRange({
      from: null,
      to: null
    })
    setSelectedOption("All time")
    setLastUpdated("anytime")
    setCustomSelection(false)
    setIsOpen(false)
  }

  const formatDateRange = () => {
    if (!dateRange.from && !dateRange.to) return "All time"
    if (dateRange.from && dateRange.to && dateRange.from.toDateString() === dateRange.to.toDateString()) {
      return formatDate(dateRange.from)
    }
    if (dateRange.from && dateRange.to) {
      return customSelection
        ? `${formatDate(dateRange.from)} - ${formatDate(dateRange.to)}`
        : selectedOption
    }
    return selectedOption
  }

  const isDateInRange = (date: Date) => {
    if (!dateRange.from || !dateRange.to) return false
    const start = new Date(dateRange.from)
    start.setHours(0, 0, 0, 0)
    const end = new Date(dateRange.to)
    end.setHours(0, 0, 0, 0)
    const current = new Date(date)
    current.setHours(0, 0, 0, 0)
    return current >= start && current <= end
  }
  
  const isDateRangeStart = (date: Date) => {
    if (!dateRange.from) return false
    const start = new Date(dateRange.from)
    start.setHours(0, 0, 0, 0)
    const current = new Date(date)
    current.setHours(0, 0, 0, 0)
    return current.toDateString() === start.toDateString()
  }
  
  const isDateRangeEnd = (date: Date) => {
    if (!dateRange.to) return false
    const end = new Date(dateRange.to)
    end.setHours(0, 0, 0, 0)
    const current = new Date(date)
    current.setHours(0, 0, 0, 0)
    return current.toDateString() === end.toDateString()
  }

  const generateCalendarDays = (currentMonth: Date) => {
    const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate()
    const firstDayOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getDay()
  
    const prevMonth = new Date(currentMonth)
    prevMonth.setMonth(prevMonth.getMonth() - 1)
    const daysInPrevMonth = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate()
  
    const days: { day: number; date: Date; isPrevMonth?: boolean; isNextMonth?: boolean; isCurrentMonth?: boolean }[] = []
  
    for (let i = firstDayOfMonth - 1; i >= 0; i--) {
      const day = daysInPrevMonth - i
      const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, day)
      days.push({ day, date, isPrevMonth: true })
    }
  
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day)
      days.push({ day, date, isCurrentMonth: true })
    }
  
    const totalDays = days.length
    const remainingDays = 42 - totalDays
    for (let day = 1; day <= remainingDays; day++) {
      const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, day)
      days.push({ day, date, isNextMonth: true })
    }
  
    return days
  }

  const renderCalendar = (
    currentMonth: Date,
    handlePrevMonth: () => void,
    handleNextMonth: () => void,
    isLeft: boolean
  ) => {
    const days = generateCalendarDays(currentMonth)
    const weekDays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
    const showYearPicker = isLeft ? showYearPickerLeft : showYearPickerRight
    const setShowYearPicker = isLeft ? setShowYearPickerLeft : setShowYearPickerRight
    const showMonthPicker = isLeft ? showMonthPickerLeft : showMonthPickerRight
    const setShowMonthPicker = isLeft ? setShowMonthPickerLeft : setShowMonthPickerRight
    const setCurrentMonth = isLeft ? setCurrentMonthLeft : setCurrentMonthRight

    const years = Array.from({ length: 8 }, (_, i) => today.getFullYear() - 4 + i)
    const months = Array.from({ length: 12 }, (_, i) =>
      new Date(2023, i, 1).toLocaleDateString('en-US', { month: 'long' })
    )

    const handleYearClick = (year: number) => {
      setCurrentMonth((prev: Date) => {
        const newMonth = new Date(prev)
        newMonth.setFullYear(year)
        return newMonth
      })
      setShowYearPicker(false)
    }

    const handleMonthClick = (monthIndex: number) => {
      setCurrentMonth((prev: Date) => {
        const newMonth = new Date(prev)
        newMonth.setMonth(monthIndex)
        return newMonth
      })
      setShowMonthPicker(false)
    }

    return (
      <div className="calendar w-60 relative">
        <div className="flex justify-between items-center mb-2">
          <button
            onClick={handlePrevMonth}
            className="p-1 text-gray-500 hover:bg-gray-100 rounded"
            aria-label="Previous month"
          >
            &lt;
          </button>
          <div className="text-center font-medium flex items-center space-x-1">
            <button
              onClick={() => setShowMonthPicker(!showMonthPicker)}
              className="hover:cursor-pointer"
              aria-label="Select month"
            >
              {formatMonth(currentMonth)}
            </button>
            <button
              onClick={() => setShowYearPicker(!showYearPicker)}
              className="hover:cursor-pointer"
              aria-label="Select year"
            >
              {formatYear(currentMonth)}
            </button>
          </div>
          <button
            onClick={handleNextMonth}
            className="p-1 text-gray-500 hover:bg-gray-100 rounded"
            aria-label="Next month"
          >
            &gt;
          </button>
        </div>
        {showMonthPicker && (
          <div
            ref={isLeft ? monthPickerLeftRef : monthPickerRightRef}
            className="absolute top-8 left-1/2 transform -translate-x-1/2 bg-white border border-gray-200 shadow-lg rounded-lg z-10 max-h-48 overflow-y-auto"
          >
            {months.map((month, index) => (
              <button
                key={month}
                onClick={() => handleMonthClick(index)}
                className={`w-full text-center py-1 text-sm hover:bg-gray-100 transition-colors ${
                  month === formatMonth(currentMonth) ? "bg-blue-100 text-blue-700" : ""
                }`}
              >
                {month}
              </button>
            ))}
          </div>
        )}
        {showYearPicker && (
          <div
            ref={isLeft ? yearPickerLeftRef : yearPickerRightRef}
            className="absolute top-8 left-1/2 transform -translate-x-1/2 bg-white border border-gray-200 shadow-lg rounded-lg z-10 max-h-48 overflow-y-auto"
          >
            {years.map((year) => (
              <button
                key={year}
                onClick={() => handleYearClick(year)}
                className={`w-full text-center py-1 text-sm hover:bg-gray-100 transition-colors ${
                  year === currentMonth.getFullYear() ? "bg-blue-100 text-blue-700" : ""
                }`}
              >
                {year}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-7 gap-1 mb-1">
          {weekDays.map((day) => (
            <div key={day} className="text-center text-xs text-gray-500 py-1">
              {day}
            </div>
          ))}
          {days.map((day, index) => {
            const isInRange = isDateInRange(day.date)
            const isRangeStart = isDateRangeStart(day.date)
            const isRangeEnd = isDateRangeEnd(day.date)
            const isToday = day.date.toDateString() === new Date().toDateString()
            
            let className = "text-center py-1.5 text-sm cursor-pointer rounded transition-colors "
            
            if (day.isPrevMonth || day.isNextMonth) {
              className += "text-gray-400 "
            } else {
              className += "hover:bg-gray-100 "
            }
            
            if (isRangeStart && isRangeEnd) {
              className += "bg-blue-500 text-white hover:bg-blue-600 "
            } else if (isRangeStart) {
              className += "bg-blue-500 text-white hover:bg-blue-600 rounded-l-full "
            } else if (isRangeEnd) {
              className += "bg-blue-500 text-white hover:bg-blue-600 rounded-r-full "
            } else if (isInRange) {
              className += "bg-blue-100 hover:bg-blue-200 "
            }
            
            if (isToday && !isInRange && !isRangeStart && !isRangeEnd) {
              className += "border border-blue-500 "
            }
            
            return (
              <button
                key={index}
                className={className}
                onClick={() => handleDateClick(day.date)}
                aria-label={`Select ${day.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`}
              >
                {day.day}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button 
          className="bg-white hover:bg-gray-50 text-gray-600 shadow-sm focus-visible:ring-2 focus-visible:ring-blue-500"
          aria-label="Open time period filter"
        >
          <Calendar size={16} className="mr-2 text-gray-500" />
          {formatDateRange()}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-auto p-0 bg-white shadow-lg rounded-lg" align="start">
        <div className="flex">
          <div className="w-40 bg-gray-50 p-2 border-r border-gray-200">
            {presetOptions.map((option) => (
              <button
                key={option.label}
                className={`w-full text-left px-3 py-2 text-sm rounded hover:bg-gray-100 transition-colors ${
                  selectedOption === option.label ? "bg-blue-100 text-blue-700" : ""
                }`}
                onClick={() => handleOptionClick(option)}
                aria-label={`Select ${option.label} time period`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="p-4">
            <div className="flex gap-4">
              {renderCalendar(currentMonthLeft, handlePrevMonthLeft, handleNextMonthLeft, true)}
              {renderCalendar(currentMonthRight, handlePrevMonthRight, handleNextMonthRight, false)}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button 
                variant="outline" 
                className="text-sm py-1 px-4"
                onClick={handleCancel}
              >
                Cancel
              </Button>
              <Button 
                className="bg-blue-600 hover:bg-blue-700 text-white text-sm py-1 px-4"
                onClick={handleApply}
                disabled={!dateRange.from || !dateRange.to}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}