import { useState } from "react"
import { Calendar as CalendarIcon, X } from "lucide-react"
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isWithinInterval, startOfDay, endOfDay } from "date-fns"
import * as Popover from "@radix-ui/react-popover"
import { cn } from "@/lib/utils"

interface DateRangePickerProps {
  from?: Date
  to?: Date
  onSelect: (from: Date | undefined, to: Date | undefined) => void
  placeholder?: string
  className?: string

  minYear?: number
  maxYear?: number
}

export function DateRangePicker({
  from,
  to,
  onSelect,
  placeholder = "Select date range",
  className,
  minYear = new Date().getFullYear() - 100,
  maxYear = new Date().getFullYear() + 10,
}: DateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [tempFrom, setTempFrom] = useState<Date | undefined>(from)
  const [tempTo, setTempTo] = useState<Date | undefined>(to)
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [selectingFrom, setSelectingFrom] = useState(true)

  // Sync temp state with props when popup opens
  const handleOpenChange = (open: boolean) => {
    if (open) {
      setTempFrom(from)
      setTempTo(to)
      setSelectingFrom(true)
      // Set current month to the 'from' date if it exists, otherwise 'to' date, otherwise current month
      if (from) {
        setCurrentMonth(from)
      } else if (to) {
        setCurrentMonth(to)
      }
    }
    setIsOpen(open)
  }

  const handleDateClick = (date: Date) => {
    if (selectingFrom) {
      setTempFrom(date)
      setTempTo(undefined)
      setSelectingFrom(false)
    } else {
      if (tempFrom && date < tempFrom) {
        // If selected date is before 'from', swap them
        setTempTo(tempFrom)
        setTempFrom(date)
      } else {
        setTempTo(date)
      }
    }
  }

  const handleApply = () => {
    // Normalize dates: from = start of day, to = end of day
    const normalizedFrom = tempFrom ? startOfDay(tempFrom) : undefined
    const normalizedTo = tempTo ? endOfDay(tempTo) : undefined
    onSelect(normalizedFrom, normalizedTo)
    setIsOpen(false)
  }

  const handleCancel = () => {
    setTempFrom(from)
    setTempTo(to)
    setSelectingFrom(true)
    setIsOpen(false)
  }

  const handleClear = () => {
    setTempFrom(undefined)
    setTempTo(undefined)
    setSelectingFrom(true)
    onSelect(undefined, undefined)
  }

  const previousMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1))
  }

  const nextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1))
  }

  const daysInMonth = eachDayOfInterval({
    start: startOfMonth(currentMonth),
    end: endOfMonth(currentMonth),
  })

  const firstDayOfMonth = startOfMonth(currentMonth).getDay()

  const isDateInRange = (date: Date) => {
    if (!tempFrom || !tempTo) return false
    // Normalize all dates to start of day for proper comparison
    const normalizedDate = startOfDay(date)
    const normalizedFrom = startOfDay(tempFrom)
    const normalizedTo = startOfDay(tempTo)
    return isWithinInterval(normalizedDate, { start: normalizedFrom, end: normalizedTo })
  }

  const isDateSelected = (date: Date) => {
    return (tempFrom && isSameDay(date, tempFrom)) || (tempTo && isSameDay(date, tempTo))
  }

  const displayText =
    from && to
      ? `${format(from, "dd/MM/yyyy")} - ${format(to, "dd/MM/yyyy")}`
      : from
      ? `From: ${format(from, "dd/MM/yyyy")}`
      : to
      ? `To: ${format(to, "dd/MM/yyyy")}`
      : placeholder

  return (
    <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
      <div className="flex items-center gap-2">
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm border border-input bg-background rounded-md hover:bg-muted/50 transition-colors",
              !from && !to && "text-muted-foreground",
              className
            )}
          >
            <CalendarIcon className="h-4 w-4" />
            <span>{displayText}</span>
          </button>
        </Popover.Trigger>
        
        {(from || to) && (
          <button
            type="button"
            onClick={handleClear}
            className="p-1.5 hover:bg-muted rounded-sm transition-colors"
            title="Clear date range"
          >
            <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
          </button>
        )}
      </div>

      <Popover.Portal>
        <Popover.Content
          className="z-50 w-[320px] p-0 bg-white dark:bg-slate-900 rounded-lg shadow-lg border border-slate-200 dark:border-slate-800"
          sideOffset={5}
          align="start"
        >
          <div className="p-6">
            {/* Month Navigation */}
            <div className="flex items-center justify-between mb-4 gap-2">
              <button
                type="button"
                onClick={previousMonth}
                className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors flex-shrink-0"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              
              <div className="flex items-center gap-2 flex-1 justify-center">
                {/* Month Selector */}
                <div className="relative">
                  <select
                    value={currentMonth.getMonth()}
                    onChange={(e) => {
                      const newMonth = new Date(currentMonth.getFullYear(), parseInt(e.target.value), 1)
                      setCurrentMonth(newMonth)
                    }}
                    className="appearance-none px-3 py-1.5 pr-8 text-sm font-semibold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300 dark:focus:ring-slate-600 focus:border-slate-400 dark:focus:border-slate-500 cursor-pointer transition-colors"
                  >
                    {Array.from({ length: 12 }, (_, i) => (
                      <option key={i} value={i}>
                        {format(new Date(2000, i, 1), "MMMM")}
                      </option>
                    ))}
                  </select>
                  <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                    <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {/* Year Selector */}
                <div className="relative">
                  <select
                    value={currentMonth.getFullYear()}
                    onChange={(e) => {
                      const newMonth = new Date(parseInt(e.target.value), currentMonth.getMonth(), 1)
                      setCurrentMonth(newMonth)
                    }}
                    className="appearance-none px-3 py-1.5 pr-8 text-sm font-semibold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300 dark:focus:ring-slate-600 focus:border-slate-400 dark:focus:border-slate-500 cursor-pointer transition-colors"
                  >
                    {Array.from({ length: maxYear - minYear + 1 }, (_, i) => {
                      const year = minYear + i
                      return (
                        <option key={year} value={year}>
                          {year}
                        </option>
                      )
                    })}
                  </select>
                  <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                    <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
              </div>
              
              <button
                type="button"
                onClick={nextMonth}
                className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors flex-shrink-0"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>

            {/* Calendar Grid */}
            <div className="mb-6">
              {/* Day Headers */}
              <div className="grid grid-cols-7 gap-2 mb-3">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                  <div key={day} className="text-center text-sm font-medium text-slate-500 dark:text-slate-400 py-2">
                    {day}
                  </div>
                ))}
              </div>

              {/* Days Grid */}
              <div className="grid grid-cols-7 gap-2">
                {/* Empty cells for days before month starts */}
                {Array.from({ length: firstDayOfMonth }).map((_, index) => (
                  <div key={`empty-${index}`} className="w-10 h-10" />
                ))}
                
                {/* Actual days */}
                {daysInMonth.map((date) => {
                  const isSelected = isDateSelected(date)
                  const isInRange = isDateInRange(date)
                  const isToday = isSameDay(date, new Date())

                  return (
                    <button
                      key={date.toISOString()}
                      type="button"
                      onClick={() => handleDateClick(date)}
                      className={cn(
                        "w-10 h-10 flex items-center justify-center rounded-full text-sm transition-colors",
                        isSelected && "bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold",
                        !isSelected && isInRange && "bg-slate-100 dark:bg-slate-800",
                        !isSelected && !isInRange && "hover:bg-slate-100 dark:hover:bg-slate-800",
                        isToday && !isSelected && "border border-slate-300 dark:border-slate-600"
                      )}
                    >
                      {format(date, "d")}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={handleCancel}
                className="flex-1 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApply}
                disabled={!tempFrom}
                className={cn(
                  "flex-1 px-4 py-2 text-sm font-medium rounded-md transition-colors",
                  tempFrom
                    ? "bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200"
                    : "bg-slate-200 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed"
                )}
              >
                Apply
              </button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
