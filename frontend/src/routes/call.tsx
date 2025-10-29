import { createFileRoute, redirect } from "@tanstack/react-router"
import { CallType } from "@/types"

// Old route - redirect to new authenticated route format
export const Route = createFileRoute("/call")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { callId?: string; type?: CallType } => {
    return {
      callId: search.callId as string | undefined,
      type:
        search.type === CallType.Video || search.type === CallType.Audio
          ? (search.type as CallType)
          : undefined,
    }
  },
  beforeLoad: ({ search }) => {
    // If they have callId in query params, redirect to new format
    if (search.callId) {
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
