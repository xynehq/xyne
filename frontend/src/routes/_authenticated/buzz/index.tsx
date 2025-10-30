import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/_authenticated/buzz/")({
  beforeLoad: () => {
    throw redirect({ to: "/buzz/chats" })
  },
})
