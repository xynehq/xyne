import { createRootRoute, Outlet } from "@tanstack/react-router"
import { useCallNotifications } from "@/services/callNotifications"
import { IncomingCallModal } from "@/components/IncomingCallModal"
import { UnreadCountProvider } from "@/contexts/UnreadCountContext"
import { useGlobalUnreadTracker } from "@/hooks/useGlobalUnreadTracker"

function RootContent() {
  const { incomingCall, acceptCall, rejectCall, dismissCall } =
    useCallNotifications()
  useGlobalUnreadTracker() // Track unread messages globally

  return (
    <>
      <Outlet />
      <IncomingCallModal
        notification={incomingCall}
        onAccept={acceptCall}
        onReject={rejectCall}
        onDismiss={dismissCall}
      />
      <div className="fixed bottom-0 right-5 z-50 text-xs text-gray-400 dark:text-gray-500 font-mono pointer-events-none">
        v{__APP_VERSION__}
      </div>
    </>
  )
}

function RootComponent() {
  return (
    <UnreadCountProvider>
      <RootContent />
    </UnreadCountProvider>
  )
}

export const Route = createRootRoute({
  component: RootComponent,
})
