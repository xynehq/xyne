import { TooltipContent } from "@radix-ui/react-tooltip"

export function Tip({
  info,
  side,
  margin,
}: {
  info: string
  side?: "top" | "right" | "bottom" | "left"
  margin?: string
}) {
  if (!margin) {
    margin = "mb-[7px]"
    if (side === "right") {
      margin = "ml-[22px]"
    }
  }

  return (
    <TooltipContent side={side}>
      <p
        className={`bg-[#2F3338] text-white ${margin} pl-[7px] pr-[7px] pt-[6px] pb-[6px] rounded-[6px] text-[13px] leading-[16px] tracking-[0.01em]`}
      >
        {info}
      </p>
    </TooltipContent>
  )
}
