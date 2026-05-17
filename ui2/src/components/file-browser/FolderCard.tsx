// Plain folder glyph, but centered inside the same bounding box FileCard
// occupies so the grid lays out evenly.

import { Folder } from "lucide-react"
import { cn } from "@/lib/utils"

type Props = {
  size?: "sm" | "md"
}

export function FolderCard({ size = "md" }: Props): JSX.Element {
  const isSm = size === "sm"
  return (
    <div
      aria-hidden
      className={cn(
        "flex items-center justify-center",
        isSm ? "h-[3rem] w-9" : "h-[4.5rem] w-14",
      )}
    >
      <Folder
        strokeWidth={1.5}
        className={cn(
          "text-muted-foreground",
          isSm ? "h-5 w-5" : "h-10 w-10",
        )}
      />
    </div>
  )
}
