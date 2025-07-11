import MarkdownPreview from "@uiw/react-markdown-preview"
import { getCodeString } from "rehype-rewrite"
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
  Plus,
  Minus,
  Maximize2,
  Minimize2,
  Share2,
} from "lucide-react"
import { useEffect, useRef, useState, Fragment, useCallback } from "react"
import {
  TransformWrapper,
  TransformComponent,
  useControls,
} from "react-zoom-pan-pinch"
import { useTheme } from "@/components/ThemeContext"
import mermaid from "mermaid"

// Initialize mermaid with secure configuration to prevent syntax errors
mermaid.initialize({
  startOnLoad: false,
  theme: "default",
  securityLevel: "strict",
  fontFamily: "monospace",
  logLevel: "fatal", // Minimize mermaid console logs
  suppressErrorRendering: true, // Suppress error rendering if available
  flowchart: {
    useMaxWidth: true,
  },
  sequence: {
    useMaxWidth: true,
  },
  gantt: {
    useMaxWidth: true,
  },
  journey: {
    useMaxWidth: true,
  },
  class: {
    useMaxWidth: true,
  },
  state: {
    useMaxWidth: true,
  },
  er: {
    useMaxWidth: true,
  },
  pie: {
    useMaxWidth: true,
  },
  gitGraph: {
    useMaxWidth: true,
  },
})
import {
  SelectPublicMessage,
  Citation,
  ImageCitation,
  MessageFeedback,
  // Apps,
  // DriveEntity,
} from "shared/types"
import logo from "@/assets/logo.svg"
import Expand from "@/assets/expand.svg"
import Retry from "@/assets/retry.svg"
import { PublicUser, PublicWorkspace } from "shared/types"
import { z } from "zod"
import { getIcon } from "@/lib/common"
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
import { splitGroupedCitationsWithSpaces } from "@/lib/utils"
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { EnhancedReasoning } from "@/components/EnhancedReasoning"
import { Tip } from "@/components/Tooltip"
import { RagTraceVirtualization } from "@/components/RagTraceVirtualization"
import { toast } from "@/hooks/use-toast"
import { ChatBox } from "@/components/ChatBox"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Pill } from "@/components/Pill"
import { CLASS_NAMES } from "@/lib/constants"
import { Reference, ToolsListItem, toolsListItemSchema } from "@/types"
import { useChatStream } from "@/hooks/useChatStream"
import { useChatHistory } from "@/hooks/useChatHistory"
import { parseHighlight } from "@/components/Highlight"
import { ShareModal } from "@/components/ShareModal"

export const THINKING_PLACEHOLDER = "Thinking"

// Utility function to suppress console logs for a specific operation
function suppressLogs<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const originals = ["error", "warn", "log", "info", "debug"].map((k) => [
    k,
    (console as any)[k],
  ])
  originals.forEach(([k]) => ((console as any)[k] = () => {}))
  try {
    const result = fn()
    if (result instanceof Promise) {
      return result.finally(() => {
        originals.forEach(([k, v]) => ((console as any)[k] = v))
      })
    } else {
      originals.forEach(([k, v]) => ((console as any)[k] = v))
      return result
    }
  } catch (error) {
    originals.forEach(([k, v]) => ((console as any)[k] = v))
    throw error
  }
}

// Extract table components to avoid duplication
const createTableComponents = () => ({
  table: ({ node, ...props }: any) => (
    <div className="overflow-x-auto max-w-full my-2">
      <table
        style={{
          borderCollapse: "collapse",
          borderStyle: "hidden",
          tableLayout: "auto",
          minWidth: "100%",
          maxWidth: "none",
        }}
        className="w-auto dark:bg-slate-800"
        {...props}
      />
    </div>
  ),
  th: ({ node, ...props }: any) => (
    <th
      style={{
        border: "none",
        padding: "8px 12px",
        textAlign: "left",
        overflowWrap: "break-word",
        wordBreak: "break-word",
        maxWidth: "300px",
        minWidth: "100px",
        whiteSpace: "normal",
      }}
      className="dark:text-white font-semibold"
      {...props}
    />
  ),
  td: ({ node, ...props }: any) => (
    <td
      style={{
        border: "none",
        padding: "8px 12px",
        overflowWrap: "break-word",
        wordBreak: "break-word",
        maxWidth: "300px",
        minWidth: "100px",
        whiteSpace: "normal",
      }}
      className="border-t border-gray-100 dark:border-gray-800 dark:text-white"
      {...props}
    />
  ),
  tr: ({ node, ...props }: any) => (
    <tr
      style={{ border: "none" }}
      className="bg-white dark:bg-[#1E1E1E]"
      {...props}
    />
  ),
})

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
type ParsedMessagePart =
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
const jsonToHtmlMessage = (jsonString: string): string => {
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

const REASONING_STATE_KEY = "isReasoningGlobalState"
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
    sources,
    imageCitations,
    citationMap,
    isStreaming,
    messageId: streamInfoMessageId,
    startStream,
    stopStream,
    retryMessage,
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

  // Create a current streaming response for compatibility with existing UI,
  // merging the real stream IDs once available
  const currentResp = isStreaming
    ? {
        resp: partial,
        thinking,
        sources,
        imageCitations,
        citationMap,
        messageId: streamInfoMessageId,
        chatId,
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
  const [userHasScrolled, setUserHasScrolled] = useState(false)
  const [dots, setDots] = useState("")
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
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [isReasoningActive, setIsReasoningActive] = useState(() => {
    const storedValue = localStorage.getItem(REASONING_STATE_KEY)
    return storedValue ? JSON.parse(storedValue) : true
  })

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
    localStorage.setItem(REASONING_STATE_KEY, JSON.stringify(isReasoningActive))
  }, [isReasoningActive])
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

  // Handle initial data loading and feedbackMap initialization
  useEffect(() => {
    if (!hasHandledQueryParam.current || isWithChatId) {
      // Data will be loaded via useChatHistory hook
    }

    setChatTitle(isWithChatId ? data?.chat?.title || null : null)
    setBookmark(isWithChatId ? !!data?.chat?.isBookmarked || false : false)

    // Populate feedbackMap from loaded messages
    if (data?.messages) {
      const initialFeedbackMap: Record<string, MessageFeedback | null> = {}
      data.messages.forEach((msg: SelectPublicMessage) => {
        if (msg.externalId && msg.feedback !== undefined) {
          // msg.feedback can be null
          initialFeedbackMap[msg.externalId] =
            msg.feedback as MessageFeedback | null
        }
      })
      setFeedbackMap(initialFeedbackMap)
    }

    inputRef.current?.focus()
    setShowSources(false)
    setCurrentCitations([])
    setCurrentMessageId(null)
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

      if (typeof chatParams.reasoning === "boolean") {
        setIsReasoningActive(chatParams.reasoning)
      }

      // Call handleSend, passing agentId from chatParams if available
      handleSend(
        messageToSend,
        sourcesArray,
        chatParams.agentId,
        chatParams.toolsList,
        chatParams.fileIds,
      )
      hasHandledQueryParam.current = true
      router.navigate({
        to: "/chat",
        search: (prev) => ({
          ...prev,
          q: undefined,
          reasoning: undefined,
          sources: undefined,
          agentId: undefined, // Clear agentId from URL after processing
          toolsList: undefined, // Clear toolsList from URL after processing
          fileIds: undefined, // Clear fileIds from URL after processing
        }),
        replace: true,
      })
    }
  }, [
    chatParams.q,
    chatParams.reasoning,
    chatParams.sources,
    chatParams.agentId,
    chatParams.toolsList,
    chatParams.fileIds,
    router,
  ])

  const handleSend = async (
    messageToSend: string,
    selectedSources: string[] = [],
    agentIdFromChatBox?: string | null,
    toolsList?: ToolsListItem[],
    fileIds?: string[],
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
        selectedSources,
        isReasoningActive,
        isAgenticMode,
        agentIdToUse,
        toolsList,
        fileIds,
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

    setFeedbackMap((prev) => {
      const currentFeedback = prev[messageId]
      return {
        ...prev,
        [messageId]: currentFeedback === feedback ? null : feedback, // Toggle if same, else set new
      }
    })

    try {
      const currentFeedbackInState = feedbackMap[messageId]
      const newFeedbackStatus =
        currentFeedbackInState === feedback ? null : feedback

      await api.message.feedback.$post({
        json: { messageId, feedback: newFeedbackStatus },
      })
      toast({ title: "Success", description: "Feedback submitted." })
    } catch (error) {
      console.error("Failed to submit feedback", error)
      setFeedbackMap((prev) => {
        // Get the current state after optimistic update
        const currentState = prev[messageId]
        const originalFeedback =
          currentState === null
            ? feedback
            : currentState === feedback
              ? feedbackMap[messageId]
              : null
        return { ...prev, [messageId]: originalFeedback }
      })
      toast({
        title: "Error",
        description: "Could not submit feedback.",
        variant: "destructive",
      })
    }
  }

  const handleRetry = async (messageId: string) => {
    if (!messageId || isStreaming) return
    await retryMessage(messageId, isReasoningActive, isAgenticMode)
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

  const isScrolledToBottom = () => {
    const container = messagesContainerRef.current
    if (!container) return true

    const threshold = 100
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <
      threshold
    )
  }

  const handleScroll = () => {
    const isAtBottom = isScrolledToBottom()
    setUserHasScrolled(!isAtBottom)
  }

  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container || userHasScrolled) return

    container.scrollTop = container.scrollHeight
  }, [messages, partial])

  if ((data?.error || historyLoading) && !isSharedChat) {
    return (
      <div className="h-full w-full flex flex-col bg-white">
        <Sidebar isAgentMode={agentWhiteList} />
        <div className="ml-[120px]">Error: Could not get data</div>
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
          className={`flex w-full fixed bg-white dark:bg-[#1E1E1E] h-[48px] border-b-[1px] border-[#E6EBF5] dark:border-gray-700 justify-center  transition-all duration-250 z-10 ${showSources ? "pr-[18%]" : ""}`}
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
              <span className="flex-grow text-[#1C1D1F] dark:text-gray-100 text-[16px] font-normal overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                {chatTitle}
              </span>
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

        <div
          className={`h-full w-full flex items-end overflow-y-auto justify-center transition-all duration-250 ${showSources ? "pr-[18%]" : ""}`}
          ref={messagesContainerRef}
          onScroll={handleScroll}
        >
          <div className={`w-full h-full flex flex-col items-center`}>
            <div className="flex flex-col w-full  max-w-3xl flex-grow mb-[60px] mt-[56px]">
              {messages.map((message: SelectPublicMessage, index: number) => {
                const isSourcesVisible =
                  showSources && currentMessageId === message.externalId
                const userMessageWithErr =
                  message.messageRole === "user" && message?.errorMessage

                return (
                  <Fragment key={message.externalId ?? index}>
                    <ChatMessage
                      key={
                        message.externalId
                          ? `${message.externalId}-msg`
                          : `msg-${index}`
                      }
                      message={message.message}
                      isUser={message.messageRole === "user"}
                      responseDone={true}
                      thinking={message.thinking}
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
                        }
                      }}
                      sourcesVisible={isSourcesVisible}
                      isStreaming={isStreaming}
                      isDebugMode={isDebugMode}
                      onShowRagTrace={handleShowRagTrace}
                      feedbackStatus={feedbackMap[message.externalId!] || null}
                      onFeedback={!isSharedChat ? handleFeedback : undefined}
                      onShare={!isSharedChat ? handleShare : undefined}
                      disableRetry={disableRetry}
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
                        isUser={false}
                        responseDone={true}
                        citations={message.sources}
                        imageCitations={message.imageCitation || []}
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
                        onShare={!isSharedChat ? handleShare : undefined}
                        disableRetry={disableRetry}
                      />
                    )}
                  </Fragment>
                )
              })}
              {currentResp && (
                <ChatMessage
                  message={currentResp.resp}
                  citations={currentResp.sources}
                  imageCitations={currentResp.imageCitations}
                  thinking={currentResp.thinking || ""}
                  isUser={false}
                  responseDone={false}
                  handleRetry={handleRetry}
                  dots={dots}
                  messageId={currentResp.messageId}
                  citationMap={currentResp.citationMap}
                  onToggleSources={() => {
                    if (
                      showSources &&
                      currentMessageId === currentResp.messageId
                    ) {
                      setShowSources(false)
                      setCurrentCitations([])
                      setCurrentMessageId(null)
                    } else {
                      setCurrentCitations(currentResp.sources || [])
                      setShowSources(true)
                      setCurrentMessageId(currentResp.messageId || null)
                    }
                  }}
                  sourcesVisible={
                    showSources && currentMessageId === currentResp.messageId
                  }
                  isStreaming={isStreaming}
                  isDebugMode={isDebugMode}
                  onShowRagTrace={handleShowRagTrace}
                  // Feedback not applicable for streaming response, but props are needed
                  feedbackStatus={null}
                  onFeedback={!isSharedChat ? handleFeedback : undefined}
                  onShare={!isSharedChat ? handleShare : undefined}
                  disableRetry={disableRetry}
                />
              )}
            </div>
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
            {!isSharedChat && (
              <div className="sticky bottom-0 w-full flex justify-center bg-white dark:bg-[#1E1E1E] pt-2">
                <ChatBox
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
                  isReasoningActive={isReasoningActive}
                  setIsReasoningActive={setIsReasoningActive}
                  user={user} // Pass user prop
                />
              </div>
            )}
          </div>
          <Sources
            showSources={showSources}
            citations={currentCitations}
            closeSources={() => {
              setShowSources(false)
              setCurrentCitations([])
              setCurrentMessageId(null)
            }}
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
    </div>
  )
}

const MessageCitationList = ({
  citations,
  onToggleSources,
}: {
  citations: Citation[]
  onToggleSources: () => void
}) => {
  return (
    <TooltipProvider>
      <ul className={`flex flex-row mt-[24px]`}>
        {citations.map((citation: Citation, index: number) => (
          <li
            key={index}
            className="border-[#E6EBF5] dark:border-gray-700 border-[1px] rounded-[10px] w-[196px] mr-[6px]"
          >
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              title={citation.title}
            >
              <div className="flex pl-[12px] pt-[10px] pr-[12px]">
                <div className="flex flex-col w-full">
                  <p className="line-clamp-2 text-[13px] tracking-[0.01em] leading-[17px] text-ellipsis font-medium break-all dark:text-gray-100">
                    {citation.title ? parseHighlight(citation.title) : ""}
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
                      <span
                        className="flex ml-auto items-center p-[5px] h-[16px] bg-[#EBEEF5] dark:bg-slate-700 dark:text-gray-300 mt-[3px] rounded-full text-[9px]"
                        style={{ fontFamily: "JetBrains Mono" }}
                      >
                        {index + 1}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </a>
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

const CitationList = ({ citations }: { citations: Citation[] }) => {
  return (
    <ul className={`mt-2`}>
      {citations.map((citation: Citation, index: number) => (
        <li
          key={index}
          className="border-[#E6EBF5] dark:border-gray-700 border-[1px] rounded-[10px] mt-[12px] w-[85%]"
        >
          <a
            href={citation.url}
            target="_blank"
            rel="noopener noreferrer"
            title={citation.title}
          >
            <div className="flex pl-[12px] pt-[12px]">
              <a
                target="_blank"
                rel="noopener noreferrer"
                title={citation.title}
                href={citation.url}
                className="flex items-center p-[5px] h-[16px] bg-[#EBEEF5] dark:bg-slate-700 dark:text-gray-300 rounded-full text-[9px] mr-[8px]"
                style={{ fontFamily: "JetBrains Mono" }}
              >
                {index + 1}
              </a>
              <div className="flex flex-col mr-[12px]">
                <span className="line-clamp-2 text-[13px] tracking-[0.01em] leading-[17px] text-ellipsis font-medium break-all dark:text-gray-100">
                  {citation.title ? parseHighlight(citation.title) : ""}
                </span>
                <div className="flex items-center pb-[12px] mt-[8px]">
                  {getIcon(citation.app, citation.entity)}
                  <span className="text-[#848DA1] dark:text-gray-400 text-[13px] tracking-[0.01em] leading-[16px]">
                    {getName(citation.app, citation.entity)}
                  </span>
                </div>
              </div>
            </div>
          </a>
        </li>
      ))}
    </ul>
  )
}

const Sources = ({
  showSources,
  citations,
  closeSources,
}: {
  showSources: boolean
  citations: Citation[]
  closeSources: () => void
}) => {
  return showSources ? (
    <div className="fixed top-[48px] right-0 bottom-0 w-1/4 border-l-[1px] border-[#E6EBF5] dark:border-gray-700 bg-white dark:bg-[#1E1E1E] flex flex-col">
      <div className="flex items-center px-[40px] py-[24px] border-b-[1px] border-[#E6EBF5] dark:border-gray-700">
        <span
          className="text-[#929FBA] dark:text-gray-400 font-normal text-[12px] tracking-[0.08em]"
          style={{ fontFamily: "JetBrains Mono" }}
        >
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
        <CitationList citations={citations} />
      </div>
    </div>
  ) : null
}

// Image Citation Component
interface ImageCitationComponentProps {
  citationKey: string
  imageCitations: ImageCitation[]
  className?: string
}

const ImageCitationComponent: React.FC<ImageCitationComponentProps> = ({
  citationKey,
  imageCitations,
  className = "",
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const imageCitation = imageCitations.find(
    (ic) => ic.citationKey === citationKey,
  )

  if (!imageCitation) {
    return (
      <span className="text-blue-600 dark:text-blue-400">[{citationKey}]</span>
    )
  }

  const imageSrc = `data:${imageCitation.mimeType};base64,${imageCitation.imageData}`

  const ImageModal = () => {
    const handleCloseModal = () => {
      setIsModalOpen(false)
    }

    // Handle escape key
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          handleCloseModal()
        }
      }

      if (isModalOpen) {
        document.addEventListener("keydown", handleKeyDown)
        document.body.style.overflow = "hidden"
      }

      return () => {
        document.removeEventListener("keydown", handleKeyDown)
        document.body.style.overflow = "unset"
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

    return (
      <div
        className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center"
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
      </div>
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

export const textToCitationIndex = /\[(\d+)\]/g
export const textToImageCitationIndex = /\[(\d+_\d+)\]/g

const renderMarkdownLink = ({
  node,
  ...linkProps
}: { node?: any; [key: string]: any }) => (
  <a
    {...linkProps}
    target="_blank"
    rel="noopener noreferrer"
    className="text-blue-600 dark:text-blue-400 hover:underline"
  />
)

const randomid = () => parseInt(String(Math.random() * 1e15), 10).toString(36)
const Code = ({
  inline,
  children,
  className,
  ...props
}: {
  inline?: boolean
  children?: React.ReactNode
  className?: string
  node?: any
}) => {
  const demoid = useRef(`dome${randomid()}`)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [containerHeight, setContainerHeight] = useState(600)
  const isMermaid =
    className && /^language-mermaid/.test(className.toLocaleLowerCase())

  // Debug logging for inline code detection
  const codeString =
    typeof children === "string" ? children : String(children || "")

  let codeContent = ""
  if (props.node && props.node.children && props.node.children.length > 0) {
    codeContent = getCodeString(props.node.children)
  } else if (typeof children === "string") {
    codeContent = children
  } else if (
    Array.isArray(children) &&
    children.length > 0 &&
    typeof children[0] === "string"
  ) {
    // Fallback for cases where children might still be an array with a single string
    codeContent = children[0]
  }

  // State for managing mermaid validation and rendering
  const [lastValidMermaid, setLastValidMermaid] = useState<string>("")
  const mermaidRenderTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Function to validate if mermaid syntax looks complete
  const isMermaidSyntaxValid = async (code: string): Promise<boolean> => {
    if (!code || code.trim() === "") return false

    const trimmedCode = code.trim()

    const mermaidPatterns = [
      /^graph\s+(TD|TB|BT|RL|LR)\s*\n/i,
      /^flowchart\s+(TD|TB|BT|RL|LR)\s*\n/i,
      /^sequenceDiagram\s*\n/i,
      /^classDiagram\s*\n/i,
      /^stateDiagram\s*\n/i,
      /^stateDiagram-v2\s*\n/i,
      /^erDiagram\s*\n/i,
      /^journey\s*\n/i,
      /^gantt\s*\n/i,
      /^pie\s*\n/i,
      /^gitgraph\s*\n/i,
      /^mindmap\s*\n/i,
      /^timeline\s*\n/i,

      // Additional or experimental diagram types
      /^zenuml\s*\n/i,
      /^quadrantChart\s*\n/i,
      /^requirementDiagram\s*\n/i,
      /^userJourney\s*\n/i,

      // Optional aliasing/loose matching for future compatibility
      /^flowchart\s*\n/i,
      /^graph\s*\n/i,
    ]

    // Check if it starts with a valid mermaid diagram type
    const hasValidStart = mermaidPatterns.some((pattern) =>
      pattern.test(trimmedCode),
    )
    if (!hasValidStart) return false

    // Try to parse with mermaid to validate syntax
    try {
      // Use scoped console suppression to avoid global hijacking
      return await suppressLogs(async () => {
        await mermaid.parse(trimmedCode)
        return true
      })
    } catch (error) {
      // Invalid syntax
      return false
    }
  }

  // Debounced function to validate and render mermaid
  const debouncedMermaidRender = useCallback(
    async (code: string) => {
      if (!container || !isMermaid) return

      // Clear any existing timeout
      if (mermaidRenderTimeoutRef.current) {
        clearTimeout(mermaidRenderTimeoutRef.current)
      }

      // If code is empty, clear the container
      if (!code || code.trim() === "") {
        container.innerHTML = ""
        setLastValidMermaid("")
        return
      }

      // Check if syntax looks valid (async now)
      const isValid = await isMermaidSyntaxValid(code)
      if (!isValid) {
        // If we have a previous valid render, keep showing it
        if (lastValidMermaid) {
          return
        } else {
          // Show loading state for incomplete syntax
          container.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: monospace;">
          <div>Mermaid Chart..</div>
          <div style="margin-top: 10px; font-size: 12px;">Streaming mermaid</div>
        </div>`
          return
        }
      }

      // Debounce the actual rendering to avoid too many rapid attempts
      mermaidRenderTimeoutRef.current = setTimeout(async () => {
        try {
          // Additional safety: validate the code before rendering
          if (!code || code.trim().length === 0) {
            container.innerHTML = ""
            setLastValidMermaid("")
            return
          }

          // Sanitize the code to prevent potential issues
          const sanitizedCode = code
            .replace(/javascript:/gi, "") // Remove javascript: protocols
            .replace(/data:/gi, "") // Remove data: protocols
            .replace(/<script[^>]*>.*?<\/script>/gis, "") // Remove script tags
            .trim()

          if (!sanitizedCode) {
            container.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: monospace;">
            <div>📊 Mermaid Diagram</div>
            <div style="margin-top: 10px; font-size: 12px; color: #999;">Invalid diagram content</div>
          </div>`
            return
          }

          // Use scoped console suppression during rendering
          try {
            await suppressLogs(async () => {
              // Render with additional error boundary
              const { svg } = await mermaid.render(
                demoid.current,
                sanitizedCode,
              )

              // Validate that we got valid SVG
              if (!svg || !svg.includes("<svg")) {
                throw new Error("Invalid SVG generated")
              }

              container.innerHTML = svg
              setLastValidMermaid(sanitizedCode)
            })
          } catch (error: any) {
            // Completely suppress all error details from users

            // Always gracefully handle any mermaid errors by either:
            // 1. Keeping the last valid diagram if we have one
            // 2. Showing a loading/placeholder state if no valid diagram exists
            // 3. Never showing syntax error messages to users

            if (lastValidMermaid) {
              // Keep showing the last valid diagram - don't change anything
              return
            } else {
              // Show a generic processing state instead of error details
              container.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: monospace;">
              <div>📊 Mermaid Diagram</div>
              <div style="margin-top: 10px; font-size: 12px; color: #999;">Processing diagram content...</div>
            </div>`
            }
          }
        } catch (outerError: any) {
          // Final fallback error handling
          container.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: monospace;">
          <div>📊 Mermaid Diagram</div>
          <div style="margin-top: 10px; font-size: 12px; color: #999;">Unable to render diagram</div>
        </div>`
        }
      }, 300)
    },
    [container, isMermaid, lastValidMermaid],
  )

  useEffect(() => {
    debouncedMermaidRender(codeContent)

    // Cleanup timeout on unmount
    return () => {
      if (mermaidRenderTimeoutRef.current) {
        clearTimeout(mermaidRenderTimeoutRef.current)
      }
    }
  }, [debouncedMermaidRender, codeContent])

  const refElement = useCallback((node: HTMLElement | null) => {
    if (node !== null) {
      setContainer(node)
    }
  }, [])

  const handleFullscreen = () => {
    setIsFullscreen(!isFullscreen)
  }

  const adjustHeight = (delta: number) => {
    setContainerHeight((prev) => Math.max(200, Math.min(1200, prev + delta)))
  }

  const MermaidControls = () => {
    const { zoomIn, zoomOut, resetTransform, centerView } = useControls()
    const buttonBaseClass =
      "bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 p-1.5 shadow-md z-10 transition-colors"
    const iconSize = 12

    const handleResetAndCenter = () => {
      resetTransform()
      // Small delay to ensure reset is complete before centering
      setTimeout(() => {
        centerView()
      }, 10)
    }

    return (
      <div className="absolute top-2 left-2 flex space-x-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        <button
          onClick={() => zoomIn()}
          className={`${buttonBaseClass} rounded-l-md`}
          title="Zoom In"
        >
          <ZoomIn size={iconSize} />
        </button>
        <button
          onClick={() => zoomOut()}
          className={`${buttonBaseClass}`}
          title="Zoom Out"
        >
          <ZoomOut size={iconSize} />
        </button>
        <button
          onClick={handleResetAndCenter}
          className={`${buttonBaseClass}`}
          title="Reset View"
        >
          <RefreshCw size={iconSize} />
        </button>
        <button
          onClick={() => adjustHeight(-100)}
          className={`${buttonBaseClass}`}
          title="Decrease Height"
        >
          <Minus size={iconSize} />
        </button>
        <button
          onClick={() => adjustHeight(100)}
          className={`${buttonBaseClass}`}
          title="Increase Height"
        >
          <Plus size={iconSize} />
        </button>
        <button
          onClick={handleFullscreen}
          className={`${buttonBaseClass} rounded-r-md`}
          title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? (
            <Minimize2 size={iconSize} />
          ) : (
            <Maximize2 size={iconSize} />
          )}
        </button>
      </div>
    )
  }

  if (isMermaid) {
    const containerStyle = isFullscreen
      ? {
          position: "fixed" as const,
          top: 0,
          left: 0,
          width: "100vw",
          height: "100vh",
          backgroundColor: "rgba(113, 109, 109, 0.95)",
          zIndex: 9999,
        }
      : {
          width: "100%",
          height: `${containerHeight}px`,
          minHeight: "200px",
          maxHeight: "1200px",
        }

    // Transform wrapper configuration for different view modes
    const transformConfig = isFullscreen
      ? {
          initialScale: 2,
          minScale: 0.5,
          maxScale: 10,
          limitToBounds: true,
          centerOnInit: true,
          centerZoomedOut: true,
          doubleClick: { disabled: true },
          wheel: { step: 0.1 },
          panning: { velocityDisabled: true },
        }
      : {
          initialScale: 1.5,
          minScale: 0.5,
          maxScale: 7,
          limitToBounds: true,
          centerOnInit: true,
          centerZoomedOut: true,
          doubleClick: { disabled: true },
          wheel: { step: 0.1 },
          panning: { velocityDisabled: true },
        }

    return (
      <div
        className={`group relative mb-6 overflow-hidden ${isFullscreen ? "" : "w-full"}`}
        style={isFullscreen ? containerStyle : undefined}
      >
        <TransformWrapper
          key={`mermaid-transform-${isFullscreen ? "fullscreen" : "normal"}`}
          initialScale={transformConfig.initialScale}
          minScale={transformConfig.minScale}
          maxScale={transformConfig.maxScale}
          limitToBounds={transformConfig.limitToBounds}
          centerOnInit={transformConfig.centerOnInit}
          centerZoomedOut={transformConfig.centerZoomedOut}
          doubleClick={transformConfig.doubleClick}
          wheel={transformConfig.wheel}
          panning={transformConfig.panning}
        >
          <TransformComponent
            wrapperStyle={{
              width: "100%",
              height: isFullscreen ? "100vh" : `${containerHeight}px`,
              cursor: "grab",
              backgroundColor: isFullscreen ? "transparent" : "transparent",
            }}
            contentStyle={{
              width: "100%",
              height: "100%",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <div style={{ display: "inline-block" }}>
              <code id={demoid.current} style={{ display: "none" }} />
              <code
                ref={refElement}
                data-name="mermaid"
                className={`mermaid ${className || ""}`}
                style={{
                  display: "inline-block",
                  backgroundColor: "transparent",
                }}
              />
            </div>
          </TransformComponent>
          <MermaidControls />
        </TransformWrapper>
        {isFullscreen && (
          <button
            onClick={handleFullscreen}
            className="absolute top-4 right-4 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 p-2 rounded-full shadow-lg z-10 transition-colors"
            title="Exit Fullscreen"
          >
            <X size={16} />
          </button>
        )}
      </div>
    )
  }

  // Enhanced inline detection - fallback if inline prop is not set correctly
  const isActuallyInline =
    inline ||
    (!className && !codeString.includes("\n") && codeString.trim().length > 0)

  // For regular code blocks, render as plain text without boxing
  if (!isActuallyInline) {
    return (
      <pre
        className="text-sm block w-full my-2"
        style={{
          fontFamily: "JetBrains Mono, Monaco, Consolas, monospace",
          whiteSpace: "pre-wrap",
          overflowWrap: "break-word",
          wordBreak: "break-word",
          maxWidth: "100%",
          color: "inherit",
          background: "none",
          border: "none",
          padding: 0,
          margin: 0,
        }}
      >
        <code style={{ background: "none", color: "inherit" }}>{children}</code>
      </pre>
    )
  }

  return (
    <code
      className={`${className || ""} font-mono bg-gray-100 dark:bg-gray-800 rounded-md px-2 py-1 text-xs`}
      style={{
        overflowWrap: "break-word",
        wordBreak: "break-word",
        maxWidth: "100%",
        color: "inherit",
        display: "inline",
        fontSize: "0.75rem",
        verticalAlign: "baseline",
      }}
    >
      {children}
    </code>
  )
}

export const ChatMessage = ({
  message,
  thinking,
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
}: {
  message: string
  thinking: string
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
}) => {
  const { theme } = useTheme()
  const [isCopied, setIsCopied] = useState(false)
  const citationUrls = citations?.map((c: Citation) => c.url)
  const processMessage = (text: string) => {
    text = splitGroupedCitationsWithSpaces(text)

    text = text.replace(textToImageCitationIndex, (match, citationKey) => {
      console.log("Found image citation:", match, "key:", citationKey)
      return `![image-citation:${citationKey}](image-citation:${citationKey})`
    })

    if (citationMap) {
      return text.replace(textToCitationIndex, (match, num) => {
        const index = citationMap[num]
        const url = citationUrls[index]
        return typeof index === "number" && url
          ? `[[${index + 1}]](${url})`
          : ""
      })
    } else {
      return text.replace(textToCitationIndex, (match, num) => {
        const url = citationUrls[num - 1]
        return url ? `[[${num}]](${url})` : ""
      })
    }
  }
  return (
    <div
      className={`rounded-[16px] max-w-full min-w-0 ${isUser ? "bg-[#F0F2F4] dark:bg-slate-700 text-[#1C1D1F] dark:text-slate-100 text-[15px] leading-[25px] self-end pt-[14px] pb-[14px] pl-[20px] pr-[20px] break-words overflow-wrap-anywhere" : "text-[#1C1D1F] dark:text-[#F1F3F4] text-[15px] leading-[25px] self-start w-full max-w-full min-w-0"}`}
    >
      {isUser ? (
        <div
          className="break-words overflow-wrap-anywhere word-break-break-all max-w-full min-w-0"
          dangerouslySetInnerHTML={{ __html: jsonToHtmlMessage(message) }}
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
              {thinking && (
                <>
                  <EnhancedReasoning
                    content={thinking}
                    isStreaming={!responseDone}
                    className="mb-4"
                    citations={citations}
                    citationMap={citationMap}
                  />
                  <div className="border-l-2 border-[#E6EBF5] dark:border-gray-700 pl-2 mb-4 text-gray-600 dark:text-gray-400 w-full max-w-full min-w-0">
                    <MarkdownPreview
                      wrapperElement={{
                        "data-color-mode": theme,
                      }}
                      style={{
                        padding: 0,
                        backgroundColor: "transparent",
                        color: theme === "dark" ? "#A0AEC0" : "#627384",
                        maxWidth: "100%",
                        overflowWrap: "break-word",
                        wordBreak: "break-word",
                        minWidth: 0,
                      }}
                      components={{
                        a: renderMarkdownLink,
                        code: Code,
                        ...createTableComponents(), // Use extracted table components
                      }}
                    />
                  </div>
                </>
              )}
              {message === "" && (!responseDone || isRetrying) ? (
                <div className="flex-grow text-[#1C1D1F] dark:text-[#F1F3F4]">
                  {`${THINKING_PLACEHOLDER}${dots}`}
                </div>
              ) : message !== "" ? (
                <MarkdownPreview
                  source={processMessage(message)}
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
                    a: renderMarkdownLink,
                    code: Code,
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
          {responseDone && !isRetrying && (
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
                    navigator.clipboard.writeText(processMessage(message))
                  }
                />
                <img
                  className={`ml-[18px] ${disableRetry || !messageId ? "opacity-50" : "cursor-pointer"}`}
                  src={Retry}
                  onClick={() =>
                    messageId && !disableRetry && handleRetry(messageId)
                  }
                  title="Retry"
                />
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
                      <span
                        className="font-light ml-[4px] select-none leading-[14px] tracking-[0.02em] text-[12px] text-[#9EAEBE]"
                        style={{ fontFamily: "JetBrains Mono" }}
                      >
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
                />
              </div>
            </div>
          )}
        </div>
      )}
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
  reasoning: z.boolean().optional(),
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
  fileIds: z.array(z.string()).optional(),
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
      <ChatPage
        user={user}
        workspace={workspace}
        agentWhiteList={agentWhiteList}
      />
    )
  },
  errorComponent: errorComponent,
})
