import { createFileRoute } from "@tanstack/react-router"
import CallHistory from "@/components/CallHistory"

export const Route = createFileRoute("/_authenticated/buzz/history")({
  component: BuzzHistory,
})

function BuzzHistory() {
  return (
    <div className="fixed left-[112px] top-0 right-0 bottom-0 z-10">
      <CallHistory />
    </div>
  )
}
