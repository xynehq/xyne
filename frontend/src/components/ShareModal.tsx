import { useState, useEffect } from "react"
import { api } from "@/api"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SelectPublicMessage } from "shared/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Copy, ExternalLink, Trash2 } from "lucide-react"
import { toast } from "@/hooks/use-toast"

interface ShareModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  chatId: string | null
  messages: SelectPublicMessage[]
  onShareComplete?: () => void
}

interface SharedChat {
  shareToken: string
  title: string
  createdAt: string
  chatExternalId: string
  deletedAt: string | null
}

export function ShareModal({
  open,
  onOpenChange,
  chatId,
  messages,
  onShareComplete,
}: ShareModalProps) {
  const [shareLink, setShareLink] = useState("")
  const [isSharing, setIsSharing] = useState(false)
  const [existingShare, setExistingShare] = useState<SharedChat | null>(null)
  const [showManageShares, setShowManageShares] = useState(false)
  const [sharedChats, setSharedChats] = useState<SharedChat[]>([])
  const [loadingShares, setLoadingShares] = useState(false)
  const [deleteToken, setDeleteToken] = useState<string | null>(null)

  // Check if chat is already shared
  useEffect(() => {
    if (open && chatId) {
      checkExistingShare()
    }
  }, [open, chatId])

  const checkExistingShare = async () => {
    if (!chatId) return

    setLoadingShares(true)
    try {
      const response = await api.chat.share.check.$get({
        query: { chatId },
      })

      if (response.ok) {
        const data = await response.json()
        if (data.exists && data.share) {
          setExistingShare(data.share)
          setShareLink(
            `${window.location.origin}/chat?shareToken=${data.share.shareToken}`,
          )
        } else {
          setExistingShare(null)
          setShareLink("")
        }
      }
    } catch (error) {
      console.error("Failed to check existing shares:", error)
    } finally {
      setLoadingShares(false)
    }
  }

  const handleShare = async () => {
    if (!chatId || isSharing) return

    // Find the last message to share
    let messageIdToShare: string | undefined
    if (messages.length > 0) {
      const lastAssistantMessage = [...messages]
        .reverse()
        .find((msg) => msg.messageRole === "assistant")
      messageIdToShare =
        lastAssistantMessage?.externalId ||
        messages[messages.length - 1].externalId
    }

    if (!messageIdToShare) {
      toast({
        title: "Error",
        description: "No messages to share in this chat.",
        variant: "destructive",
      })
      return
    }

    setIsSharing(true)
    try {
      const response = await api.chat.share.create.$post({
        json: {
          chatId,
          messageId: messageIdToShare,
        },
      })

      if (response.ok) {
        const data = await response.json()
        const shareUrl = `${window.location.origin}/chat?shareToken=${data.shareToken}`
        setShareLink(shareUrl)
        setExistingShare({
          shareToken: data.shareToken,
          title: messages[0]?.message || "Untitled Chat",
          createdAt: new Date().toISOString(),
          chatExternalId: chatId,
          deletedAt: null,
        })

        // Copy to clipboard
        await navigator.clipboard.writeText(shareUrl)
        toast({
          title: "Link copied!",
          description: "Share link has been copied to clipboard.",
        })

        onShareComplete?.()
      } else {
        throw new Error("Failed to create share link")
      }
    } catch (error) {
      console.error("Failed to share chat:", error)
      toast({
        title: "Error",
        description: "Failed to create share link. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsSharing(false)
    }
  }

  const loadSharedChats = async () => {
    setLoadingShares(true)
    try {
      const response = await api.chat.shares.$get({
        query: { page: "0", limit: "20" },
      })

      if (response.ok) {
        const data = await response.json()
        setSharedChats(data.sharedChats)
      }
    } catch (error) {
      console.error("Failed to load shared chats:", error)
      toast({
        title: "Error",
        description: "Failed to load shared chats.",
        variant: "destructive",
      })
    } finally {
      setLoadingShares(false)
    }
  }

  const handleDelete = async (token: string) => {
    try {
      const response = await api.chat.share.delete.$delete({
        json: { shareToken: token },
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: "Shared chat deleted successfully.",
        })
        // Reload shared chats
        loadSharedChats()
        // If this was the current share, clear it
        if (existingShare?.shareToken === token) {
          setExistingShare(null)
          setShareLink("")
        }
      }
    } catch (error) {
      console.error("Failed to delete shared chat:", error)
      toast({
        title: "Error",
        description: "Failed to delete shared chat.",
        variant: "destructive",
      })
    }
    setDeleteToken(null)
  }

  if (showManageShares) {
    return (
      <>
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="sm:max-w-[700px] max-h-[80vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>Manage Shared Chats</DialogTitle>
              <DialogDescription>
                View and manage all your shared chat links.
              </DialogDescription>
            </DialogHeader>

            <div className="flex-1 overflow-y-auto">
              {loadingShares ? (
                <div className="text-center py-4">Loading...</div>
              ) : sharedChats.length === 0 ? (
                <div className="text-center py-4 text-gray-500">
                  No shared chats yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs font-medium text-gray-600 dark:text-gray-400">
                        <th className="pb-1 pr-4">Title</th>
                        <th className="pb-1 pr-4">Shared Link</th>
                        <th className="pb-1 pr-4">Date Shared</th>
                        <th className="pb-1 text-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sharedChats.map((share) => {
                        const shareUrl = `${window.location.origin}/chat?shareToken=${share.shareToken}`
                        return (
                          <tr
                            key={share.shareToken}
                            className="border-b hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors group"
                          >
                            <td className="py-1 pr-4">
                              <div className="max-w-[200px]">
                                <span
                                  className="text-sm text-gray-800 dark:text-gray-200 block truncate"
                                  title={share.title || "Untitled Chat"}
                                >
                                  {share.title || "Untitled Chat"}
                                </span>
                              </div>
                            </td>
                            <td className="py-1 pr-4">
                              <div className="flex items-center gap-2">
                                <a
                                  href={shareUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 dark:text-blue-400 hover:underline font-medium text-sm"
                                >
                                  {`.../${share.shareToken}`}
                                </a>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 p-0"
                                  onClick={async (e) => {
                                    e.stopPropagation()
                                    await navigator.clipboard.writeText(
                                      shareUrl,
                                    )
                                    toast({
                                      title: "Copied!",
                                      description:
                                        "Share link copied to clipboard.",
                                    })
                                  }}
                                  title="Copy link"
                                >
                                  <Copy className="h-3 w-3" />
                                </Button>
                              </div>
                            </td>
                            <td className="py-1 pr-4 text-xs text-gray-600 dark:text-gray-400">
                              {new Date(share.createdAt).toLocaleDateString(
                                "en-US",
                                {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                },
                              )}
                            </td>
                            <td className="py-1 text-center">
                              <div className="flex items-center justify-center gap-1">
                                <div className="relative group/icon">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0"
                                    onClick={() => {
                                      window.open(
                                        `/chat/${share.chatExternalId}`,
                                        "_blank",
                                      )
                                    }}
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </Button>
                                  <span className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-gray-900 text-white text-xs px-2 py-1 rounded opacity-0 group-hover/icon:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                                    Open source chat
                                  </span>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 p-0"
                                  onClick={() =>
                                    setDeleteToken(share.shareToken)
                                  }
                                  title="Delete share"
                                >
                                  <Trash2 className="h-3 w-3 text-red-500" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="flex justify-between pt-2 border-t">
              <Button
                variant="outline"
                onClick={() => {
                  setShowManageShares(false)
                  loadSharedChats() // Refresh when going back
                }}
              >
                Back
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={!!deleteToken} onOpenChange={() => setDeleteToken(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete shared chat?</DialogTitle>
              <DialogDescription>
                This will permanently delete the share link. The original chat
                will not be affected.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2 mt-2">
              <Button variant="outline" onClick={() => setDeleteToken(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => deleteToken && handleDelete(deleteToken)}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[525px]">
        <DialogHeader>
          <DialogTitle>Share Chat</DialogTitle>
          <DialogDescription>
            {existingShare
              ? "This chat is already shared. You can update the link or manage your shared chats."
              : "Share this conversation. Anyone with the link can view it."}
          </DialogDescription>
        </DialogHeader>

        {existingShare ? (
          <>
            <div className="flex items-center space-x-2 mt-2">
              <Input readOnly value={shareLink} className="flex-1" />
              <Button
                onClick={async () => {
                  await navigator.clipboard.writeText(shareLink)
                  toast({
                    title: "Copied!",
                    description: "Share link copied to clipboard.",
                  })
                }}
                variant="outline"
                size="sm"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-2 space-y-1">
              <Button
                onClick={handleShare}
                className="w-full"
                disabled={isSharing}
              >
                {isSharing ? "Updating..." : "Update Link"}
              </Button>
              <p className="text-sm text-gray-500 text-center">
                This will create a new link with the latest messages
              </p>
            </div>
          </>
        ) : (
          <div className="mt-2">
            <Button
              onClick={handleShare}
              className="w-full"
              disabled={isSharing || !chatId}
            >
              {isSharing ? "Creating link..." : "Create Share Link"}
            </Button>
          </div>
        )}

        <div className="mt-2 pt-2 border-t">
          <Button
            variant="link"
            className="w-full"
            onClick={() => {
              setShowManageShares(true)
              loadSharedChats()
            }}
          >
            Manage Links
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
