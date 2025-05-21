import React from 'react'
import { cn } from '@/lib/utils' // Import the cn utility function
import { Label } from '@/components/ui/label' // Import Label component
import { Input } from '@/components/ui/input' // Import Input component

// Define the props interface
interface DateRangePickerProps {
  startDate: Date | null
  endDate: Date | null
  onStartDateChange: (date: Date | null) => void
  onEndDateChange: (date: Date | null) => void
  className?: string
}

export function DateRangePicker({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  className,
}: DateRangePickerProps) {
  const formatDateForInput = (date: Date | null) => {
    if (!date) return ''
    return date.toISOString().split('T')[0]
  }

  const handleStartDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    if (!value) {
      onStartDateChange(null)
      return
    }
    const date = new Date(value)
    onStartDateChange(date)
  }

  const handleEndDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    if (!value) {
      onEndDateChange(null)
      return
    }
    const date = new Date(value)
    onEndDateChange(date)
  }

  return (
    <div className={cn("grid gap-4", className)}>
      <div className="grid gap-2">
        <Label htmlFor="start-date">Start Date</Label>
        <Input
          id="start-date"
          type="date"
          value={formatDateForInput(startDate)}
          onChange={handleStartDateChange}
          max={formatDateForInput(endDate)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="end-date">End Date</Label>
        <Input
          id="end-date"
          type="date"
          value={formatDateForInput(endDate)}
          onChange={handleEndDateChange}
          min={formatDateForInput(startDate)}
        />
      </div>
    </div>
  )
}