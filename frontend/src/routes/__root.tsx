import { createRootRoute, Outlet } from "@tanstack/react-router"
import { useCallNotifications } from "@/services/callNotifications"
import { IncomingCallModal } from "@/components/IncomingCallModal"

function RootComponent() {
  const { incomingCall, acceptCall, rejectCall, dismissCall } = useCallNotifications()

  return (
    <>
      <Outlet />
      <IncomingCallModal
        notification={incomingCall}
        onAccept={acceptCall}
        onReject={rejectCall}
        onDismiss={dismissCall}
      />
    </>
  )
}

export const Route = createRootRoute({
  component: RootComponent,
})
