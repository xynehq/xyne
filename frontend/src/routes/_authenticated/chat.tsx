import MarkdownPreview from "@uiw/react-markdown-preview"
import { api } from "@/api"
import { Sidebar } from "@/components/Sidebar"
import {
  createFileRoute,
  useLoaderData,
  useRouter,
  useRouterState,
  useSearch,
} from "@tanstack/react-router"
import { Bookmark, Copy, Ellipsis, Pencil, X, ChevronDown } from "lucide-react"
import { useEffect, useRef, useState, Fragment } from "react"
import {
  ChatSSEvents,
  SelectPublicMessage,
  Citation,
  // Apps,
  // DriveEntity,
} from "shared/types"
import AssistantLogo from "@/assets/assistant-logo.svg"
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
import { fetchChats, pageSize, renameChat } from "@/components/HistoryModal"
import { errorComponent } from "@/components/error"
import { splitGroupedCitationsWithSpaces } from "@/lib/utils"
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Tip } from "@/components/Tooltip"
import { RagTraceVirtualization } from "@/components/RagTraceVirtualization"
import { toast } from "@/hooks/use-toast"
import { ChatBox } from "@/components/ChatBox"
// Removed duplicate Citation import here

// Define Reference type (matching ChatBox)
interface Reference {
  id: string
  title: string
  url?: string
  docId?: string
  app?: string
  entity?: string
  type: "citation" | "global"
  photoLink?: string
}

type CurrentResp = {
  resp: string
  chatId?: string
  messageId?: string
  sources?: Citation[]
  citationMap?: Record<number, number>
  thinking?: string
}

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
}

const REASONING_STATE_KEY = "isReasoningGlobalState";

export const ChatPage = ({ user, workspace }: ChatPageProps) => {
  const params = Route.useParams()
  const router = useRouter()
  const chatParams: XyneChat = useSearch({
    from: "/_authenticated/chat",
  })
  const isGlobalDebugMode = import.meta.env.VITE_SHOW_DEBUG_INFO === "true"
  const isDebugMode = isGlobalDebugMode || chatParams.debug

  const isWithChatId = !!(params as any).chatId
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
      search: !isGlobalDebugMode ? { debug: isDebugMode } : {},
    })
  }
  const hasHandledQueryParam = useRef(false)

  const [query, setQuery] = useState("")
  const [messages, setMessages] = useState<SelectPublicMessage[]>(
    isWithChatId ? data?.messages || [] : [],
  )
  const [chatId, setChatId] = useState<string | null>(
    (params as any).chatId || null,
  )
  const [chatTitle, setChatTitle] = useState<string | null>(
    isWithChatId && data ? data?.chat?.title || null : null,
  )
  const [currentResp, setCurrentResp] = useState<CurrentResp | null>(null)
  const [showRagTrace, setShowRagTrace] = useState(false) // Added state
  const [stopMsg, setStopMsg] = useState<boolean>(false)
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    null,
  ) // Added state

  const currentRespRef = useRef<CurrentResp | null>(null)
  const [bookmark, setBookmark] = useState<boolean>(
    isWithChatId ? !!data?.chat?.isBookmarked || false : false,
  )
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const [userHasScrolled, setUserHasScrolled] = useState(false)
  const [dots, setDots] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [currentCitations, setCurrentCitations] = useState<Citation[]>([])
  const [currentMessageId, setCurrentMessageId] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState<boolean>(false)
  const [editedTitle, setEditedTitle] = useState<string | null>(chatTitle)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const [allCitations, setAllCitations] = useState<Map<string, Citation>>(
    new Map(),
  ) // State for all citations
  const eventSourceRef = useRef<EventSource | null>(null) // Added ref for EventSource
  const [userStopped, setUserStopped] = useState<boolean>(false) // Add state for user stop

  const [isReasoningActive, setIsReasoningActive] = useState(() => {
    const storedValue = localStorage.getItem(REASONING_STATE_KEY)
    return storedValue ? JSON.parse(storedValue) : false
  })

  useEffect(() => {
    localStorage.setItem(REASONING_STATE_KEY, JSON.stringify(isReasoningActive))
  }, [isReasoningActive])

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
    messages.forEach((msg) => {
      if (msg.messageRole === "assistant" && msg.sources) {
        // Add explicit type for citation
        msg.sources.forEach((citation: Citation) => {
          // Use URL as unique key, ensure title exists for display
          if (
            citation.url &&
            citation.title &&
            !newCitations.has(citation.url)
          ) {
            newCitations.set(citation.url, citation)
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
    if (isStreaming) {
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
  }, [isStreaming])

  useEffect(() => {
    if (!hasHandledQueryParam.current || isWithChatId) {
      setMessages(isWithChatId ? data?.messages || [] : [])
    }
    setChatId((params as any).chatId || null)
    setChatTitle(isWithChatId ? data?.chat?.title || null : null)
    setBookmark(isWithChatId ? !!data?.chat?.isBookmarked || false : false)
    if (!isStreaming && !hasHandledQueryParam.current) {
      setCurrentResp(null)
      currentRespRef.current = null
    }
    inputRef.current?.focus()
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

      let refIdArray: string[] = []
      // Process chatParams.refs safely
      const _refs = chatParams.refs as string | string[] | undefined

      if (Array.isArray(_refs)) {
        refIdArray = _refs.filter((ref) => typeof ref === "string")
      } else if (typeof _refs === "string") {
        try {
          const parsedRefs = JSON.parse(_refs)
          if (
            Array.isArray(parsedRefs) &&
            parsedRefs.every((item) => typeof item === "string")
          ) {
            refIdArray = parsedRefs
          }
        } catch (e) {
          console.error("Failed to parse chatParams.refs:", _refs, e)
        }
      }

      const referencesForHandleSend: Reference[] = refIdArray.map((refId) => ({
        id: refId,
        title: `Document: ${refId}`,
        docId: refId,
        type: "global",
      }))

      let sourcesArray: string[] = []
      // Process chatParams.sources safely
      const _sources = chatParams.sources as string | string[] | undefined

      if (Array.isArray(_sources)) {
        sourcesArray = _sources.filter((s) => typeof s === "string")
      } else if (typeof _sources === "string") {
        sourcesArray = _sources
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      }

      // Set reasoning state from URL param if present
      if (typeof chatParams.reasoning === 'boolean') {
        setIsReasoningActive(chatParams.reasoning)
      }

      handleSend(
        messageToSend,
        referencesForHandleSend,
        sourcesArray,
      )
      hasHandledQueryParam.current = true
      router.navigate({
        to: "/chat",
        search: (prev) => ({
          ...prev,
          q: undefined,
          reasoning: undefined,
          refs: undefined,
          sources: undefined,
        }),
        replace: true,
      })
    }
  }, [chatParams.q, chatParams.reasoning, chatParams.refs, chatParams.sources, router])

  const handleSend = async (
    messageToSend: string,
    // isReasoningEnabled?: boolean, // Removed: handleSend will use isReasoningActive state
    addedReferences: Reference[] = [],
    selectedSources: string[] = [],
  ) => {
    if (!messageToSend || isStreaming) return

    // Reset userHasScrolled to false when a new message is sent.
    // This ensures that the view will scroll down automatically as the new message streams in,
    // unless the user manually scrolls up during the streaming.
    setUserHasScrolled(false)
    setQuery("")
    setMessages((prevMessages) => [
      ...prevMessages,
      { messageRole: "user", message: messageToSend },
    ])

    setIsStreaming(true)
    setCurrentResp({ resp: "", thinking: "" })
    currentRespRef.current = { resp: "", sources: [], thinking: "" }

    const fileIds = addedReferences
      .filter((ref) => ref.type === "global" && ref.docId)
      .map((ref) => ref.docId!)

    // const appEntities = selectedSources
    //   .map((sourceId) => sourceIdToAppEntityMap[sourceId])
    //   .filter((item) => item !== undefined)

    const url = new URL(`/api/v1/message/create`, window.location.origin)
    if (chatId) {
      url.searchParams.append("chatId", chatId)
    }
    url.searchParams.append("modelId", "gpt-4o-mini")
    url.searchParams.append("message", encodeURIComponent(messageToSend))

    url.searchParams.append("stringifiedfileIds", JSON.stringify(fileIds))

    // if (appEntities.length > 0) {
    //   url.searchParams.append(
    //     "stringifiedAppEntity",
    //     JSON.stringify(appEntities),
    //   )
    // }
    if(isReasoningActive) {
        url.searchParams.append("isReasoningEnabled", "true")
    }

    eventSourceRef.current = new EventSource(url.toString(), {
      // Store EventSource
      withCredentials: true,
    })

    // ... (rest of the eventSource listeners remain the same) ...
    eventSourceRef.current.addEventListener(
      ChatSSEvents.CitationsUpdate,
      (event) => {
        // Use ref
        const { contextChunks, citationMap } = JSON.parse(event.data)
        if (currentRespRef.current) {
          currentRespRef.current.sources = contextChunks
          currentRespRef.current.citationMap = citationMap
          // Add explicit type for prevResp
          setCurrentResp((prevResp: CurrentResp | null) => ({
            ...(prevResp || { resp: "", thinking: "" }), // Ensure proper default structure
            resp: prevResp?.resp || "",
            sources: contextChunks,
            citationMap,
          }))
        }
      },
    )

    eventSourceRef.current.addEventListener(ChatSSEvents.Reasoning, (event) => {
      setCurrentResp((prevResp: CurrentResp | null) => ({
        ...(prevResp || { resp: "", thinking: event.data || "" }),
        thinking: (prevResp?.thinking || "") + event.data,
      }))
    })

    eventSourceRef.current.addEventListener(ChatSSEvents.Start, (event) => {})

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ResponseUpdate,
      (event) => {
        setCurrentResp((prevResp: CurrentResp | null) => {
          const updatedResp = prevResp
            ? { ...prevResp, resp: prevResp.resp + event.data }
            : { resp: event.data, thinking: "", sources: [], citationMap: {} }
          currentRespRef.current = updatedResp
          return updatedResp
        })
      },
    )

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ResponseMetadata,
      (event) => {
        // Use ref
        const { chatId, messageId } = JSON.parse(event.data)
        setChatId(chatId)
        if (chatId) {
          setTimeout(() => {
            router.navigate({
              to: "/chat/$chatId",
              params: { chatId },
              search: !isGlobalDebugMode ? { debug: isDebugMode } : {},
            })
          }, 1000)

          if (!stopMsg) {
            setStopMsg(true)
          }
        }
        if (messageId) {
          if (currentRespRef.current) {
            setCurrentResp((resp: CurrentResp | null) => {
              const updatedResp = resp || { resp: "", thinking: "" }
              updatedResp.chatId = chatId
              updatedResp.messageId = messageId
              currentRespRef.current = updatedResp
              return updatedResp
            })
          } else {
            setMessages((prevMessages) => {
              const lastMessage = prevMessages[prevMessages.length - 1]
              if (lastMessage.messageRole === "assistant") {
                return [
                  ...prevMessages.slice(0, -1),
                  { ...lastMessage, externalId: messageId },
                ]
              }
              return prevMessages
            })
          }
        }
      },
    )

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ChatTitleUpdate,
      (event) => {
        // Use ref
        setChatTitle(event.data)
      },
    )

    eventSourceRef.current.addEventListener(ChatSSEvents.End, (event) => {
      // Use ref
      const currentResp = currentRespRef.current
      if (currentResp) {
        setMessages((prevMessages) => [
          ...prevMessages,
          {
            messageRole: "assistant",
            message: currentResp.resp,
            externalId: currentResp.messageId,
            sources: currentResp.sources,
            citationMap: currentResp.citationMap,
            thinking: currentResp.thinking,
          },
        ])
      }
      setCurrentResp(null)
      currentRespRef.current = null
      eventSourceRef.current?.close() // Use ref
      eventSourceRef.current = null // Clear ref
      setStopMsg(false)
      setIsStreaming(false)
    })

    eventSourceRef.current.addEventListener(ChatSSEvents.Error, (event) => {
      // Use ref
      console.error("Error with SSE:", event.data)
      const currentResp = currentRespRef.current
      if (currentResp) {
        setMessages((prevMessages) => [
          ...prevMessages,
          {
            messageRole: "assistant",
            message: `${event.data}`,
            externalId: currentResp.messageId,
            sources: currentResp.sources,
            citationMap: currentResp.citationMap,
            thinking: currentResp.thinking,
          },
        ])
      }
      setCurrentResp(null)
      currentRespRef.current = null
      eventSourceRef.current?.close() // Use ref
      eventSourceRef.current = null // Clear ref
      setStopMsg(false)
      setIsStreaming(false)
    })

    eventSourceRef.current.onerror = (error) => {
      // Use ref
      // Check if the stop was intentional
      if (userStopped) {
        setUserStopped(false) // Reset the flag
        // Clean up state, similar to handleStop or End event
        setCurrentResp(null)
        currentRespRef.current = null
        setStopMsg(false)
        setIsStreaming(false)
        // Close again just in case, and clear ref
        eventSourceRef.current?.close()
        eventSourceRef.current = null
        // Do NOT add an error message in this case
        return
      }

      // If it wasn't a user stop, proceed with error handling as before
      console.error("Error with SSE:", error)
      const currentResp = currentRespRef.current
      if (currentResp) {
        setMessages((prevMessages) => [
          ...prevMessages,
          {
            messageRole: "assistant",
            message: `Error occurred: please try again`,
          },
        ])
      }
      setCurrentResp(null)
      currentRespRef.current = null
      eventSourceRef.current?.close() // Use ref
      eventSourceRef.current = null // Clear ref
      setStopMsg(false)
      setIsStreaming(false)
    }

    setQuery("")
  }

  const handleStop = async () => {
    setUserStopped(true) // Indicate intentional stop before closing

    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null // Clear the ref
    }

    setIsStreaming(false)

    // 4. Attempt to send stop request to backend if IDs are available
    if (chatId && isStreaming) {
      // This `isStreaming` check might be redundant now, but let's keep it for safety
      try {
        await api.chat.stop.$post({
          json: {
            chatId: chatId,
          },
        })
      } catch (error) {
        console.error("Failed to send stop request to backend:", error)
        toast({
          title: "Error",
          description: "Could not stop streaming.",
          variant: "destructive",
          duration: 1000,
        })
        // Backend stop failed, but client-side is already stopped
      }
    }

    // 5. Add partial response to messages if available
    if (currentRespRef.current && currentRespRef.current.resp) {
      // Use currentRespRef.current directly
      setMessages((prevMessages) => [
        ...prevMessages,
        {
          messageRole: "assistant",
          message: currentRespRef.current?.resp || " ", // Use currentRespRef.current
          externalId: currentRespRef.current?.messageId, // Use currentRespRef.current
          sources: currentRespRef.current?.sources, // Use currentRespRef.current
          citationMap: currentRespRef.current?.citationMap, // Use currentRespRef.current
          thinking: currentRespRef.current?.thinking, // Use currentRespRef.current
        },
      ])
    }

    // 6. Clear streaming-related state *after* backend request and message handling
    setCurrentResp(null)
    currentRespRef.current = null
    setStopMsg(false)
    // 7. Invalidate router state after a short delay to refetch loader data
    setTimeout(() => {
      router.invalidate()
    }, 1000) // Delay for 500ms
  }

  const handleRetry = async (messageId: string) => {
    if (!messageId || isStreaming) return

    setIsStreaming(true)
    const userMsgWithErr = messages.find(
      (msg) =>
        msg.externalId === messageId &&
        msg.messageRole === "user" &&
        msg.errorMessage,
    )
    setMessages((prevMessages) => {
      if (userMsgWithErr) {
        const updatedMessages = [...prevMessages]
        const index = updatedMessages.findIndex(
          (msg) => msg.externalId === messageId && msg.messageRole === "user",
        )

        if (index !== -1) {
          updatedMessages[index] = {
            ...updatedMessages[index],
            errorMessage: "",
          }
          updatedMessages.splice(index + 1, 0, {
            messageRole: "assistant",
            message: "",
            isRetrying: true,
            thinking: "",
            sources: [],
          })
        }

        return updatedMessages
      } else {
        return prevMessages.map((msg) => {
          if (msg.externalId === messageId && msg.messageRole === "assistant") {
            return {
              ...msg,
              message: "",
              isRetrying: true,
              sources: [],
              thinking: "",
            }
          }
          return msg
        })
      }
    })

    const url = new URL(`/api/v1/message/retry`, window.location.origin)
    url.searchParams.append("messageId", encodeURIComponent(messageId))
    url.searchParams.append("isReasoningEnabled", `${isReasoningActive}`)
    setStopMsg(true) // Ensure stop message can be sent for retries
    eventSourceRef.current = new EventSource(url.toString(), {
      // Store EventSource
      withCredentials: true,
    })

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ResponseUpdate,
      (event) => {
        // Use ref
        if (userMsgWithErr) {
          setMessages((prevMessages) => {
            const index = prevMessages.findIndex(
              (msg) => msg.externalId === messageId,
            )

            if (index === -1 || index + 1 >= prevMessages.length) {
              return prevMessages
            }

            const newMessages = [...prevMessages]
            newMessages[index + 1] = {
              ...newMessages[index + 1],
              message: newMessages[index + 1].message + event.data,
            }

            return newMessages
          })
        } else {
          setMessages((prevMessages) =>
            prevMessages.map((msg) =>
              msg.externalId === messageId && msg.isRetrying
                ? { ...msg, message: msg.message + event.data }
                : msg,
            ),
          )
        }
      },
    )

    eventSourceRef.current.addEventListener(ChatSSEvents.Reasoning, (event) => {
      // Use ref
      if (userMsgWithErr) {
        setMessages((prevMessages) => {
          const index = prevMessages.findIndex(
            (msg) => msg.externalId === messageId,
          )

          if (index === -1 || index + 1 >= prevMessages.length) {
            return prevMessages
          }

          const newMessages = [...prevMessages]
          newMessages[index + 1] = {
            ...newMessages[index + 1],
            thinking: (newMessages[index + 1].thinking || "") + event.data,
          }

          return newMessages
        })
      } else {
        setMessages((prevMessages) =>
          prevMessages.map((msg) =>
            msg.externalId === messageId && msg.isRetrying
              ? { ...msg, thinking: (msg.thinking || "") + event.data }
              : msg,
          ),
        )
      }
    })

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ResponseMetadata,
      (event) => {
        // Use ref
        const userMessage = messages.find(
          (msg) => msg.externalId === messageId && msg.messageRole === "user",
        )
        if (userMessage) {
          const { messageId: newMessageId } = JSON.parse(event.data)

          if (newMessageId) {
            setMessages((prevMessages) => {
              const index = prevMessages.findIndex(
                (msg) => msg.externalId === messageId,
              )

              if (index === -1 || index + 1 >= prevMessages.length) {
                return prevMessages
              }

              const newMessages = [...prevMessages]
              newMessages[index + 1] = {
                ...newMessages[index + 1],
                externalId: newMessageId,
              }
              return newMessages
            })
          }
        }
      },
    )

    eventSourceRef.current.addEventListener(
      ChatSSEvents.CitationsUpdate,
      (event) => {
        // Use ref
        const { contextChunks, citationMap } = JSON.parse(event.data)
        setMessages((prevMessages) => {
          if (userMsgWithErr) {
            const index = prevMessages.findIndex(
              (msg) => msg.externalId === messageId,
            )

            if (index === -1 || index + 1 >= prevMessages.length) {
              return prevMessages
            }

            const newMessages = [...prevMessages]

            if (newMessages[index + 1].isRetrying) {
              newMessages[index + 1] = {
                ...newMessages[index + 1],
                sources: contextChunks,
                citationMap,
              }
            }

            return newMessages
          } else {
            return prevMessages.map((msg) =>
              msg.externalId === messageId && msg.isRetrying
                ? { ...msg, sources: contextChunks, citationMap }
                : msg,
            )
          }
        })
      },
    )

    eventSourceRef.current.addEventListener(ChatSSEvents.End, (event) => {
      // Use ref
      setMessages((prevMessages) => {
        if (userMsgWithErr) {
          const index = prevMessages.findIndex(
            (msg) => msg.externalId === messageId,
          )

          if (index === -1 || index + 1 >= prevMessages.length) {
            return prevMessages
          }

          const newMessages = [...prevMessages]

          if (newMessages[index + 1].isRetrying) {
            newMessages[index + 1] = {
              ...newMessages[index + 1],
              isRetrying: false,
            }
          }

          return newMessages
        } else {
          return prevMessages.map((msg) =>
            msg.externalId === messageId && msg.isRetrying
              ? { ...msg, isRetrying: false }
              : msg,
          )
        }
      })
      eventSourceRef.current?.close() // Use ref
      eventSourceRef.current = null // Clear ref
      setIsStreaming(false)
    })

    eventSourceRef.current.addEventListener(ChatSSEvents.Error, (event) => {
      // Use ref
      console.error("Retry Error with SSE:", event.data)
      setMessages((prevMessages) => {
        if (userMsgWithErr) {
          const index = prevMessages.findIndex(
            (msg) => msg.externalId === messageId,
          )

          if (index === -1 || index + 1 >= prevMessages.length) {
            return prevMessages
          }

          const newMessages = [...prevMessages]

          if (newMessages[index + 1].isRetrying)
            newMessages[index + 1] = {
              ...newMessages[index + 1],
              isRetrying: false,
              message: event.data,
            }

          return newMessages
        } else {
          return prevMessages.map((msg) =>
            msg.externalId === messageId && msg.isRetrying
              ? { ...msg, isRetrying: false, message: event.data }
              : msg,
          )
        }
      })
      eventSourceRef.current?.close() // Use ref
      eventSourceRef.current = null // Clear ref
      setIsStreaming(false)
    })

    eventSourceRef.current.onerror = (error) => {
      // Use ref
      console.error("Retry SSE Error:", error)
      setMessages((prevMessages) => {
        if (userMsgWithErr) {
          const index = prevMessages.findIndex(
            (msg) => msg.externalId === messageId,
          )

          if (index === -1 || index + 1 >= prevMessages.length) {
            return prevMessages
          }

          const newMessages = [...prevMessages]

          newMessages[index + 1] = {
            ...newMessages[index + 1],
            isRetrying: false,
          }

          return newMessages
        } else {
          return prevMessages.map((msg) =>
            msg.isRetrying ? { ...msg, isRetrying: false } : msg,
          )
        }
      })
      eventSourceRef.current?.close() // Use ref
      eventSourceRef.current = null // Clear ref
      setIsStreaming(false)
    }
  }

  const handleBookmark = async () => {
    if (chatId) {
      await api.chat.bookmark.$post({
        json: {
          chatId: chatId,
          bookmark: !bookmark,
        },
      })
      setBookmark(!bookmark)
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
    // Set userHasScrolled to true if the user scrolls up from the bottom.
    // This will prevent the automatic scrolling behavior while the user is manually scrolling.
    setUserHasScrolled(!isAtBottom)
  }

  useEffect(() => {
    const container = messagesContainerRef.current
    // Only scroll to the bottom if the container exists and the user has not manually scrolled up.
    // This prevents the view from jumping to the bottom if the user is trying to read previous messages
    // while a new message is streaming in.
    if (!container || userHasScrolled) return

    container.scrollTop = container.scrollHeight
  }, [messages, currentResp?.resp])

  if (data?.error) {
    return (
      <div className="h-full w-full flex flex-col bg-white">
        <Sidebar />
        <div className="ml-[120px]">Error: Could not get data</div>
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
    if (chatId && messageId) {
      window.open(`/trace/${chatId}/${messageId}`, "_blank")
    }
  }

  return (
    <div className="h-full w-full flex flex-row bg-white">
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} />
      <div className="h-full w-full flex flex-col relative">
        <div
          className={`flex w-full fixed bg-white h-[48px] border-b-[1px] border-[#E6EBF5] justify-center  transition-all duration-250 ${showSources ? "pr-[18%]" : ""}`}
        >
          <div className={`flex h-[48px] items-center max-w-3xl w-full`}>
            {isEditing ? (
              <input
                ref={titleRef}
                className="flex-grow text-[#1C1D1F] text-[16px] font-normal overflow-hidden text-ellipsis whitespace-nowrap"
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                value={editedTitle!}
              />
            ) : (
              <span className="flex-grow text-[#1C1D1F] text-[16px] font-normal overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                {chatTitle}
              </span>
            )}
            {chatTitle && (
              <Pencil
                stroke="#4A4F59"
                size={18}
                onClick={handleChatRename}
                className="cursor-pointer"
              />
            )}
            <Bookmark
              {...(bookmark ? { fill: "#4A4F59" } : { outline: "#4A4F59" })}
              className="ml-[20px] cursor-pointer"
              onClick={handleBookmark}
              size={18}
            />
            <Ellipsis stroke="#4A4F59" className="ml-[20px]" size={18} />
          </div>
        </div>

        {/* The onScroll event handler is attached to this div because it's the scrollable container for messages. */}
        {/* This ensures that scroll events are captured correctly to manage the auto-scroll behavior. */}
        <div
          className={`h-full w-full flex items-end overflow-y-auto justify-center transition-all duration-250 ${showSources ? "pr-[18%]" : ""}`}
          ref={messagesContainerRef}
          onScroll={handleScroll}
        >
          <div className={`w-full h-full flex flex-col items-center`}>
            <div className="flex flex-col w-full  max-w-3xl flex-grow mb-[60px] mt-[56px]">
              {messages.map((message, index) => {
                const isSourcesVisible =
                  showSources && currentMessageId === message.externalId
                const userMessageWithErr =
                  message.messageRole === "user" && message?.errorMessage

                return (
                  <Fragment key={message.externalId ?? index}>
                    <ChatMessage
                      key={index}
                      message={message.message}
                      isUser={message.messageRole === "user"}
                      responseDone={true}
                      thinking={message.thinking}
                      citations={message.sources}
                      messageId={message.externalId}
                      handleRetry={handleRetry}
                      citationMap={message.citationMap}
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
                    />
                    {userMessageWithErr && (
                      <ChatMessage
                        message={message.errorMessage}
                        thinking={message.thinking}
                        isUser={false}
                        responseDone={true}
                        citations={message.sources}
                        messageId={message.externalId}
                        handleRetry={handleRetry}
                        citationMap={message.citationMap}
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
                      />
                    )}
                  </Fragment>
                )
              })}
              {currentResp && (
                <ChatMessage
                  message={currentResp.resp}
                  citations={currentResp.sources}
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
                />
              )}
              <div className="absolute bottom-0 left-0 w-full h-[80px] bg-white"></div>
            </div>
            {showRagTrace && chatId && selectedMessageId && (
              <div className="fixed inset-0 z-50 bg-white overflow-auto">
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
            <ChatBox
              query={query}
              setQuery={setQuery}
              handleSend={handleSend} // handleSend function is passed here
              handleStop={handleStop}
              isStreaming={isStreaming}
              allCitations={allCitations}
              chatId={chatId}
              isReasoningActive={isReasoningActive}
              setIsReasoningActive={setIsReasoningActive}
            />
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
            className="border-[#E6EBF5] border-[1px] rounded-[10px] w-[196px] mr-[6px]"
          >
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              title={citation.title}
            >
              <div className="flex pl-[12px] pt-[10px] pr-[12px]">
                <div className="flex flex-col w-full">
                  <p className="line-clamp-2 text-[13px] tracking-[0.01em] leading-[17px] text-ellipsis font-medium">
                    {citation.title}
                  </p>
                  <div className="flex flex-col mt-[9px]">
                    <div className="flex items-center pb-[12px]">
                      {getIcon(citation.app, citation.entity)}
                      <span
                        style={{ fontWeight: 450 }}
                        className="text-[#848DA1] text-[13px] tracking-[0.01em] leading-[16px]"
                      >
                        {getName(citation.app, citation.entity)}
                      </span>
                      <span
                        className="flex ml-auto items-center p-[5px] h-[16px] bg-[#EBEEF5] mt-[3px] rounded-full text-[9px]"
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
          className="border-[#E6EBF5] border-[1px] rounded-[10px] mt-[12px] w-[85%]"
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
                className="flex items-center p-[5px] h-[16px] bg-[#EBEEF5] rounded-full text-[9px] mr-[8px]"
                style={{ fontFamily: "JetBrains Mono" }}
              >
                {index + 1}
              </a>
              <div className="flex flex-col mr-[12px]">
                <span className="line-clamp-2 text-[13px] tracking-[0.01em] leading-[17px] text-ellipsis font-medium">
                  {citation.title}
                </span>
                <div className="flex items-center pb-[12px] mt-[8px]">
                  {getIcon(citation.app, citation.entity)}
                  <span className="text-[#848DA1] text-[13px] tracking-[0.01em] leading-[16px]">
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
    <div className="fixed top-[48px] right-0 bottom-0 w-1/4 border-l-[1px] border-[#E6EBF5] bg-white flex flex-col">
      <div className="flex items-center px-[40px] py-[24px] border-b-[1px] border-[#E6EBF5]">
        <span
          className="text-[#929FBA] font-normal text-[12px] tracking-[0.08em]"
          style={{ fontFamily: "JetBrains Mono" }}
        >
          SOURCES
        </span>
        <X
          stroke="#9EAEBE"
          size={14}
          className="ml-auto cursor-pointer"
          onClick={closeSources}
        />
      </div>
      <div className="flex-1 overflow-y-auto px-[40px] pb-[24px]">
        <CitationList citations={citations} />
      </div>
    </div>
  ) : null
}

export const textToCitationIndex = /\[(\d+)\]/g

const ChatMessage = ({
  message,
  thinking,
  isUser,
  responseDone,
  isRetrying,
  citations = [],
  messageId,
  handleRetry,
  dots = "",
  onToggleSources,
  citationMap,
  sourcesVisible,
  isStreaming = false,
  isDebugMode,
  onShowRagTrace,
}: {
  message: string
  thinking: string
  isUser: boolean
  responseDone: boolean
  isRetrying?: boolean
  citations?: Citation[]
  messageId?: string
  dots: string
  handleRetry: (messageId: string) => void
  onToggleSources: () => void
  citationMap?: Record<number, number>
  sourcesVisible: boolean
  isStreaming?: boolean
  isDebugMode: boolean
  onShowRagTrace: (messageId: string) => void
}) => {
  const [isCopied, setIsCopied] = useState(false)
  const citationUrls = citations?.map((c: Citation) => c.url)

  const processMessage = (text: string) => {
    text = splitGroupedCitationsWithSpaces(text)

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
      className={`rounded-[16px] ${isUser ? "bg-[#F0F2F4] text-[#1C1D1F] text-[15px] leading-[25px] self-end pt-[14px] pb-[14px] pl-[20px] pr-[20px]" : "text-[#1C1D1F] text-[15px] leading-[25px] self-start"}`}
    >
      {isUser ? (
        <div dangerouslySetInnerHTML={{ __html: message }} />
      ) : (
        <div
          className={`flex flex-col mt-[40px] ${citationUrls.length ? "mb-[35px]" : ""}`}
        >
          <div className="flex flex-row">
            <img
              className={"mr-[20px] w-[32px] self-start"}
              src={AssistantLogo}
            />
            <div className="mt-[4px] markdown-content">
              {thinking && (
                <div className="border-l-2 border-[#E6EBF5] pl-2 mb-4 text-gray-600">
                  <MarkdownPreview
                    source={processMessage(thinking)}
                    wrapperElement={{
                      "data-color-mode": "light",
                    }}
                    style={{
                      padding: 0,
                      backgroundColor: "transparent",
                      color: "#627384",
                    }}
                  />
                </div>
              )}
              {message === "" ? (
                <div className="flex-grow">
                  {isRetrying ? `Retrying${dots}` : `Thinking${dots}`}
                </div>
              ) : (
                <MarkdownPreview
                  source={processMessage(message)}
                  wrapperElement={{
                    "data-color-mode": "light",
                  }}
                  style={{
                    padding: 0,
                    backgroundColor: "transparent",
                    color: "#1C1D1F",
                  }}
                  components={{
                    table: ({ node, ...props }) => (
                      <div className="overflow-x-auto w-[720px] my-2">
                        <table
                          style={{
                            borderCollapse: "collapse",
                            borderStyle: "hidden",
                            tableLayout: "fixed",
                            width: "100%",
                          }}
                          className="min-w-full"
                          {...props}
                        />
                      </div>
                    ),
                    th: ({ node, ...props }) => (
                      <th
                        style={{
                          border: "none",
                          padding: "4px 8px",
                          textAlign: "left",
                          overflowWrap: "break-word",
                        }}
                        {...props}
                      />
                    ),
                    td: ({ node, ...props }) => (
                      <td
                        style={{
                          border: "none",
                          borderTop: "1px solid #e5e7eb",
                          padding: "4px 8px",
                          overflowWrap: "break-word",
                        }}
                        {...props}
                      />
                    ),
                    tr: ({ node, ...props }) => (
                      <tr
                        style={{ backgroundColor: "#ffffff", border: "none" }}
                        {...props}
                      />
                    ),
                    h1: ({ node, ...props }) => (
                      <h1 style={{ fontSize: "1.6em" }} {...props} />
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
                  }}
                />
              )}
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
                  className={`ml-[18px] ${isStreaming ? "opacity-50" : "cursor-pointer"}`}
                  src={Retry}
                  onClick={() => handleRetry(messageId!)}
                />
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
        return undefined // Invalid JSON
      }
    }),
  sources: z // Changed from sourceIds to sources, expects comma-separated string
    .string()
    .optional()
    .transform((val) => (val ? val.split(",") : undefined)),
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
    const { user, workspace } = matches[matches.length - 1].context
    return <ChatPage user={user} workspace={workspace} />
  },
  errorComponent: errorComponent,
})