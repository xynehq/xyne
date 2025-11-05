import { createFileRoute } from "@tanstack/react-router"
import CallPage from "@/components/CallPage"
import { CallType } from "@/types"

// Define the search params type
type CallSearchParams = {
  type: CallType
}

export const Route = createFileRoute("/_authenticated/call/$callId")({
  component: CallPage,
  validateSearch: (search: Record<string, unknown>): CallSearchParams => {
    return {
      type:
        search.type === CallType.Video || search.type === CallType.Audio
          ? (search.type as CallType)
          : CallType.Video,
    }
  },
})
