import { createFileRoute, redirect } from "@tanstack/react-router"
import { CallType } from "@/types"

// Old route - redirect to new authenticated route format
export const Route = createFileRoute("/call")({
  beforeLoad: ({ search }: any) => {
    // If they have callId in query params, redirect to new format
    if (search?.callId) {
      throw redirect({
        to: "/call/$callId",
        params: { callId: search.callId },
        search: { type: search.type || CallType.Video },
      })
    }
    // Otherwise redirect to home or show error
    throw redirect({ to: "/" })
  },
})
