import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
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

export const SearchFilters = ({ onLastUpdated }: { onLastUpdated: any }) => {
  const [position, setPosition] = useState<LastUpdated>("anytime")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* <div className="flex flex-row items-center"> */}
        <Button className="bg-white hover:bg-white text-[#7488A8] border-none shadow-none focus-visible:ring-0">
          <Clock8 size={14} className="mr-[4px] text-[#7488A8]" />
          {positionToText(position)}
        </Button>
        {/* </div> */}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        {/* <DropdownMenuLabel>Panel Position</DropdownMenuLabel> */}
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={position}
          onValueChange={(v) => {
            setPosition(v as LastUpdated)
            onLastUpdated(position)
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
