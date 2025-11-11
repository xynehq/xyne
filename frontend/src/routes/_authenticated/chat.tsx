import MarkdownPreview from "@uiw/react-markdown-preview"
import DOMPurify from "dompurify"
import { api } from "@/api"
import { Sidebar } from "@/components/Sidebar"
import {
  createFileRoute,
  useLoaderData,
  useRouter,
  useRouterState,
  useSearch,
} from "@tanstack/react-router"
import {
  Bookmark,
  Copy,
  Ellipsis,
  Pencil,
  X,
  ChevronDown,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  Share2,
  ArrowDown,
} from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  Fragment,
  useCallback,
  useMemo,
} from "react"
import {
  TransformWrapper,
  TransformComponent,
  useControls,
} from "react-zoom-pan-pinch"
import { useTheme } from "@/components/ThemeContext"
import { Pill } from "@/components/Pill"
import { MermaidCodeWrapper } from "@/hooks/useMermaidRenderer"

import {
  SelectPublicMessage,
  Citation,
  ImageCitation,
  MessageFeedback,
  AttachmentMetadata,
  attachmentMetadataSchema,
  // Apps,
  // DriveEntity,
} from "shared/types"
import logo from "@/assets/logo.svg"
import Expand from "@/assets/expand.svg"
import Retry from "@/assets/retry.svg"
import { PublicUser, PublicWorkspace } from "shared/types"
import { z } from "zod"
import { getIcon } from "@/lib/common"
import { FeedbackModal } from "@/components/feedback/FeedbackModal"
import { getName } from "@/components/GroupFilter"
import {
  useQueryClient,
  useMutation,
  useInfiniteQuery,
  InfiniteData,
} from "@tanstack/react-query"
import { SelectPublicChat } from "shared/types"
import {
  fetchChats,
  pageSize,
  renameChat,
  bookmarkChat,
} from "@/components/HistoryModal"
import { errorComponent } from "@/components/error"
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { EnhancedReasoning } from "@/components/EnhancedReasoning"
import { DeepResearchReasoning } from "@/components/DeepResearchReasoning"
import { Tip } from "@/components/Tooltip"
import { FollowUpQuestions } from "@/components/FollowUpQuestions"
import { RagTraceVirtualization } from "@/components/RagTraceVirtualization"
import { toast } from "@/hooks/use-toast"
import { ToastAction } from "@/components/ui/toast"
import { ChatBox, ChatBoxRef } from "@/components/ChatBox"
import React from "react"
// import { jsonToHtmlMessage } from "@/lib/messageUtils"
import { CLASS_NAMES } from "@/lib/constants"
import { Reference, ToolsListItem, toolsListItemSchema } from "@/types"
import { useChatStream } from "@/hooks/useChatStream"
import { useChatHistory } from "@/hooks/useChatHistory"
import { parseHighlight } from "@/components/Highlight"
import { ShareModal } from "@/components/ShareModal"
import { AttachmentGallery } from "@/components/AttachmentGallery"
import { useVirtualizer } from "@tanstack/react-virtual"
import { renderToStaticMarkup } from "react-dom/server"
import CitationPreview from "@/components/CitationPreview"
import { createCitationLink } from "@/components/CitationLink"
import { createPortal } from "react-dom"
import {
  cleanCitationsFromResponse,
  processMessage,
  createTableComponents,
} from "@/utils/chatUtils.tsx"
import {
  useDocumentOperations,
  DocumentOperationsProvider,
} from "@/contexts/DocumentOperationsContext"

export const THINKING_PLACEHOLDER = "Thinking"

// Mapping from source ID to app/entity object
// const sourceIdToAppEntityMap: Record<string, { app: string; entity?: string }> =
//   {
//     googledrive: { app: Apps.GoogleDrive, entity: "file" },
//     googledocs: { app: Apps.GoogleDrive, entity: DriveEntity.Docs },
//     slack: { app: Apps.Slack, entity: "message" },
//     gmail: { app: Apps.Gmail, entity: "mail" }, // Assuming MailEntity.Email maps to "mail"
//     googlecalendar: { app: Apps.GoogleCalendar, entity: "event" },
//     pdf: { app: "pdf", entity: "pdf_default" }, // Assuming DriveEntity.PDF maps to "pdf_default"
//     event: { app: "event", entity: "event_default" },
//   }

interface ChatPageProps {
  user: PublicUser
  workspace: PublicWorkspace
  agentWhiteList: boolean
}

// Define the structure for parsed message parts, including app, entity, and pillType for pills
export type ParsedMessagePart =
  | { type: "text"; value: string }
  | {
      type: "pill"
      value: {
        docId: string
        url: string | null
        title: string | null
        app?: string
        entity?: string
        pillType?: "citation" | "global"
        imgSrc?: string | null
      }
    }
  | { type: "link"; value: string }

// Helper function to convert JSON message parts back to HTML using Pill component
export const jsonToHtmlMessage = (jsonString: string): string => {
  try {
    const parts = JSON.parse(jsonString) as Array<ParsedMessagePart>
    if (!Array.isArray(parts)) {
      // If not our specific JSON structure, treat as plain HTML/text string
      return jsonString
    }

    return parts
      .map((part, index) => {
        let htmlPart = ""
        if (part.type === "text") {
          htmlPart = part.value
        } else if (
          part.type === "pill" &&
          part.value &&
          typeof part.value === "object"
        ) {
          const { docId, url, title, app, entity, pillType, imgSrc } =
            part.value

          const referenceForPill: Reference = {
            id: docId,
            docId: docId,
            title: title || docId,
            url: url || undefined,
            app: app,
            entity: entity,
            type: pillType || "global",
            // Include imgSrc if available, mapping it to photoLink for the Reference type.
            // The Pill component will need to be able to utilize this.
            ...(imgSrc && { photoLink: imgSrc }),
          }
          htmlPart = renderToStaticMarkup(
            React.createElement(Pill, { newRef: referenceForPill }),
          )
        } else if (part.type === "link" && typeof part.value === "string") {
          const url = part.value
          // Create a simple anchor tag string for links
          // Ensure it has similar styling to how it's created in ChatBox
          // The text of the link will be the URL itself
          htmlPart = `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-blue-400 underline hover:text-blue-800 dark:hover:text-blue-300 cursor-pointer">${url}</a>`
        }
        // Add a space only if the part is not the last one, or if the next part is text.
        // This avoids trailing spaces or double spaces between elements.
        if (htmlPart.length > 0 && index < parts.length - 1) {
          // Add space if current part is not empty and it's not the last part.
          // More sophisticated logic might be needed if consecutive non-text elements occur.
          htmlPart += " "
        }
        return htmlPart
      })
      .join("")
      .trimEnd()
  } catch (error) {
    return jsonString
  }
}

const AGENTIC_STATE = "agenticState"
export const ChatPage = ({
  user,
  workspace,
  agentWhiteList,
}: ChatPageProps) => {
  const { theme } = useTheme()
  const params = Route.useParams()
  const router = useRouter()
  const chatParams: XyneChat = useSearch({
    from: "/_authenticated/chat",
  })
  const isGlobalDebugMode = import.meta.env.VITE_SHOW_DEBUG_INFO === "true"
  const isDebugMode = isGlobalDebugMode || chatParams.debug
  const [isAgenticMode, setIsAgenticMode] = useState(
    Boolean(chatParams.agentic),
  )
  const isWithChatId = !!(params as any).chatId
  const isSharedChat = !!chatParams.shareToken
  const [sharedChatData, setSharedChatData] = useState<any>(null)
  const [sharedChatLoading, setSharedChatLoading] = useState(false)
  const [sharedChatError, setSharedChatError] = useState<string | null>(null)
  const { documentOperationsRef } = useDocumentOperations()

  const data = useLoaderData({
    from: isWithChatId
      ? "/_authenticated/chat/$chatId"
      : "/_authenticated/chat",
  })
  const queryClient = useQueryClient()

  if (chatParams.q && isWithChatId) {
    router.navigate({
      to: "/chat/$chatId",
      params: { chatId: (params as any).chatId },
      search: {
        ...(!isGlobalDebugMode && isDebugMode ? { debug: true } : {}),
        ...(isAgenticMode ? { agentic: true } : {}),
      },
    })
  }
  const hasHandledQueryParam = useRef(false)

  const [query, setQuery] = useState("")
  const chatId = (params as any).chatId || null

  // Add retryIsStreaming state
  const [retryIsStreaming, setRetryIsStreaming] = useState(false)

  // Use custom hooks for streaming and history
  const { data: historyData, isLoading: historyLoading } =
    useChatHistory(chatId)
  const {
    partial,
    thinking,
    deepResearchSteps,
    sources,
    imageCitations,
    citationMap,
    isStreaming,
    messageId: streamInfoMessageId,
    startStream,
    stopStream,
    retryMessage,
    displayPartial,
    clarificationRequest,
    waitingForClarification,
    provideClarification,
  } = useChatStream(
    chatId,
    (title: string) => setChatTitle(title),
    setRetryIsStreaming,
  )

  // Use shared chat data if available, otherwise use history or loader data
  const messages =
    isSharedChat && sharedChatData
      ? sharedChatData.messages || []
      : historyData?.messages || (isWithChatId ? data?.messages || [] : [])

  const [chatTitle, setChatTitle] = useState<string | null>(
    isWithChatId && data ? data?.chat?.title || null : null,
  )
  const [isTitleUpdating, setIsTitleUpdating] = useState(false)
  const [streamingTitle, setStreamingTitle] = useState<string>("")

  // Smooth title streaming function - animates from left to right
  const updateTitleWithAnimation = useCallback((newTitle: string) => {
    setChatTitle((prevTitle) => {
      return newTitle
    })
    setIsTitleUpdating(true)
    setStreamingTitle("")

    const chars = newTitle.split("")
    let currentIndex = 0

    const streamInterval = setInterval(() => {
      if (currentIndex < chars.length) {
        setStreamingTitle((prev) => prev + chars[currentIndex])
        currentIndex++
      } else {
        clearInterval(streamInterval)
        setIsTitleUpdating(false)
        setStreamingTitle("")
      }
    }, 50) // 50ms per character for smooth streaming effect
  }, [])

  // Create a current streaming response for compatibility with existing UI,
  // merging the real stream IDs once available
  // IMPORTANT: Keep currentResp when waiting for clarification, even if not actively streaming
  const currentResp =
    isStreaming || waitingForClarification
      ? {
          resp: displayPartial ?? partial,
          thinking,
          deepResearchSteps,
          sources,
          imageCitations,
          citationMap,
          messageId: streamInfoMessageId,
          chatId,
          clarificationRequest,
          waitingForClarification,
        }
      : null

  const [showRagTrace, setShowRagTrace] = useState(false)
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    null,
  )
  const [bookmark, setBookmark] = useState<boolean>(
    isWithChatId ? !!data?.chat?.isBookmarked || false : false,
  )
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const chatBoxRef = useRef<ChatBoxRef>(null)
  const [userHasScrolled, setUserHasScrolled] = useState(false)
  const isAutoScrollingRef = useRef(false)
  const [dots, setDots] = useState("")
  const [bottomSpace, setBottomSpace] = useState(0)
  const [showSources, setShowSources] = useState(false)
  const [currentCitations, setCurrentCitations] = useState<Citation[]>([])
  const [currentMessageId, setCurrentMessageId] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState<boolean>(false)
  const [editedTitle, setEditedTitle] = useState<string | null>(chatTitle)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const [allCitations, setAllCitations] = useState<Map<string, Citation>>(
    new Map(),
  ) // State for all citations
  // const eventSourceRef = useRef<EventSource | null>(null) // Added ref for EventSource
  // const [userStopped, setUserStopped] = useState<boolean>(false) // Add state for user stop
  const [feedbackMap, setFeedbackMap] = useState<
    Record<string, MessageFeedback | null>
  >({})
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false)
  const [pendingFeedback, setPendingFeedback] = useState<{
    messageId: string
    type: MessageFeedback
  } | null>(null)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [lastUserMessageIndex, setLastUserMessageIndex] = useState(-1)

  useEffect(() => {
    if ((isStreaming || retryIsStreaming) && messages.length > 0) {
      // Find the index of the last user message
      let latestUserIndex = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].messageRole === "user") {
          latestUserIndex = i
          break
        }
      }

      if (latestUserIndex !== -1 && latestUserIndex !== lastUserMessageIndex) {
        setLastUserMessageIndex(latestUserIndex)

        // Smooth scroll to position the user's query at the top for a fresh start feeling
        setTimeout(() => {
          const container = messagesContainerRef.current
          if (container) {
            // Find the user message element
            const userMessageElement = container.querySelector(
              `[data-index="${latestUserIndex}"]`,
            )
            if (userMessageElement) {
              // Calculate scroll position to put the user message near the top with some padding
              const elementRect = userMessageElement.getBoundingClientRect()
              const containerRect = container.getBoundingClientRect()
              const currentScrollTop = container.scrollTop

              // Position to scroll to (put user message ~100px from top for comfortable viewing)
              const targetScrollTop =
                currentScrollTop + elementRect.top - containerRect.top - 100

              // Smooth scroll to the calculated position
              container.scrollTo({
                top: Math.max(0, targetScrollTop),
                behavior: "smooth",
              })
            }
          }
        }, 100)
      }
    }
  }, [isStreaming, retryIsStreaming, messages.length, lastUserMessageIndex])

  // Add state for citation preview
  const [isCitationPreviewOpen, setIsCitationPreviewOpen] = useState(false)
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(
    null,
  )
  const [selectedChunkIndex, setSelectedChunkIndex] = useState<number | null>(
    null,
  )
  const [cameFromSources, setCameFromSources] = useState(false)
  const [isDocumentLoaded, setIsDocumentLoaded] = useState(false)

  // Compute disableRetry flag for retry buttons
  const disableRetry = isStreaming || retryIsStreaming || isSharedChat

  // Effect to fetch shared chat data when shareToken is present
  useEffect(() => {
    if (chatParams.shareToken) {
      setSharedChatLoading(true)
      setSharedChatError(null)

      api.chat.share
        .$get({
          query: { token: chatParams.shareToken },
        })
        .then(async (response: Response) => {
          if (response.ok) {
            const data = await response.json()
            setSharedChatData(data)
            setChatTitle(data.chat.title)
          } else {
            setSharedChatError(
              "This shared chat link is invalid or has been deactivated.",
            )
          }
        })
        .catch(() => {
          setSharedChatError("Failed to load shared chat. Please try again.")
        })
        .finally(() => {
          setSharedChatLoading(false)
        })
    }
  }, [chatParams.shareToken])

  useEffect(() => {
    localStorage.setItem(AGENTIC_STATE, JSON.stringify(isAgenticMode))
  }, [isAgenticMode])
  const renameChatMutation = useMutation<
    { chatId: string; title: string },
    Error,
    { chatId: string; newTitle: string }
  >({
    mutationFn: async ({ chatId, newTitle }) => {
      return await renameChat(chatId, newTitle)
    },
    onSuccess: ({ chatId, title }) => {
      queryClient.setQueryData<InfiniteData<SelectPublicChat[]>>(
        ["all-chats"],
        (oldData) => {
          if (!oldData) return oldData

          let chatToUpdate: SelectPublicChat | undefined
          oldData.pages.forEach((page) => {
            const found = page.find((c) => c.externalId === chatId)
            if (found) chatToUpdate = found
          })

          if (!chatToUpdate) {
            return oldData
          }

          const updatedChat = { ...chatToUpdate, title }

          const filteredPages = oldData.pages.map((page) =>
            page.filter((c) => c.externalId !== chatId),
          )

          const newPages = [
            [updatedChat, ...filteredPages[0]],
            ...filteredPages.slice(1),
          ]

          return {
            ...oldData,
            pages: newPages,
          }
        },
      )
      setChatTitle(editedTitle)
      setIsEditing(false)
    },
    onError: (error: Error) => {
      setIsEditing(false)
      console.error("Failed to rename chat:", error)
    },
  })

  // Effect to aggregate citations from messages
  useEffect(() => {
    const newCitations = new Map(allCitations)
    let changed = false
    messages.forEach((msg: SelectPublicMessage) => {
      if (msg.messageRole === "assistant" && msg.sources) {
        // Add explicit type for citation
        msg.sources.forEach((citation: Citation) => {
          // Use URL as unique key, ensure title exists for display
          if (
            citation.url &&
            citation.title &&
            !newCitations?.has(citation?.docId)
          ) {
            newCitations.set(citation?.docId, citation)
            changed = true
          }
        })
      }
    })
    // Only update state if the map actually changed
    if (changed) {
      setAllCitations(newCitations)
    }
  }, [messages, allCitations]) // Dependency array includes allCitations

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

  const { data: historyItems } = useInfiniteQuery<
    SelectPublicChat[],
    Error,
    InfiniteData<SelectPublicChat[]>,
    ["all-chats"],
    number
  >({
    queryKey: ["all-chats"],
    queryFn: ({ pageParam = 0 }) => fetchChats({ pageParam }),
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage?.length < pageSize) {
        return undefined
      }
      return allPages?.length
    },
    initialPageParam: 0,
  })
  const currentChat = historyItems?.pages
    ?.flat()
    .find((item) => item.externalId === chatId)

  useEffect(() => {
    if (!isEditing && currentChat?.title && currentChat.title !== chatTitle) {
      setChatTitle(currentChat.title)
      setEditedTitle(currentChat.title)
    }
  }, [currentChat?.title, isEditing, chatTitle])

  useEffect(() => {
    if (
      currentChat &&
      typeof currentChat.isBookmarked === "boolean" &&
      currentChat.isBookmarked !== bookmark
    ) {
      setBookmark(currentChat.isBookmarked)
    }
  }, [currentChat, bookmark])

  useEffect(() => {
    if (isStreaming || retryIsStreaming) {
      const interval = setInterval(() => {
        setDots((prev) => {
          if (prev.length >= 3) {
            return ""
          } else {
            return prev + "."
          }
        })
      }, 500)

      return () => clearInterval(interval)
    } else {
      setDots("")
    }
  }, [isStreaming, retryIsStreaming])

  // Cleanup effect to clear failed messages from cache when chatId changes
  useEffect(() => {
    // Clear any cached data for null chatId when we have a real chatId
    // This prevents old failed messages from appearing in new chats
    if (chatId && chatId !== null) {
      queryClient.removeQueries({ queryKey: ["chatHistory", null] })
    }
  }, [chatId, queryClient])

  // Helper function to extract feedback type from either JSON or legacy format
  const extractFeedbackType = (feedback: any): MessageFeedback | null => {
    if (!feedback) return null

    // Handle new JSON format
    if (typeof feedback === "object" && feedback.type) {
      return feedback.type as MessageFeedback
    }

    // Handle legacy string format
    if (typeof feedback === "string") {
      return feedback as MessageFeedback
    }

    return null
  }

  // Handle initial data loading and feedbackMap initialization
  useEffect(() => {
    if (!hasHandledQueryParam.current || isWithChatId) {
      // Data will be loaded via useChatHistory hook
    }
    if (!chatTitle) {
      setChatTitle(isWithChatId ? data?.chat?.title || null : null)
    }

    setBookmark(isWithChatId ? !!data?.chat?.isBookmarked || false : false)

    // Populate feedbackMap from loaded messages
    if (data?.messages) {
      const initialFeedbackMap: Record<string, MessageFeedback | null> = {}
      data.messages.forEach((msg: SelectPublicMessage) => {
        if (msg.externalId && msg.feedback !== undefined) {
          initialFeedbackMap[msg.externalId] = extractFeedbackType(msg.feedback)
        }
      })
      setFeedbackMap(initialFeedbackMap)
    }

    inputRef.current?.focus()
    setShowSources(false)
    setCurrentCitations([])
    setCurrentMessageId(null)

    // Reset bottom space and message count for new chats
    if (!isWithChatId || (messages && messages.length === 0)) {
      setBottomSpace(0)
      setLastUserMessageCount(0)
    }
  }, [
    data?.chat?.isBookmarked,
    data?.chat?.title,
    data?.messages,
    isWithChatId,
    params,
  ])

  useEffect(() => {
    if (chatParams.q && !hasHandledQueryParam.current) {
      const messageToSend = decodeURIComponent(chatParams.q)

      let sourcesArray: string[] = []
      const _sources = chatParams.sources as string | string[] | undefined

      if (Array.isArray(_sources)) {
        sourcesArray = _sources.filter((s) => typeof s === "string")
      } else if (typeof _sources === "string") {
        sourcesArray = _sources
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      }

      // Call handleSend, passing agentId from chatParams if available
      handleSend(
        messageToSend,
        chatParams.metadata,
        sourcesArray,
        chatParams.agentId,
        chatParams.toolsList,
        chatParams.selectedModel, // Use selectedModel from URL params
        false, // isFollowup = false for initial query
      )
      hasHandledQueryParam.current = true
      router.navigate({
        to: "/chat",
        search: (prev) => ({
          ...prev,
          q: undefined,
          sources: undefined,
          agentId: undefined, // Clear agentId from URL after processing
          toolsList: undefined, // Clear toolsList from URL after processing
          metadata: undefined, // Clear metadata from URL after processing
        }),
        replace: true,
      })
    }
  }, [
    chatParams.q,
    chatParams.sources,
    chatParams.agentId,
    chatParams.toolsList,
    chatParams.metadata,
    router,
  ])

  // Background title update for new chats
  useEffect(() => {
    const shouldUpdateTitle =
      chatId &&
      chatTitle === "Untitled" &&
      !isStreaming &&
      messages.length >= 2 &&
      messages[0]?.messageRole === "user"

    if (shouldUpdateTitle && !isSharedChat) {
      // Update title in background using the first user message
      api.chat.generateTitle
        .$post({
          json: {
            chatId: chatId,
            message: messages[0].message,
          },
        })
        .then(async (response: Response) => {
          if (response.ok) {
            const result = (await response.json()) as {
              success: boolean
              title: string
            }
            if (result.success) {
              updateTitleWithAnimation(result.title)
              // Update cached chat data
              queryClient.setQueryData<any>(
                ["chatHistory", chatId],
                (old: any) => {
                  if (old?.chat) {
                    return {
                      ...old,
                      chat: {
                        ...old.chat,
                        title: result.title,
                      },
                    }
                  }
                  return old
                },
              )
            }
          }
        })
        .catch((error: Error) => {
          console.error("Background title update failed:", error)
          // Fail silently - this is a background operation
        })
    }
  }, [chatId, isStreaming, isSharedChat, queryClient])

  const [streamingStarted, setStreamingStarted] = useState(false)
  const [lastUserMessageCount, setLastUserMessageCount] = useState(0)
  const [initialBottomSpace, setInitialBottomSpace] = useState(0)

  // Detect when streaming starts for a new query and calculate exact space needed
  useEffect(() => {
    const currentUserMessageCount = messages.filter(
      (msg: any) => msg.messageRole === "user",
    ).length

    if (
      (isStreaming || retryIsStreaming) &&
      !streamingStarted &&
      currentUserMessageCount > lastUserMessageCount
    ) {
      // This is a new query starting (not just continuing to stream)
      setStreamingStarted(true)
      setLastUserMessageCount(currentUserMessageCount)

      // Calculate exact space needed ONLY when a new query starts
      setTimeout(() => {
        const container = messagesContainerRef.current
        if (!container) return

        // Get viewport height and calculate optimal space
        const containerHeight = container.clientHeight

        // Calculate space to push previous content out of view with optimal balance
        let spaceNeeded: number
        if (containerHeight <= 600) {
          // Small screens: balanced space
          spaceNeeded = Math.max(300, containerHeight * 0.65)
        } else if (containerHeight <= 900) {
          // Medium screens: good separation without excess
          spaceNeeded = Math.max(400, containerHeight * 0.78)
        } else {
          // Large screens: sufficient space but not excessive
          spaceNeeded = Math.max(800, Math.min(containerHeight * 1, 980))
        }

        setBottomSpace(spaceNeeded)
        setInitialBottomSpace(spaceNeeded)

        // Position the latest user message at the top with precise scroll positioning
        setTimeout(() => {
          const userMessageElements = container.querySelectorAll(
            '[data-message-role="user"]',
          )
          if (userMessageElements.length > 0) {
            const lastUserMessage = userMessageElements[
              userMessageElements.length - 1
            ] as HTMLElement

            // Calculate the exact scroll position to place the message at the top
            const containerRect = container.getBoundingClientRect()
            const messageRect = lastUserMessage.getBoundingClientRect()
            const messageOffsetTop =
              messageRect.top - containerRect.top + container.scrollTop

            // Scroll to position the message at the top with a small margin
            container.scrollTo({
              top: Math.max(0, messageOffsetTop - 20), // 20px margin from top
              behavior: "smooth",
            })
          }
        }, 50)
      }, 100)
    } else if (!isStreaming && !retryIsStreaming && streamingStarted) {
      // Reset streaming started flag when streaming completes
      // DO NOT reset bottomSpace here - it should persist
      setStreamingStarted(false)
    }
  }, [
    isStreaming,
    retryIsStreaming,
    streamingStarted,
    messages,
    lastUserMessageCount,
  ])

  // Shared function to adjust bottom space based on content height
  // Calculates total height of last assistant message (including action buttons, sources, follow-ups)
  // and adjusts the spacer to prevent unnecessary extra space
  const adjustBottomSpaceForContent = useCallback(
    (forceUpdate = false) => {
      if (initialBottomSpace === 0) return

      const container = messagesContainerRef.current
      if (!container) return

      const assistantMessageWrappers = container.querySelectorAll(
        '[data-message-role="assistant"]',
      )
      if (assistantMessageWrappers.length === 0) return

      const lastMessageWrapper = assistantMessageWrappers[
        assistantMessageWrappers.length - 1
      ] as HTMLElement
      if (!lastMessageWrapper) return

      const totalHeight = lastMessageWrapper.offsetHeight
      const newBottomSpace = Math.max(50, initialBottomSpace - totalHeight)

      // During streaming, only update if there's a significant change (>10px) to avoid jitter
      // After streaming, always update to ensure accurate spacing
      setBottomSpace((prevBottomSpace) => {
        if (forceUpdate || Math.abs(prevBottomSpace - newBottomSpace) > 10) {
          return newBottomSpace
        }
        return prevBottomSpace
      })
    },
    [initialBottomSpace],
  )

  // Adjust bottom space during streaming as content grows
  useEffect(() => {
    if (!streamingStarted || (!isStreaming && !retryIsStreaming)) return
    if (initialBottomSpace === 0) return

    const observer = new ResizeObserver(() => adjustBottomSpaceForContent())
    const interval = setInterval(() => adjustBottomSpaceForContent(), 100)

    const container = messagesContainerRef.current
    if (container) observer.observe(container)

    return () => {
      observer.disconnect()
      clearInterval(interval)
    }
  }, [
    streamingStarted,
    isStreaming,
    retryIsStreaming,
    initialBottomSpace,
    adjustBottomSpaceForContent,
    partial,
    currentResp,
  ])

  // Adjust bottom space after streaming ends for action buttons, sources, and follow-ups
  useEffect(() => {
    if (isStreaming || retryIsStreaming || initialBottomSpace === 0) return

    const observer = new ResizeObserver(() => adjustBottomSpaceForContent(true))

    const container = messagesContainerRef.current
    if (container) observer.observe(container)

    // Timed adjustments to catch elements as they appear:
    // 50ms: action buttons, 200ms: sources, 400ms: follow-up loading, 600ms: safety check
    const timeouts = [50, 200, 400, 600].map((delay) =>
      setTimeout(() => adjustBottomSpaceForContent(true), delay),
    )

    return () => {
      observer.disconnect()
      timeouts.forEach(clearTimeout)
    }
  }, [
    isStreaming,
    retryIsStreaming,
    initialBottomSpace,
    messages,
    adjustBottomSpaceForContent,
  ])

  // Callback for when follow-up questions finish generating
  const handleFollowUpQuestionsLoaded = useCallback(() => {
    setTimeout(() => adjustBottomSpaceForContent(true), 150)
  }, [adjustBottomSpaceForContent])

  const handleSend = async (
    messageToSend: string,
    metadata?: AttachmentMetadata[],
    selectedSources?: string[],
    agentIdFromChatBox?: string | null,
    toolsList?: ToolsListItem[],
    selectedModel?: string,
    isFollowUp?: boolean,
  ) => {
    if (!messageToSend || isStreaming || retryIsStreaming) return

    setUserHasScrolled(false)
    setQuery("")

    // Add user message optimistically to React Query cache
    const queryKey = chatId

    queryClient.setQueryData<any>(["chatHistory", queryKey], (oldData: any) => {
      if (!oldData) {
        return { messages: [{ messageRole: "user", message: messageToSend }] }
      }
      return {
        ...oldData,
        messages: [
          ...(oldData.messages || []),
          { messageRole: "user", message: messageToSend },
        ],
      }
    })

    // Use agentIdFromChatBox if provided, otherwise fallback to chatParams.agentId (for initial load)
    const agentIdToUse = agentIdFromChatBox || chatParams.agentId

    try {
      await startStream(
        messageToSend,
        selectedSources || [],
        isAgenticMode,
        agentIdToUse,
        toolsList,
        metadata,
        selectedModel,
        isFollowUp,
      )
    } catch (error) {
      // If there's an error, clear the optimistically added message from cache
      // This prevents failed messages from persisting when creating new chats
      queryClient.setQueryData<any>(
        ["chatHistory", queryKey],
        (oldData: any) => {
          if (!oldData) return oldData
          return {
            ...oldData,
            messages:
              oldData.messages?.filter(
                (msg: any) => msg.message !== messageToSend,
              ) || [],
          }
        },
      )

      // Also clear any cached data for null chatId to prevent old failed messages from appearing
      if (!chatId) {
        queryClient.removeQueries({ queryKey: ["chatHistory", null] })
      }

      throw error // Re-throw the error so it can be handled by the calling code
    }
  }

  const handleFeedback = async (
    messageId: string,
    feedback: MessageFeedback,
  ) => {
    if (!messageId) return

    // Optimistically update the UI
    setFeedbackMap((prev) => ({
      ...prev,
      [messageId]: feedback,
    }))

    try {
      // Submit basic feedback immediately
      const response = await api.message.feedback.$post({
        json: {
          messageId,
          feedback,
        },
      })

      if (response.ok) {
        if (feedback === MessageFeedback.Like) {
          // For thumbs up, just show success toast
          toast({
            title: "Thank you!",
            description: "Your feedback has been recorded.",
            duration: 3000,
          })
        } else if (feedback === MessageFeedback.Dislike) {
          // For thumbs down, directly show detailed feedback toast
          toast({
            title: "Help us improve",
            description: "Would you like to provide more detailed feedback?",
            duration: 3000,
            action: (
              <ToastAction
                altText="Provide detailed feedback"
                onClick={() => {
                  setPendingFeedback({ messageId, type: feedback })
                  setFeedbackModalOpen(true)
                }}
              >
                Yes
              </ToastAction>
            ),
          })
        }
      } else {
        throw new Error("Failed to submit feedback")
      }
    } catch (error) {
      console.error("Failed to submit feedback:", error)
      // Revert optimistic update on error
      setFeedbackMap((prev) => {
        const newMap = { ...prev }
        delete newMap[messageId]
        return newMap
      })
      toast({
        title: "Error",
        description: "Failed to submit feedback. Please try again.",
        variant: "destructive",
        duration: 3000,
      })
    }
  }

  const handleEnhancedFeedbackSubmit = async (data: {
    type: MessageFeedback
    customFeedback?: string
    selectedOptions?: string[]
    shareChat?: boolean
  }) => {
    if (!pendingFeedback) return

    const { messageId } = pendingFeedback

    // Optimistically update the UI
    setFeedbackMap((prev) => ({
      ...prev,
      [messageId]: data.type,
    }))

    try {
      const response = await api.message.feedback.enhanced.$post({
        json: {
          messageId,
          type: data.type,
          customFeedback: data.customFeedback,
          selectedOptions: data.selectedOptions,
          shareChat: data.shareChat,
        },
      })

      const result = await response.json()

      let successMessage = "Feedback submitted."
      if (data.shareChat && result.shareToken) {
        successMessage += " Chat has been shared for improvement purposes."
      } else if (data.shareChat && !result.shareToken) {
        successMessage +=
          " Feedback submitted, but share token generation failed."
      }

      toast({ title: "Success", description: successMessage, duration: 2000 })
    } catch (error) {
      console.error("Failed to submit enhanced feedback", error)
      // Revert optimistic update on error
      setFeedbackMap((prev) => {
        const newMap = { ...prev }
        delete newMap[messageId]
        return newMap
      })
      toast({
        title: "Error",
        description: "Failed to submit feedback. Please try again.",
        variant: "destructive",
      })
    } finally {
      setPendingFeedback(null)
      setFeedbackModalOpen(false)
    }
  }

  const handleRetry = async (messageId: string) => {
    if (!messageId || isStreaming) return
    setRetryIsStreaming(true)

    // Get current model configuration from ChatBox
    const currentModelConfig =
      chatBoxRef.current?.getCurrentModelConfig() || null

    await retryMessage(messageId, isAgenticMode, undefined, currentModelConfig)
  }

  const bookmarkChatMutation = useMutation<
    { chatId: string; isBookmarked: boolean },
    Error,
    { chatId: string; isBookmarked: boolean }
  >({
    mutationFn: async ({ chatId, isBookmarked }) => {
      return await bookmarkChat(chatId, isBookmarked)
    },
    onMutate: async ({ isBookmarked }) => {
      setBookmark(isBookmarked)

      queryClient.setQueryData<InfiniteData<SelectPublicChat[]>>(
        ["all-chats"],
        (oldData) => {
          if (!oldData) return oldData
          return {
            ...oldData,
            pages: oldData.pages.map((page) =>
              page.map((chat) =>
                chat.externalId === chatId
                  ? { ...chat, isBookmarked: isBookmarked }
                  : chat,
              ),
            ),
          }
        },
      )
    },
    onSuccess: ({ isBookmarked }) => {
      setBookmark(isBookmarked)
      queryClient.invalidateQueries({ queryKey: ["all-chats"] })
      queryClient.invalidateQueries({ queryKey: ["favorite-chats"] })
    },
    onError: (error: Error, variables, context) => {
      setBookmark(!variables.isBookmarked)
      console.error("Failed to bookmark chat:", error)
    },
  })

  const handleBookmark = async () => {
    if (chatId) {
      bookmarkChatMutation.mutate({
        chatId: chatId,
        isBookmarked: !bookmark,
      })
    }
  }

  // Handle chunk index changes from CitationPreview
  const handleChunkIndexChange = useCallback(
    async (newChunkIndex: number | null, documentId: string, docId: string) => {
      if (!documentId) {
        console.error("handleChunkIndexChange called without documentId")
        return
      }

      if (selectedCitation?.itemId !== documentId) {
        return
      }

      if (newChunkIndex === null) {
        documentOperationsRef?.current?.clearHighlights?.()
        return
      }

      if (newChunkIndex !== null) {
        try {
          const chunkContentResponse = await api.chunk[":cId"].files[
            ":docId"
          ].content.$get({
            param: { cId: newChunkIndex.toString(), docId: docId },
          })

          if (!chunkContentResponse.ok) {
            console.error(
              "Failed to fetch chunk content:",
              chunkContentResponse.status,
            )
            toast({
              title: "Error",
              description: "Failed to load chunk content",
              variant: "destructive",
            })
            return
          }

          const chunkContent = await chunkContentResponse.json()

          // Ensure we are still on the same document before mutating UI
          if (selectedCitation?.itemId !== documentId) {
            return
          }

          if (chunkContent && chunkContent.chunkContent) {
            if (documentOperationsRef?.current?.clearHighlights) {
              documentOperationsRef.current.clearHighlights()
            }

            if (documentOperationsRef?.current?.highlightText) {
              try {
                await documentOperationsRef.current.highlightText(
                  chunkContent.chunkContent,
                  newChunkIndex,
                  chunkContent.pageIndex,
                  true,
                )
              } catch (error) {
                console.error(
                  "Error highlighting chunk text:",
                  chunkContent.chunkContent,
                  error,
                )
              }
            }
          }
        } catch (error) {
          console.error("Error in handleChunkIndexChange:", error)
          toast({
            title: "Error",
            description: "Failed to process chunk navigation",
            variant: "destructive",
          })
        }
      }
    },
    [selectedCitation, toast, documentOperationsRef],
  )

  useEffect(() => {
    if (selectedCitation && isDocumentLoaded) {
      handleChunkIndexChange(
        selectedChunkIndex,
        selectedCitation?.itemId ?? "",
        selectedCitation?.docId ?? "",
      )
    }
  }, [
    selectedChunkIndex,
    selectedCitation,
    isDocumentLoaded,
    handleChunkIndexChange,
  ])

  // Handler for citation clicks - moved before conditional returns
  const handleCitationClick = useCallback(
    (citation: Citation, chunkIndex?: number, fromSources: boolean = false) => {
      if (!citation || !citation.clId || !citation.itemId) {
        // For citations without clId or itemId, open as regular link
        if (citation.url) {
          window.open(citation.url, "_blank", "noopener,noreferrer")
        }
        return
      }
      setSelectedCitation(citation)
      setIsCitationPreviewOpen(true)
      setCameFromSources(fromSources)
      // Only close sources panel when opening citation preview, but preserve state for back navigation
      setShowSources(false)
      if (!fromSources) {
        // Clear sources state when coming from inline citations
        setCurrentCitations([])
        setCurrentMessageId(null)
      }
      // Handle chunk index change if provided
      setSelectedChunkIndex(null)
      setTimeout(() => {
        setSelectedChunkIndex(chunkIndex ?? null)
      }, 0)
    },
    [],
  )

  // Memoized callback for closing citation preview - moved before conditional returns
  const handleCloseCitationPreview = useCallback(() => {
    setIsCitationPreviewOpen(false)
    setSelectedCitation(null)
    setCameFromSources(false)
    setSelectedChunkIndex(null)
    setIsDocumentLoaded(false)
  }, [])

  // Callback for when document is loaded in CitationPreview
  const handleDocumentLoaded = useCallback(() => {
    setIsDocumentLoaded(true)
  }, [])

  useEffect(() => {
    setIsDocumentLoaded(false)
  }, [selectedCitation])

  useEffect(() => {
    setIsCitationPreviewOpen(false)
    setSelectedCitation(null)
    setCameFromSources(false)
    setSelectedChunkIndex(null)
    setIsDocumentLoaded(false)
  }, [chatId])

  // Handler for back to sources navigation
  const handleBackToSources = useCallback(() => {
    if (currentCitations.length > 0 && currentMessageId) {
      // Re-open the sources panel with the previous state
      setShowSources(true)
      setIsCitationPreviewOpen(false)
      setSelectedCitation(null)
      setCameFromSources(false)
      setSelectedChunkIndex(null)
    }
  }, [currentCitations, currentMessageId])

  const scrollToBottom = () => {
    const container = messagesContainerRef.current
    if (!container) return

    // Set flag to indicate we're auto-scrolling
    isAutoScrollingRef.current = true

    // Check if we need to scroll significantly
    const currentScrollTop = container.scrollTop
    const targetScrollTop = container.scrollHeight - container.clientHeight
    const scrollDistance = targetScrollTop - currentScrollTop

    // If already at bottom or close to it, just jump to bottom instantly
    if (Math.abs(scrollDistance) < 50) {
      container.scrollTop = targetScrollTop
      isAutoScrollingRef.current = false
      setUserHasScrolled(false)
      return
    }

    const startPosition = currentScrollTop
    const distance = scrollDistance
    const duration = Math.min(300, Math.max(150, Math.abs(distance) * 0.2))

    let startTime: number | null = null

    const animateScroll = (currentTime: number) => {
      if (startTime === null) startTime = currentTime
      const timeElapsed = currentTime - startTime
      const progress = Math.min(timeElapsed / duration, 1)

      // Easing function for smooth deceleration (ease-out-cubic)
      const easeOutCubic = 1 - Math.pow(1 - progress, 3)

      container.scrollTop = startPosition + distance * easeOutCubic

      if (progress < 1) {
        requestAnimationFrame(animateScroll)
      } else {
        // Animation complete, reset flag
        isAutoScrollingRef.current = false
      }
    }

    requestAnimationFrame(animateScroll)

    // Reset userHasScrolled since we're programmatically scrolling
    setUserHasScrolled(false)
  }

  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container || userHasScrolled || isAutoScrollingRef.current) return

    // Only auto-scroll if we're close to the bottom (within 100px)
    // This prevents the effect from interfering with manual scrolling
    const isNearBottom =
      container.scrollTop >=
      container.scrollHeight - container.clientHeight - 100

    if (isNearBottom) {
      // Only auto-scroll for non-streaming content to avoid interference during streaming
      if (!isStreaming && !retryIsStreaming) {
        // For non-streaming content, scroll instantly
        container.scrollTop = container.scrollHeight
      }
    }
  }, [messages, partial, userHasScrolled, isStreaming, retryIsStreaming]) // Added streaming states to dependencies

  if ((data?.error || historyLoading) && !isSharedChat) {
    return (
      <div className="h-full w-full flex flex-col bg-white">
        <Sidebar isAgentMode={agentWhiteList} />
        {/* <div className="ml-[120px]">Error: Could not get data</div> */}
      </div>
    )
  }

  // Handle shared chat loading state
  if (isSharedChat && sharedChatLoading) {
    return (
      <div className="h-full w-full flex flex-row bg-white dark:bg-[#1E1E1E]">
        <Sidebar
          photoLink={user?.photoLink ?? ""}
          role={user?.role}
          isAgentMode={agentWhiteList}
        />
        <div className="h-full w-full flex items-center justify-center">
          <div className="text-lg">Loading shared chat...</div>
        </div>
      </div>
    )
  }

  // Handle shared chat error state
  if (isSharedChat && (sharedChatError || !sharedChatData)) {
    return (
      <div className="h-full w-full flex flex-row bg-white dark:bg-[#1E1E1E]">
        <Sidebar
          photoLink={user?.photoLink ?? ""}
          role={user?.role}
          isAgentMode={agentWhiteList}
        />
        <div className="h-full w-full flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-xl font-semibold mb-2">Unable to load chat</h2>
            <p className="text-gray-600 dark:text-gray-400">
              {sharedChatError ||
                "This shared chat link is invalid or has been deactivated."}
            </p>
          </div>
        </div>
      </div>
    )
  }

  const handleChatRename = async () => {
    setIsEditing(true)
    setTimeout(() => {
      if (titleRef.current) {
        titleRef.current.focus()
      }
    }, 0)
    setEditedTitle(chatTitle)
  }

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      if (editedTitle && editedTitle !== chatTitle) {
        renameChatMutation.mutate({
          chatId: chatId!,
          newTitle: editedTitle,
        })
      }
    } else if (e.key === "Escape") {
      e.preventDefault()
      setEditedTitle(chatTitle)
      setIsEditing(false)
      if (titleRef.current) {
        titleRef.current.value = chatTitle!
      }
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditedTitle(e.target.value)
  }

  const handleBlur = () => {
    if (editedTitle !== chatTitle) {
      setEditedTitle(chatTitle)
      if (titleRef.current) titleRef.current.value = chatTitle!
    }
    setIsEditing(false)
  }

  const handleShowRagTrace = (messageId: string) => {
    const actualChatId = isSharedChat
      ? sharedChatData?.chat?.externalId
      : chatId
    if (actualChatId && messageId) {
      window.open(`/trace/${actualChatId}/${messageId}`, "_blank")
    }
  }

  const handleShare = () => {
    if (chatId && messages.length > 0) {
      setShareModalOpen(true)
    } else {
      toast({
        title: "Error",
        description: "No messages to share in this chat.",
        variant: "destructive",
      })
    }
  }

  return (
    <div className="h-full w-full flex flex-row bg-white dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <div className="h-full w-full flex flex-col relative">
        <div
          className={`flex ${isCitationPreviewOpen ? "w-1/2 ml-[52px]" : "w-full"} fixed bg-white dark:bg-[#1E1E1E] h-[48px] border-b-[1px] border-[#E6EBF5] dark:border-gray-700 justify-center transition-all duration-250 z-10 ${showSources ? "pr-[18%]" : ""}`}
        >
          <div className={`flex h-[48px] items-center max-w-3xl w-full px-4`}>
            {isEditing && !isSharedChat ? (
              <input
                ref={titleRef}
                className="flex-grow text-[#1C1D1F] dark:text-gray-100 bg-transparent text-[16px] font-normal overflow-hidden text-ellipsis whitespace-nowrap outline-none"
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                value={editedTitle!}
              />
            ) : (
              <div className="flex items-center flex-grow">
                <span className="text-[#1C1D1F] dark:text-gray-100 text-[16px] font-normal overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                  {isTitleUpdating ? streamingTitle : chatTitle}
                  {isTitleUpdating && (
                    <span className="inline-block w-0.5 h-4 bg-gray-400 dark:bg-gray-500 ml-1 animate-pulse" />
                  )}
                </span>
              </div>
            )}
            {isSharedChat ? (
              <span className="text-[12px] text-gray-500 dark:text-gray-400 ml-2">
                Shared • Read-only
              </span>
            ) : (
              <>
                {chatTitle && (
                  <Pencil
                    stroke="#4A4F59"
                    className="dark:stroke-gray-400 cursor-pointer"
                    size={18}
                    onClick={handleChatRename}
                  />
                )}
                {chatId && (
                  <Share2
                    stroke="#4A4F59"
                    className="dark:stroke-gray-400 ml-[20px] cursor-pointer hover:stroke-[#4A63E9]"
                    size={18}
                    onClick={() => handleShare()}
                  />
                )}
              </>
            )}
            <Bookmark
              {...(bookmark ? { fill: "#4A4F59" } : { outline: "#4A4F59" })}
              className={`ml-[20px] cursor-pointer dark:stroke-gray-400 ${CLASS_NAMES.BOOKMARK_BUTTON}`}
              fill={
                bookmark ? (theme === "dark" ? "#A0AEC0" : "#4A4F59") : "none"
              }
              stroke={theme === "dark" ? "#A0AEC0" : "#4A4F59"}
              onClick={handleBookmark}
              size={18}
            />
            <Ellipsis
              stroke="#4A4F59"
              className="dark:stroke-gray-400 ml-[20px]"
              size={18}
            />
          </div>
        </div>

        <div className="flex flex-row h-full w-full">
          <div
            className={`h-full flex-1 flex items-end justify-center transition-all duration-250 ${showSources ? "pr-[18%]" : ""}`}
          >
            <div
              className={`w-full h-full flex flex-col ${isCitationPreviewOpen ? "px-20" : "items-center"}`}
            >
              <VirtualizedMessages
                ref={messagesContainerRef}
                messages={messages}
                currentResp={currentResp}
                showSources={showSources}
                currentMessageId={currentMessageId}
                feedbackMap={feedbackMap}
                isStreaming={isStreaming}
                retryIsStreaming={retryIsStreaming}
                isSharedChat={isSharedChat}
                isDebugMode={isDebugMode}
                disableRetry={disableRetry}
                dots={dots}
                setShowSources={setShowSources}
                setCurrentCitations={setCurrentCitations}
                setCurrentMessageId={setCurrentMessageId}
                handleRetry={handleRetry}
                handleShowRagTrace={handleShowRagTrace}
                handleFeedback={handleFeedback}
                handleShare={handleShare}
                handleSend={handleSend}
                scrollToBottom={scrollToBottom}
                chatId={chatId}
                userHasScrolled={userHasScrolled}
                setUserHasScrolled={setUserHasScrolled}
                onCitationClick={handleCitationClick}
                isCitationPreviewOpen={isCitationPreviewOpen}
                setIsCitationPreviewOpen={setIsCitationPreviewOpen}
                setSelectedCitation={setSelectedCitation}
                chatBoxRef={chatBoxRef}
                isAutoScrollingRef={isAutoScrollingRef}
                partial={partial}
                bottomSpace={bottomSpace}
                onFollowUpQuestionsLoaded={handleFollowUpQuestionsLoaded}
                clarificationRequest={clarificationRequest}
                waitingForClarification={waitingForClarification}
                provideClarification={provideClarification}
              />
              {showRagTrace && chatId && selectedMessageId && (
                <div className="fixed inset-0 z-50 bg-white dark:bg-[#1E1E1E] overflow-auto">
                  <RagTraceVirtualization
                    chatId={chatId}
                    messageId={selectedMessageId}
                    onClose={() => {
                      setShowRagTrace(false)
                      setSelectedMessageId(null)
                    }}
                  />
                </div>
              )}

              {/* Scroll to Bottom Button */}
              {userHasScrolled && !isSharedChat && (
                <div className="fixed bottom-32 right-1/2 transform translate-x-1/2 z-30">
                  <button
                    onClick={scrollToBottom}
                    className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-full p-2 shadow-lg hover:shadow-xl transition-all duration-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                    title="Scroll to bottom"
                  >
                    <ArrowDown
                      size={18}
                      className="text-gray-600 dark:text-gray-300"
                    />
                  </button>
                </div>
              )}

              {!isSharedChat && (
                <div
                  className={`sticky bottom-0 w-full flex ${isCitationPreviewOpen ? "px-3" : "justify-center"} bg-white dark:bg-[#1E1E1E] pt-2`}
                >
                  <div className="w-full max-w-3xl">
                    <ChatBox
                      ref={chatBoxRef}
                      role={user?.role}
                      query={query}
                      setQuery={setQuery}
                      handleSend={handleSend}
                      handleStop={stopStream}
                      isStreaming={isStreaming}
                      retryIsStreaming={retryIsStreaming}
                      allCitations={allCitations}
                      setIsAgenticMode={setIsAgenticMode}
                      isAgenticMode={isAgenticMode}
                      chatId={chatId}
                      agentIdFromChatData={data?.chat?.agentId ?? null} // Pass agentId from loaded chat data
                      user={user} // Pass user prop
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
          <Sources
            showSources={showSources}
            citations={currentCitations}
            closeSources={() => {
              setShowSources(false)
              setCurrentCitations([])
              setCurrentMessageId(null)
            }}
            onCitationClick={handleCitationClick}
          />
        </div>
      </div>

      {/* Share Modal */}
      <ShareModal
        open={shareModalOpen}
        onOpenChange={setShareModalOpen}
        chatId={chatId}
        messages={messages}
      />

      {/* Enhanced Feedback Modal */}
      {pendingFeedback && (
        <FeedbackModal
          isOpen={feedbackModalOpen}
          onClose={() => {
            setFeedbackModalOpen(false)
            setPendingFeedback(null)
          }}
          onSubmit={handleEnhancedFeedbackSubmit}
          feedbackType={pendingFeedback.type}
          messageId={pendingFeedback.messageId}
          chatId={chatId || ""}
        />
      )}

      {/* Citation Preview Sidebar */}
      <CitationPreview
        citation={selectedCitation}
        isOpen={isCitationPreviewOpen}
        onClose={handleCloseCitationPreview}
        showBackButton={cameFromSources}
        onBackToSources={handleBackToSources}
        documentOperationsRef={documentOperationsRef}
        onDocumentLoaded={handleDocumentLoaded}
      />
    </div>
  )
}

const MessageCitationList = ({
  citations,
  onToggleSources,
  onCitationClick,
}: {
  citations: Citation[]
  onToggleSources: () => void
  onCitationClick?: (citation: Citation) => void
}) => {
  return (
    <TooltipProvider>
      <ul className={`flex flex-row mt-[24px]`}>
        {citations.map((citation: Citation, index: number) => (
          <li
            key={index}
            className="border-[#E6EBF5] dark:border-gray-700 border-[1px] rounded-[10px] w-[196px] mr-[6px] cursor-pointer hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
            onClick={(e) => {
              e.preventDefault()
              onCitationClick?.(citation)
            }}
          >
            <div className="flex pl-[12px] pt-[10px] pr-[12px]">
              <div className="flex flex-col w-full">
                <p className="line-clamp-2 text-[13px] tracking-[0.01em] leading-[17px] text-ellipsis font-medium break-all dark:text-gray-100">
                  {citation.title
                    ? parseHighlight(citation.title.split("/").pop())
                    : ""}
                </p>
                <div className="flex flex-col mt-[9px]">
                  <div className="flex items-center pb-[12px]">
                    {getIcon(citation.app, citation.entity)}
                    <span
                      style={{ fontWeight: 450 }}
                      className="text-[#848DA1] dark:text-gray-400 text-[13px] tracking-[0.01em] leading-[16px]"
                    >
                      {getName(citation.app, citation.entity)}
                    </span>
                    <span className="flex ml-auto items-center p-[5px] h-[16px] bg-[#EBEEF5] dark:bg-slate-700 dark:text-gray-300 mt-[3px] rounded-full text-[9px] font-mono">
                      {index + 1}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </li>
        ))}
        {!!citations.length && (
          <Tooltip>
            <TooltipTrigger asChild>
              <img
                onClick={onToggleSources}
                className="cursor-pointer"
                src={Expand}
              />
            </TooltipTrigger>
            <Tip side="right" info="Show All Sources" margin="ml-[16px]" />
          </Tooltip>
        )}
      </ul>
    </TooltipProvider>
  )
}

const CitationList = ({
  citations,
  onCitationClick,
}: {
  citations: Citation[]
  onCitationClick?: (
    citation: Citation,
    chunkIndex?: number,
    fromSources?: boolean,
  ) => void
}) => {
  return (
    <ul className={`mt-2`}>
      {citations.map((citation: Citation, index: number) => (
        <li
          key={index}
          className="border-[#E6EBF5] dark:border-gray-700 border-[1px] rounded-[10px] mt-[12px] w-[85%] cursor-pointer hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
          onClick={(e) => {
            e.preventDefault()
            onCitationClick?.(citation, undefined, true)
          }}
        >
          <div className="flex pl-[12px] pt-[12px]">
            <div className="flex items-center p-[5px] h-[16px] bg-[#EBEEF5] dark:bg-slate-700 dark:text-gray-300 rounded-full text-[9px] mr-[8px] font-mono">
              {index + 1}
            </div>
            <div className="flex flex-col mr-[12px]">
              <span className="line-clamp-2 text-[13px] tracking-[0.01em] leading-[17px] text-ellipsis font-medium break-all dark:text-gray-100">
                {citation.title
                  ? parseHighlight(citation.title.split("/").pop())
                  : ""}
              </span>
              <div className="flex items-center pb-[12px] mt-[8px]">
                {getIcon(citation.app, citation.entity)}
                <span className="text-[#848DA1] dark:text-gray-400 text-[13px] tracking-[0.01em] leading-[16px]">
                  {getName(citation.app, citation.entity)}
                </span>
              </div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

const Sources = ({
  showSources,
  citations,
  closeSources,
  onCitationClick,
}: {
  showSources: boolean
  citations: Citation[]
  closeSources: () => void
  onCitationClick?: (
    citation: Citation,
    chunkIndex?: number,
    fromSources?: boolean,
  ) => void
}) => {
  return showSources ? (
    <div
      className={`fixed top-[48px] right-0 bottom-0 w-1/4 border-l-[1px] border-[#E6EBF5] dark:border-gray-700 bg-white dark:bg-[#1E1E1E] flex flex-col z-40`}
    >
      <div className="flex items-center px-[40px] py-[24px] border-b-[1px] border-[#E6EBF5] dark:border-gray-700">
        <span className="text-[#929FBA] dark:text-gray-400 font-normal text-[12px] tracking-[0.08em] font-mono">
          SOURCES
        </span>
        <X
          stroke="#9EAEBE"
          size={14}
          className="ml-auto cursor-pointer dark:stroke-gray-400"
          onClick={closeSources}
        />
      </div>
      <div className="flex-1 overflow-y-auto px-[40px] pb-[24px]">
        <CitationList citations={citations} onCitationClick={onCitationClick} />
      </div>
    </div>
  ) : null
}

interface ImageCitationComponentProps {
  citationKey: string
  imageCitations: ImageCitation[] | ImageCitation
  className?: string
}

export const ImageCitationComponent: React.FC<ImageCitationComponentProps> = ({
  citationKey,
  imageCitations,
  className = "",
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false)
  let imageCitation: ImageCitation | undefined
  let imageSrc = ""

  try {
    if (Array.isArray(imageCitations)) {
      imageCitation = imageCitations.find(
        (ic) => ic.citationKey === citationKey,
      )
    } else if (
      imageCitations &&
      typeof imageCitations === "object" &&
      "citationKey" in imageCitations
    ) {
      if ((imageCitations as ImageCitation).citationKey === citationKey) {
        imageCitation = imageCitations as ImageCitation
      }
    }
    if (!imageCitation) {
      return null
    }

    // TODO: Fetch image data from API instead of using base64
    imageSrc = `data:${imageCitation.mimeType};base64,${imageCitation.imageData}`
  } catch (error) {
    console.error("Error fetching image data:", error)
    return null
  }

  const ImageModal = () => {
    const handleCloseModal = () => {
      setIsModalOpen(false)
    }

    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          handleCloseModal()
        }
      }

      if (isModalOpen) {
        document.addEventListener("keydown", handleKeyDown)
        // Don't change body overflow - let the page stay where it is
      }

      return () => {
        document.removeEventListener("keydown", handleKeyDown)
        // Don't reset body overflow
      }
    }, [isModalOpen])

    if (!isModalOpen) return null

    const Controls = () => {
      const { zoomIn, zoomOut, resetTransform, centerView } = useControls()

      const buttonBaseClass =
        "bg-white/90 dark:bg-gray-800/90 hover:bg-white dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 p-2 rounded-lg shadow-lg backdrop-blur-sm transition-all duration-200"

      const handleResetAndCenter = () => {
        resetTransform()
        setTimeout(() => {
          centerView()
        }, 10)
      }

      return (
        <div className="absolute top-4 left-4 flex space-x-2 z-20">
          <button
            onClick={() => zoomIn()}
            className={buttonBaseClass}
            title="Zoom In"
          >
            <ZoomIn size={20} />
          </button>
          <button
            onClick={() => zoomOut()}
            className={buttonBaseClass}
            title="Zoom Out"
          >
            <ZoomOut size={20} />
          </button>
          <button
            onClick={handleResetAndCenter}
            className={buttonBaseClass}
            title="Reset View"
          >
            <RefreshCw size={20} />
          </button>
        </div>
      )
    }

    // Use createPortal to render the modal outside the normal component tree
    return createPortal(
      <div
        className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex items-center justify-center"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 9999,
        }}
        onClick={handleCloseModal}
      >
        <div
          className="relative w-full h-full flex items-center justify-center"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close button */}
          <button
            onClick={handleCloseModal}
            className="absolute top-4 right-4 bg-white/90 dark:bg-gray-800/90 hover:bg-white dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 p-2 rounded-lg shadow-lg backdrop-blur-sm transition-all duration-200 z-20"
            title="Close (ESC)"
          >
            <X size={20} />
          </button>
          <TransformWrapper
            initialScale={1}
            minScale={0.1}
            maxScale={10}
            limitToBounds={false}
            centerOnInit={true}
            centerZoomedOut={false}
            doubleClick={{ disabled: false, step: 2 }}
            wheel={{ step: 0.1 }}
            panning={{ velocityDisabled: true }}
          >
            <Controls />
            <TransformComponent
              wrapperStyle={{
                width: "100%",
                height: "100%",
                cursor: "grab",
              }}
              contentStyle={{
                width: "100%",
                height: "100%",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <img
                src={imageSrc}
                alt={`Image from document - ${citationKey}`}
                className="max-w-none max-h-none object-contain"
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  width: "auto",
                  height: "auto",
                }}
                draggable={false}
              />
            </TransformComponent>
          </TransformWrapper>
        </div>
      </div>,
      document.body,
    )
  }

  return (
    <>
      <div className={`block ${className}`}>
        <img
          src={imageSrc}
          alt={`Image from document - ${citationKey}`}
          className="max-w-full h-auto rounded-lg border border-gray-200 dark:border-gray-600 shadow-md cursor-zoom-in transition-transform duration-200 hover:scale-[1.02]"
          style={{ maxHeight: "400px" }}
          onClick={() => setIsModalOpen(true)}
        />
      </div>

      {isModalOpen && <ImageModal />}
    </>
  )
}

// Virtualized Messages Component
interface VirtualizedMessagesProps {
  messages: SelectPublicMessage[]
  currentResp?: {
    resp: string
    sources?: Citation[]
    imageCitations?: any[]
    thinking?: string
    deepResearchSteps?: any[]
    messageId?: string | null
    citationMap?: any
    clarificationRequest?: any
    waitingForClarification?: boolean
  } | null
  showSources: boolean
  currentMessageId: string | null
  feedbackMap: Record<string, MessageFeedback | null>
  isStreaming: boolean
  retryIsStreaming: boolean
  isSharedChat: boolean
  isDebugMode: boolean
  disableRetry: boolean
  dots: string
  setShowSources: (show: boolean) => void
  setCurrentCitations: (citations: Citation[]) => void
  setCurrentMessageId: (id: string | null) => void
  handleRetry: (messageId: string) => void
  handleShowRagTrace: (messageId: string) => void
  handleFeedback?: (messageId: string, feedback: MessageFeedback) => void
  handleShare?: () => void
  handleSend: (message: string) => void
  scrollToBottom: () => void
  chatId: string | null
  userHasScrolled: boolean
  setUserHasScrolled: (hasScrolled: boolean) => void
  onCitationClick: (citation: Citation) => void
  isCitationPreviewOpen: boolean
  setIsCitationPreviewOpen: (open: boolean) => void
  setSelectedCitation: (citation: Citation | null) => void
  chatBoxRef: React.RefObject<ChatBoxRef>
  isAutoScrollingRef: React.MutableRefObject<boolean>
  partial: string
  bottomSpace: number
  onFollowUpQuestionsLoaded: () => void
  clarificationRequest?: any
  waitingForClarification?: boolean
  provideClarification?: (
    clarificationId: string,
    selectedOptionId: string,
    selectedOptionLabel: string,
    customInput?: string,
  ) => void
}

const ESTIMATED_MESSAGE_HEIGHT = 200 // Increased estimate for better performance
const OVERSCAN = 3 // Reduced overscan for better performance

const VirtualizedMessages = React.forwardRef<
  HTMLDivElement,
  VirtualizedMessagesProps
>(
  (
    {
      messages,
      currentResp,
      showSources,
      currentMessageId,
      feedbackMap,
      isStreaming,
      retryIsStreaming,
      isSharedChat,
      isDebugMode,
      disableRetry,
      dots,
      setShowSources,
      setCurrentCitations,
      setCurrentMessageId,
      handleRetry,
      handleShowRagTrace,
      handleFeedback,
      handleShare,
      handleSend,
      scrollToBottom,
      chatId,
      userHasScrolled,
      setUserHasScrolled,
      onCitationClick,
      isCitationPreviewOpen,
      setIsCitationPreviewOpen,
      setSelectedCitation,
      chatBoxRef,
      isAutoScrollingRef,
      partial,
      bottomSpace,
      onFollowUpQuestionsLoaded,
      clarificationRequest,
      waitingForClarification,
      provideClarification,
    },
    ref,
  ) => {
    const parentRef = useRef<HTMLDivElement>(null)
    const lastScrollTop = useRef(0)

    // Create items array including messages and current response
    const allItems = useMemo(() => {
      const items = [...messages]
      if (currentResp) {
        items.push({
          externalId: currentResp.messageId || "current-resp",
          message: currentResp.resp,
          messageRole: "assistant" as const,
          sources: currentResp.sources || [],
          imageCitations: currentResp.imageCitations || [],
          thinking: currentResp.thinking || "",
          deepResearchSteps: currentResp.deepResearchSteps || [],
          citationMap: currentResp.citationMap,
          isStreaming: true,
          attachments: [],
          clarificationRequest: currentResp.clarificationRequest,
          waitingForClarification: currentResp.waitingForClarification,
        })
      }
      return items
    }, [messages, currentResp])

    const rowVirtualizer = useVirtualizer({
      count: allItems.length,
      getScrollElement: () =>
        (typeof ref === "object" && ref?.current) || parentRef.current,
      estimateSize: () => ESTIMATED_MESSAGE_HEIGHT,
      overscan: OVERSCAN,
      measureElement: (element) => {
        // Get accurate height measurements for better virtualization
        return (
          element?.getBoundingClientRect().height ?? ESTIMATED_MESSAGE_HEIGHT
        )
      },
    })

    // Auto-scroll to bottom when new messages arrive (only if user hasn't manually scrolled)
    useEffect(() => {
      if (!userHasScrolled && allItems.length > 0) {
        // Let the main scroll effect handle this, just ensure we're at the end
        const container =
          (typeof ref === "object" && ref?.current) || parentRef.current
        if (container) {
          const timeoutId = setTimeout(() => {
            container.scrollTop = container.scrollHeight
          }, 50)
          return () => clearTimeout(timeoutId)
        }
      }
    }, [allItems.length, userHasScrolled, ref])

    // Initialize scroll to bottom for new chats
    useEffect(() => {
      if (allItems.length > 0) {
        const container =
          (typeof ref === "object" && ref?.current) || parentRef.current
        if (container) {
          // Initial scroll to bottom
          container.scrollTop = container.scrollHeight
        }
      }
    }, []) // Only run once on mount

    // Detect user scrolling and update scroll button visibility
    const handleScroll = useCallback(
      (e: React.UIEvent<HTMLDivElement>) => {
        // Skip if we're in the middle of auto-scrolling
        if (isAutoScrollingRef.current) return

        const element = e.currentTarget
        const scrollTop = element.scrollTop
        const scrollHeight = element.scrollHeight
        const clientHeight = element.clientHeight

        // Track the scroll position for reference
        lastScrollTop.current = scrollTop

        // Calculate if we're at the bottom with a reasonable threshold
        const isAtBottom = scrollTop >= scrollHeight - clientHeight - 30

        // Update scroll button visibility based on position
        if (isAtBottom) {
          // User is at bottom, hide scroll to bottom button
          if (userHasScrolled) {
            setUserHasScrolled(false)
          }
        } else {
          // User is not at bottom, show scroll to bottom button
          if (!userHasScrolled) {
            setUserHasScrolled(true)
          }
        }
      },
      [userHasScrolled, setUserHasScrolled],
    )

    return (
      <div
        ref={(node) => {
          // Update parentRef for internal use
          ;(parentRef as any).current = node
          // Forward the ref to the parent component
          if (typeof ref === "function") {
            ref(node)
          } else if (ref) {
            ;(ref as any).current = node
          }
        }}
        className={`h-full w-full overflow-auto flex flex-col scroll-smooth ${isCitationPreviewOpen ? "items-start" : "items-center"}`}
        onScroll={handleScroll}
        style={{
          height: "100%",
          width: "100%",
        }}
      >
        <div className="w-full max-w-3xl flex-grow relative mt-[56px] mb-[60px]">
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualItem) => {
              const message = allItems[virtualItem.index]
              const index = virtualItem.index
              const isSourcesVisible =
                showSources && currentMessageId === message.externalId
              const userMessageWithErr =
                message.messageRole === "user" && message?.errorMessage
              const isLastAssistantMessage =
                message.messageRole === "assistant" &&
                !isStreaming &&
                !retryIsStreaming &&
                !isSharedChat &&
                message.externalId &&
                index === messages.length - 1
              const shouldWireClarification =
                !!currentResp &&
                message.externalId === (currentResp.messageId || "current-resp")
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  data-message-role={message.messageRole}
                  data-message-id={message.externalId}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <Fragment key={message.externalId ?? index}>
                    <ChatMessage
                      key={
                        message.externalId
                          ? `${message.externalId}-msg`
                          : `msg-${index}`
                      }
                      message={message.message}
                      isUser={message.messageRole === "user"}
                      responseDone={
                        message.isStreaming !== true &&
                        message.externalId !== "current-resp"
                      }
                      thinking={message.thinking}
                      deepResearchSteps={message.deepResearchSteps}
                      citations={message.sources}
                      imageCitations={message.imageCitations || []}
                      messageId={message.externalId}
                      handleRetry={handleRetry}
                      citationMap={message.citationMap}
                      isRetrying={message.isRetrying}
                      dots={
                        message.isRetrying ||
                        message.externalId === "current-resp"
                          ? dots
                          : ""
                      }
                      onToggleSources={() => {
                        if (
                          showSources &&
                          currentMessageId === message.externalId
                        ) {
                          setShowSources(false)
                          setCurrentCitations([])
                          setCurrentMessageId(null)
                        } else {
                          setCurrentCitations(message?.sources || [])
                          setShowSources(true)
                          setCurrentMessageId(message.externalId)
                          // Close citation preview when opening sources
                          setIsCitationPreviewOpen(false)
                          setSelectedCitation(null)
                        }
                      }}
                      sourcesVisible={isSourcesVisible}
                      isStreaming={
                        message.externalId === "current-resp"
                          ? isStreaming
                          : false
                      }
                      isDebugMode={isDebugMode}
                      onShowRagTrace={handleShowRagTrace}
                      feedbackStatus={feedbackMap[message.externalId!] || null}
                      onFeedback={!isSharedChat ? handleFeedback : undefined}
                      onShare={
                        !isSharedChat && handleShare
                          ? () => handleShare()
                          : undefined
                      }
                      disableRetry={disableRetry}
                      attachments={message.attachments || []}
                      onCitationClick={onCitationClick}
                      isCitationPreviewOpen={isCitationPreviewOpen}
                      clarificationRequest={message.clarificationRequest}
                      waitingForClarification={
                        message.waitingForClarification || false
                      }
                      provideClarification={
                        shouldWireClarification
                          ? provideClarification
                          : undefined
                      }
                    />

                    {userMessageWithErr && (
                      <ChatMessage
                        key={
                          message.externalId
                            ? `${message.externalId}-err`
                            : `err-${index}`
                        }
                        message={message.errorMessage}
                        thinking={message.thinking}
                        deepResearchSteps={message.deepResearchSteps}
                        isUser={false}
                        responseDone={true}
                        citations={message.sources}
                        imageCitations={message.imageCitations || []}
                        messageId={message.externalId}
                        handleRetry={handleRetry}
                        citationMap={message.citationMap}
                        isRetrying={message.isRetrying}
                        dots={message.isRetrying ? dots : ""}
                        onToggleSources={() => {
                          if (
                            showSources &&
                            currentMessageId === message.externalId
                          ) {
                            setShowSources(false)
                            setCurrentCitations([])
                            setCurrentMessageId(null)
                          } else {
                            setCurrentCitations(message?.sources || [])
                            setShowSources(true)
                            setCurrentMessageId(message.externalId)
                            // Close citation preview when opening sources
                            setIsCitationPreviewOpen(false)
                            setSelectedCitation(null)
                          }
                        }}
                        sourcesVisible={isSourcesVisible}
                        isStreaming={isStreaming}
                        isDebugMode={isDebugMode}
                        onShowRagTrace={handleShowRagTrace}
                        feedbackStatus={
                          feedbackMap[message.externalId!] || null
                        }
                        onFeedback={!isSharedChat ? handleFeedback : undefined}
                        onShare={
                          !isSharedChat && handleShare
                            ? () => handleShare()
                            : undefined
                        }
                        disableRetry={disableRetry}
                        attachments={message.attachments || []}
                        onCitationClick={onCitationClick}
                        isCitationPreviewOpen={isCitationPreviewOpen}
                      />
                    )}

                    {/* Show follow-up questions only for the latest assistant message */}
                    {isLastAssistantMessage && chatId && (
                      <FollowUpQuestions
                        chatId={chatId}
                        messageId={message.externalId}
                        onQuestionClick={(question: string) => {
                          // Use ChatBox's sendMessage method which includes all internal state
                          // (tools, connectors, agent ID, etc.)
                          chatBoxRef.current?.sendMessage(question)
                        }}
                        isStreaming={isStreaming || retryIsStreaming}
                        onQuestionsLoaded={onFollowUpQuestionsLoaded}
                      />
                    )}
                  </Fragment>
                </div>
              )
            })}
          </div>

          {/* Bottom spacing to position query at top of viewport */}
          {bottomSpace > 0 && (
            <div
              className="w-full"
              style={{
                height: `${bottomSpace}px`,
              }}
            />
          )}
        </div>
      </div>
    )
  },
)

VirtualizedMessages.displayName = "VirtualizedMessages"

export const ChatMessage = ({
  message,
  thinking,
  deepResearchSteps = [],
  isUser,
  responseDone,
  isRetrying,
  citations = [],
  imageCitations = [],
  messageId,
  handleRetry,
  dots = "",
  onToggleSources,
  citationMap,
  sourcesVisible,
  isStreaming = false,
  isDebugMode,
  onShowRagTrace,
  feedbackStatus,
  onFeedback,
  onShare,
  disableRetry = false,
  attachments = [],
  onCitationClick,
  isCitationPreviewOpen = false,
  clarificationRequest,
  waitingForClarification,
  provideClarification,
}: {
  message: string
  thinking: string
  deepResearchSteps?: any[]
  isUser: boolean
  responseDone: boolean
  isRetrying?: boolean
  citations?: Citation[]
  imageCitations?: ImageCitation[]
  messageId?: string
  dots: string
  handleRetry: (messageId: string) => void
  onToggleSources: () => void
  citationMap?: Record<number, number>
  sourcesVisible: boolean
  isStreaming?: boolean
  isDebugMode: boolean
  onShowRagTrace: (messageId: string) => void
  feedbackStatus?: MessageFeedback | null
  onFeedback?: (messageId: string, feedback: MessageFeedback) => void
  onShare?: (messageId: string) => void
  disableRetry?: boolean
  attachments?: AttachmentMetadata[]
  onCitationClick?: (citation: Citation) => void
  isCitationPreviewOpen?: boolean
  clarificationRequest?: any
  waitingForClarification?: boolean
  provideClarification?: (
    clarificationId: string,
    selectedOptionId: string,
    selectedOptionLabel: string,
    customInput?: string,
  ) => void
}) => {
  const { theme } = useTheme()
  const [isCopied, setIsCopied] = useState(false)
  const citationUrls = citations?.map((c: Citation) => c.url)

  return (
    <div className="max-w-full min-w-0 flex flex-col items-end space-y-3">
      {/* Render attachments above the message box for user messages */}
      {isUser && attachments && attachments.length > 0 && (
        <div className="w-full max-w-full">
          <AttachmentGallery attachments={attachments} />
        </div>
      )}

      <div
        className={`rounded-[16px] max-w-full min-w-0 ${isUser ? "bg-[#F0F2F4] dark:bg-slate-700 text-[#1C1D1F] dark:text-slate-100 text-[15px] leading-[25px] self-end pt-[14px] pb-[14px] pl-[20px] pr-[20px] break-words overflow-wrap-anywhere" : "text-[#1C1D1F] dark:text-[#F1F3F4] text-[15px] leading-[25px] self-start w-full max-w-full min-w-0"}`}
      >
        {isUser ? (
          <div
            className="break-words overflow-wrap-anywhere word-break-break-all max-w-full min-w-0"
            dangerouslySetInnerHTML={{
              __html: jsonToHtmlMessage(DOMPurify.sanitize(message)),
            }}
          />
        ) : (
          <div
            className={`flex flex-col mt-[40px] w-full max-w-full min-w-0 ${citationUrls.length ? "mb-[35px]" : ""}`}
          >
            <div className="flex flex-row w-full max-w-full min-w-0">
              <img
                className={"mr-[20px] w-[32px] self-start flex-shrink-0"}
                src={logo}
              />
              <div className="mt-[4px] markdown-content w-full min-w-0 flex-1">
                {deepResearchSteps && deepResearchSteps.length > 0 && (
                  <>
                    <DeepResearchReasoning
                      steps={deepResearchSteps}
                      isStreaming={!responseDone}
                      className="mb-4"
                    />
                  </>
                )}
                {(thinking || clarificationRequest) && (
                  <>
                    <EnhancedReasoning
                      content={thinking || ""}
                      isStreaming={!responseDone}
                      className="mb-4"
                      citations={citations}
                      citationMap={citationMap}
                      clarificationRequest={clarificationRequest}
                      waitingForClarification={waitingForClarification}
                      onClarificationSelect={(
                        selectedOptionId: string,
                        selectedOptionLabel: string,
                        customInput?: string,
                      ) => {
                        if (clarificationRequest && provideClarification) {
                          provideClarification(
                            clarificationRequest.clarificationId,
                            selectedOptionId,
                            selectedOptionLabel,
                            customInput,
                          )
                        }
                      }}
                    />
                  </>
                )}
                {message === "" &&
                (!responseDone || isRetrying) &&
                !deepResearchSteps.length ? (
                  <div className="flex-grow text-[#1C1D1F] dark:text-[#F1F3F4]">
                    {`${THINKING_PLACEHOLDER}${dots}`}
                  </div>
                ) : message !== "" ? (
                  <MarkdownPreview
                    key={`markdown-${messageId || "unknown"}`}
                    source={processMessage(message, citationMap, citationUrls)}
                    wrapperElement={{
                      "data-color-mode": theme,
                    }}
                    style={{
                      padding: 0,
                      backgroundColor: "transparent",
                      color: theme === "dark" ? "#F1F3F4" : "#1C1D1F",
                      maxWidth: "100%",
                      overflowWrap: "break-word",
                      wordBreak: "break-word",
                      minWidth: 0,
                    }}
                    components={{
                      a: createCitationLink(citations, onCitationClick),
                      code: MermaidCodeWrapper,
                      img: ({ src, alt, ...props }: any) => {
                        if (src?.startsWith("image-citation:")) {
                          const citationKey = src.replace("image-citation:", "")
                          return (
                            <ImageCitationComponent
                              citationKey={citationKey}
                              imageCitations={imageCitations}
                              className="flex justify-center"
                            />
                          )
                        }
                        // Regular image handling
                        return <img src={src} alt={alt} {...props} />
                      },
                      ...createTableComponents(), // Use extracted table components
                      h1: ({ node, ...props }) => (
                        <h1
                          style={{ fontSize: "1.6em" }}
                          className="dark:text-gray-100"
                          {...props}
                        />
                      ),
                      h2: ({ node, ...props }) => (
                        <h1 style={{ fontSize: "1.2em" }} {...props} />
                      ),
                      h3: ({ node, ...props }) => (
                        <h1 style={{ fontSize: "1em" }} {...props} />
                      ),
                      h4: ({ node, ...props }) => (
                        <h1 style={{ fontSize: "0.8em" }} {...props} />
                      ),
                      h5: ({ node, ...props }) => (
                        <h1 style={{ fontSize: "0.7em" }} {...props} />
                      ),
                      h6: ({ node, ...props }) => (
                        <h1 style={{ fontSize: "0.68em" }} {...props} />
                      ),
                      ul: ({ node, ...props }) => (
                        <ul
                          style={{
                            listStyleType: "disc",
                            paddingLeft: "1.5rem",
                            marginBottom: "1rem",
                          }}
                          {...props}
                        />
                      ),
                      ol: ({ node, ...props }) => (
                        <ol
                          style={{
                            listStyleType: "decimal",
                            paddingLeft: "1.5rem",
                            marginBottom: "1rem",
                          }}
                          {...props}
                        />
                      ),
                      li: ({ node, ...props }) => (
                        <li
                          style={{
                            marginBottom: "0.25rem",
                          }}
                          {...props}
                        />
                      ),
                    }}
                  />
                ) : null}
              </div>
            </div>
            {!isStreaming && responseDone && !isRetrying && (
              <div className="flex flex-col">
                {isDebugMode && messageId && (
                  <button
                    className="ml-[52px] text-[13px] text-[#4A63E9] hover:text-[#2D46CC] underline font-mono mt-2 text-left"
                    onClick={() => onShowRagTrace(messageId)}
                  >
                    View RAG Trace #{messageId.slice(-6)}
                  </button>
                )}
                <div className="flex ml-[52px] mt-[12px] items-center">
                  <Copy
                    size={16}
                    stroke={`${isCopied ? "#4F535C" : "#B2C3D4"}`}
                    className={`cursor-pointer`}
                    onMouseDown={() => setIsCopied(true)}
                    onMouseUp={() => setIsCopied(false)}
                    onClick={() =>
                      navigator.clipboard.writeText(
                        cleanCitationsFromResponse(message),
                      )
                    }
                  />
                  {/* Retry button temporarily hidden */}
                  {false && (
                    <img
                      className={`ml-[18px] ${disableRetry || !messageId ? "opacity-50" : "cursor-pointer"}`}
                      src={Retry}
                      onClick={() =>
                        messageId && !disableRetry && handleRetry(messageId)
                      }
                      title="Retry"
                    />
                  )}
                  {messageId && (
                    <>
                      <ThumbsUp
                        size={16}
                        stroke={
                          feedbackStatus === MessageFeedback.Like
                            ? "#10B981"
                            : "#B2C3D4"
                        }
                        fill="none"
                        className={`ml-[18px] ${onFeedback ? "cursor-pointer" : "opacity-50"}`}
                        onClick={() =>
                          onFeedback &&
                          onFeedback(messageId, MessageFeedback.Like)
                        }
                      />
                      <ThumbsDown
                        size={16}
                        stroke={
                          feedbackStatus === MessageFeedback.Dislike
                            ? "#EF4444"
                            : "#B2C3D4"
                        }
                        fill="none"
                        className={`ml-[10px] ${onFeedback ? "cursor-pointer" : "opacity-50"}`}
                        onClick={() =>
                          onFeedback &&
                          onFeedback(messageId, MessageFeedback.Dislike)
                        }
                      />
                    </>
                  )}
                  {!!citationUrls.length && (
                    <div className="ml-auto flex">
                      <div className="flex items-center pr-[8px] pl-[8px] pt-[6px] pb-[6px]">
                        <span className="font-light ml-[4px] select-none leading-[14px] tracking-[0.02em] text-[12px] text-[#9EAEBE] font-mono">
                          SOURCES
                        </span>
                        <ChevronDown
                          size={14}
                          className="ml-[4px]"
                          color="#B2C3D4"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-row ml-[52px]">
                  <MessageCitationList
                    citations={citations.slice(0, 3)}
                    onToggleSources={onToggleSources}
                    onCitationClick={onCitationClick}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const chatParams = z.object({
  q: z.string().optional(),
  debug: z
    .string()
    .transform((val) => val === "true")
    .optional()
    .default("false"),
  agentic: z
    .string()
    .transform((val) => val === "true")
    .optional()
    .default("false"),
  refs: z // Changed from docId to refs, expects a JSON string array
    .string()
    .optional()
    .transform((val) => {
      if (!val) return undefined
      try {
        const parsed = JSON.parse(val)
        return Array.isArray(parsed) &&
          parsed.every((item) => typeof item === "string")
          ? parsed
          : undefined
      } catch (e) {
        return undefined
      }
    }),
  sources: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(",") : undefined)),
  agentId: z.string().optional(), // Added agentId to Zod schema
  selectedModel: z.string().optional(), // Added selectedModel to Zod schema
  toolsList: z
    .any()
    .optional()
    .transform((val) => {
      if (!val) return undefined
      // If it's already an array, validate and return it
      if (Array.isArray(val)) {
        try {
          return z.array(toolsListItemSchema).parse(val)
        } catch (e) {
          return undefined
        }
      }
      // If it's a string, try to parse it as JSON
      if (typeof val === "string") {
        try {
          const parsed = JSON.parse(val)
          if (Array.isArray(parsed)) {
            return z.array(toolsListItemSchema).parse(parsed)
          }
          return undefined
        } catch (e) {
          return undefined
        }
      }
      return undefined
    }),
  shareToken: z.string().optional(), // Added shareToken for shared chats
  // @ts-ignore
  metadata: z.array(attachmentMetadataSchema).optional(),
})

type XyneChat = z.infer<typeof chatParams>

export const Route = createFileRoute("/_authenticated/chat")({
  beforeLoad: (params) => {
    return params
  },
  loader: async (params) => {
    return params
  },
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace, agentWhiteList } =
      matches[matches.length - 1].context
    return (
      <DocumentOperationsProvider>
        <ChatPage
          user={user}
          workspace={workspace}
          agentWhiteList={agentWhiteList}
        />
      </DocumentOperationsProvider>
    )
  },
  errorComponent: errorComponent,
})
