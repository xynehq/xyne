import { createFileRoute, redirect } from "@tanstack/react-router"

// Old route - redirect to new authenticated route format
export const Route = createFileRoute("/call")({
  beforeLoad: ({ search }: any) => {
    // If they have callId in query params, redirect to new format
    if (search?.callId) {
      throw redirect({
        to: "/call/$callId",
        params: { callId: search.callId },
        search: { type: search.type || "video" },
      })
    }
    // Otherwise redirect to home or show error
    throw redirect({ to: "/" })
  },
})
