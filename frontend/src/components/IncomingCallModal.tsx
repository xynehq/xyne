import { Phone, PhoneOff, Video } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import type { CallNotification } from "@/services/callNotifications"

interface IncomingCallModalProps {
  notification: CallNotification | null
  onAccept: (notification: CallNotification) => void
  onReject: (notification: CallNotification) => void
  onDismiss: () => void
}

export function IncomingCallModal({
  notification,
  onAccept,
  onReject,
  onDismiss,
}: IncomingCallModalProps) {
  if (!notification) return null

  const { caller, callType } = notification

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-md mx-auto bg-white dark:bg-gray-800 shadow-2xl animate-in fade-in-0 zoom-in-95 duration-300">
        <CardContent className="p-6 text-center space-y-6">
          {/* Caller Avatar */}
          <div className="flex justify-center">
            <div className="h-20 w-20 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-2xl font-semibold ring-4 ring-blue-500">
              {caller.photoLink ? (
                <img
                  src={caller.photoLink}
                  alt={caller.name}
                  className="h-20 w-20 rounded-full object-cover"
                />
              ) : (
                caller.name
                  .split(" ")
                  .map((n) => n[0])
                  .join("")
              )}
            </div>
          </div>

          {/* Call Info */}
          <div className="space-y-2">
            <h3 className="text-xl font-semibold text-gray-900 dark:text-white">
              Incoming {callType === "video" ? "Video" : "Audio"} Call
            </h3>
            <p className="text-lg font-medium text-gray-700 dark:text-gray-300">
              {caller.name}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {caller.email}
            </p>
          </div>

          {/* Call Type Icon */}
          <div className="flex justify-center">
            {callType === "video" ? (
              <Video className="h-8 w-8 text-blue-500 animate-pulse" />
            ) : (
              <Phone className="h-8 w-8 text-green-500 animate-pulse" />
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex gap-4 justify-center">
            <Button
              onClick={() => onReject(notification)}
              variant="destructive"
              size="lg"
              className="w-16 h-16 rounded-full p-0 bg-red-500 hover:bg-red-600"
            >
              <PhoneOff className="h-6 w-6" />
            </Button>

            <Button
              onClick={() => onAccept(notification)}
              variant="default"
              size="lg"
              className="w-16 h-16 rounded-full p-0 bg-green-500 hover:bg-green-600 text-white"
            >
              <Phone className="h-6 w-6" />
            </Button>
          </div>

          {/* Dismiss Button */}
          <Button
            onClick={onDismiss}
            variant="ghost"
            size="sm"
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Dismiss
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
