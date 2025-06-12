import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Clock8 } from "lucide-react"
import { useState } from "react"

export type LastUpdated =
  | "anytime"
  | "pastDay"
  | "pastWeek"
  | "pastMonth"
  | "pastYear"
  | "custom"

const positionToText = (position: LastUpdated) => {
  switch (position) {
    case "anytime":
      return "Any time"
    case "pastDay":
      return "Past Day"
    case "pastWeek":
      return "Past Week"
    case "pastMonth":
      return "Past Month"
    case "pastYear":
      return "Past Year"
    case "custom":
      return "Custom"
  }
}

const positionValues: LastUpdated[] = [
  "anytime",
  "pastDay",
  "pastWeek",
  "pastMonth",
  "pastYear",
  "custom",
]

export const SearchFilters = ({
  onLastUpdated,
  filter,
}: { onLastUpdated: (value: LastUpdated) => void; filter: any }) => {
  const [position, setPosition] = useState<LastUpdated>(
    filter.lastUpdated || "anytime",
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="bg-transparent hover:bg-gray-100 dark:bg-transparent dark:hover:bg-slate-700 text-[#7488A8] dark:text-slate-400 border-none shadow-none focus-visible:ring-0">
          <Clock8
            size={14}
            className="mr-[4px] text-[#7488A8] dark:text-slate-400"
          />
          {positionToText(position)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={position}
          onValueChange={(v) => {
            setPosition(v as LastUpdated)
            onLastUpdated(v as LastUpdated)
          }}
        >
          {positionValues.map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {positionToText(value)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
