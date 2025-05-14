import MarkdownPreview from "@uiw/react-markdown-preview"
import { MessageMode } from "shared/types"
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
import { useEffect, useRef, useState, Fragment, useMemo } from "react"
import {
  ChatSSEvents,
  SelectPublicMessage,
  Citation,
  AgentReasoningStep,
  AgentReasoningStepType,
  AgentReasoningToolParameters,
  AgentReasoningToolResult,
  // AgentToolName, // Not directly used in ChatPage state logic for now
} from "shared/types" // Import MessageMode and new Agent types
// import { MessageMode } from "shared/types"
import AssistantLogo from "@/assets/assistant-logo.svg"
import Expand from "@/assets/expand.svg"
import Retry from "@/assets/retry.svg"
import { PublicUser, PublicWorkspace } from "shared/types"
import { ChatBox } from "@/components/ChatBox"
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

// Helper function to map database messages to frontend messages
// This function takes raw messages from the database (SelectPublicMessage)
// and transforms them into the format expected by the frontend (FrontendSelectPublicMessage),
// ensuring that 'thinking' is parsed correctly for agentic messages and 'mode' is set appropriately.
const mapDbMessagesToFrontendMessages = (
  dbMessages: SelectPublicMessage[] | undefined | null,
): FrontendSelectPublicMessage[] => {
  if (!dbMessages) {
    return []
  }
  return dbMessages.map((m: SelectPublicMessage) => {
    let finalThinking: string | AgentReasoningStep[] | undefined | null =
      m.thinking
    let finalMode: MessageMode | undefined | null = m.mode

    // Attempt to parse thinking if it's a string that looks like a JSON array (potential agentic steps)
    if (typeof m.thinking === "string" && m.thinking.trim().startsWith("[")) {
      try {
        const parsed = JSON.parse(m.thinking)
        // Check if parsed result is an array and its elements look like AgentReasoningStep objects
        if (
          Array.isArray(parsed) &&
          (parsed.length === 0 ||
            (typeof parsed[0] === "object" &&
              parsed[0] !== null &&
              "type" in parsed[0]))
        ) {
          finalThinking = parsed as AgentReasoningStep[]
          // If we successfully parsed agentic steps, ensure mode is Agentic
          // This handles cases where 'mode' might not have been explicitly set to Agentic in older data
          // but 'thinking' clearly contains agentic steps.
          if (finalMode !== MessageMode.Agentic) {
            finalMode = MessageMode.Agentic
          }
        }
        // If not an array of step-like objects, finalThinking remains the original string, mode remains original.
      } catch (e) {
        // JSON.parse failed. This might happen with malformed or legacy string data.
        // If original mode was Agentic, this is a legacy/error case; wrap the thinking in a LogMessage.
        if (finalMode === MessageMode.Agentic) {
          finalThinking = [
            {
              type: AgentReasoningStepType.LogMessage,
              message: `Legacy agent thinking (parse error on load): ${m.thinking}`,
            },
          ]
        }
        // Otherwise (if mode was not Agentic), finalThinking remains m.thinking (string), and mode remains m.mode.
      }
    } else if (
      finalMode === MessageMode.Agentic &&
      typeof m.thinking === "string"
    ) {
      // Mode is Agentic, but thinking is a string that doesn't look like a JSON array
      // (e.g., simple log string from an older version or a non-JSON string).
      // Wrap it as a LogMessage to be handled by AgenticThinkingRenderer.
      finalThinking = [
        {
          type: AgentReasoningStepType.LogMessage,
          message: `Legacy agent thinking: ${m.thinking}`,
        },
      ]
    }
    // If m.thinking was already AgentReasoningStep[] and m.mode was Agentic, it's processed correctly by the above.
    // If m.thinking was a simple string (not JSON array-like) and m.mode was Ask, it's also handled.

    return {
      ...m,
      mode: finalMode || MessageMode.Ask, // Default to Ask if mode is somehow null/undefined
      thinking: finalThinking,
    } as FrontendSelectPublicMessage
  })
}

type CurrentResp = {
  resp: string
  chatId?: string
  messageId?: string
  sources?: Citation[]
  citationMap?: Record<number, number>
  thinking?: string | AgentReasoningStep[] // Can be string or array of steps
}

// Define a more specific type for messages in the frontend state
type FrontendSelectPublicMessage = Omit<SelectPublicMessage, "thinking"> & {
  thinking?: string | AgentReasoningStep[]
}

interface ChatPageProps {
  user: PublicUser
  workspace: PublicWorkspace
}

export const ChatPage = ({ user, workspace }: ChatPageProps) => {
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
  // Use the new FrontendSelectPublicMessage type for the messages state
  // Initialize messages by processing data from the loader using the helper function.
  const [messages, setMessages] = useState<FrontendSelectPublicMessage[]>(() =>
    mapDbMessagesToFrontendMessages(
      isWithChatId ? (data?.messages as SelectPublicMessage[] | undefined) : [],
    ),
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
  )

  const currentRespRef = useRef<CurrentResp | null>(null)
  const [bookmark, setBookmark] = useState<boolean>(
    isWithChatId ? !!data?.chat?.isBookmarked || false : false,
  )
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  const [userHasScrolled, setUserHasScrolled] = useState(false)
  const [dots, setDots] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [currentCitations, setCurrentCitations] = useState<Citation[]>([])
  const [currentMessageId, setCurrentMessageId] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState<boolean>(false)
  const [editedTitle, setEditedTitle] = useState<string | null>(chatTitle)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null) // Added ref for EventSource
  const [userStopped, setUserStopped] = useState<boolean>(false) // Add state for user stop

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
      }, 300)

      return () => clearInterval(interval)
    } else {
      setDots("")
    }
  }, [isStreaming])

  useEffect(() => {
    if (!hasHandledQueryParam.current || isWithChatId) {
      // When data.messages changes (e.g., navigating to a different chat),
      // re-process them using the same helper function to ensure consistency.
      setMessages(
        isWithChatId
          ? mapDbMessagesToFrontendMessages(
              data?.messages as SelectPublicMessage[] | undefined,
            )
          : [],
      )
    }
    setChatId((params as any).chatId || null)
    setChatTitle(isWithChatId ? data?.chat?.title || null : null)
    setBookmark(isWithChatId ? !!data?.chat?.isBookmarked || false : false)
    if (!isStreaming && !hasHandledQueryParam.current) {
      setCurrentResp(null)
      currentRespRef.current = null
    }
    inputRef.current?.focus()
    setQuery("")
  }, [
    data?.chat?.isBookmarked,
    data?.chat?.title,
    data?.messages,
    isWithChatId,
    params,
  ])

  useEffect(() => {
    if (chatParams.q && !hasHandledQueryParam.current) {
      handleSend(decodeURIComponent(chatParams.q))
      hasHandledQueryParam.current = true
      router.navigate({
        to: "/chat",
        search: (prev) => ({ ...prev, q: undefined }),
        replace: true,
      })
    }
  }, [chatParams.q])

  const handleSend = async (messageToSend: string) => {
    if (!messageToSend || isStreaming) return

    setUserHasScrolled(false)
    setQuery("")
    setMessages((prevMessages) => [
      ...prevMessages,
      {
        messageRole: "user",
        message: messageToSend,
      } as FrontendSelectPublicMessage,
    ])

    setIsStreaming(true)
    const initialThinkingForSend = isAgenticMode ? [] : ""
    setCurrentResp({ resp: "", thinking: initialThinkingForSend })
    currentRespRef.current = {
      resp: "",
      sources: [],
      thinking: initialThinkingForSend,
    }

    const url = new URL(`/api/v1/message/create`, window.location.origin)
    if (chatId) {
      url.searchParams.append("chatId", chatId)
    }
    url.searchParams.append("modelId", "gpt-4o-mini")
    url.searchParams.append("message", encodeURIComponent(messageToSend))

    if (isAgenticMode) {
      url.searchParams.append("agentic", "true")
    }

    eventSourceRef.current = new EventSource(url.toString(), {
      withCredentials: true,
    })

    eventSourceRef.current.addEventListener(
      ChatSSEvents.CitationsUpdate,
      (event) => {
        const { contextChunks, citationMap } = JSON.parse(event.data)
        if (currentRespRef.current) {
          currentRespRef.current.sources = contextChunks
          currentRespRef.current.citationMap = citationMap
          setCurrentResp((prevResp) => ({
            ...prevResp!,
            resp: prevResp?.resp || "",
            sources: contextChunks,
            citationMap,
          }))
        }
      },
    )

    eventSourceRef.current.addEventListener(ChatSSEvents.Reasoning, (event) => {
      if (isAgenticMode) {
        try {
          const reasoningStep = JSON.parse(event.data) as AgentReasoningStep
          setCurrentResp((prevResp) => {
            const currentThinkingArray = (prevResp?.thinking ||
              []) as AgentReasoningStep[]
            return {
              ...(prevResp || { resp: "", thinking: [] }),
              thinking: [...currentThinkingArray, reasoningStep],
            }
          })
          if (currentRespRef.current) {
            const currentThinkingRefArray = (currentRespRef.current.thinking ||
              []) as AgentReasoningStep[]
            currentRespRef.current.thinking = [
              ...currentThinkingRefArray,
              reasoningStep,
            ]
          }
        } catch (e) {
          console.error(
            "Failed to parse agentic reasoning step:",
            e,
            event.data,
          )
          const logStep: AgentReasoningStep = {
            type: AgentReasoningStepType.LogMessage,
            message: `Raw (parse error): ${event.data}`,
          }
          setCurrentResp((prevResp) => {
            const currentThinkingArray = (prevResp?.thinking ||
              []) as AgentReasoningStep[]
            return {
              ...(prevResp || { resp: "", thinking: [] }),
              thinking: [...currentThinkingArray, logStep],
            }
          })
          if (currentRespRef.current) {
            const currentThinkingRefArray = (currentRespRef.current.thinking ||
              []) as AgentReasoningStep[]
            currentRespRef.current.thinking = [
              ...currentThinkingRefArray,
              logStep,
            ]
          }
        }
      } else {
        // Non-agentic mode: append as string
        setCurrentResp((prevResp) => ({
          ...(prevResp || { resp: "", thinking: "" }),
          thinking: ((prevResp?.thinking as string) || "") + event.data,
        }))
        if (currentRespRef.current) {
          currentRespRef.current.thinking =
            ((currentRespRef.current.thinking as string) || "") + event.data
        }
      }
    })

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ResponseUpdate,
      (event) => {
        setCurrentResp((prevResp) => {
          const updatedResp = prevResp
            ? { ...prevResp, resp: prevResp.resp + event.data }
            : { resp: event.data, thinking: isAgenticMode ? [] : "" } // Ensure thinking is initialized
          currentRespRef.current = updatedResp
          return updatedResp
        })
      },
    )

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ResponseMetadata,
      (event) => {
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
            setCurrentResp((resp) => {
              const updatedResp = resp || {
                resp: "",
                thinking: isAgenticMode ? [] : "",
              }
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
                  {
                    ...lastMessage,
                    externalId: messageId,
                  } as FrontendSelectPublicMessage,
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
        setChatTitle(event.data)
      },
    )

    eventSourceRef.current.addEventListener(ChatSSEvents.End, (event) => {
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
            thinking: currentResp.thinking, // This is now string | AgentReasoningStep[]
            mode: isAgenticMode ? MessageMode.Agentic : MessageMode.Ask,
          } as FrontendSelectPublicMessage,
        ])
      }
      setCurrentResp(null)
      currentRespRef.current = null
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      setStopMsg(false)
      setIsStreaming(false)
    })

    eventSourceRef.current.addEventListener(ChatSSEvents.Error, (event) => {
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
            thinking: currentResp.thinking, // This is now string | AgentReasoningStep[]
            mode: isAgenticMode ? MessageMode.Agentic : MessageMode.Ask,
          } as FrontendSelectPublicMessage,
        ])
      }
      setCurrentResp(null)
      currentRespRef.current = null
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      setStopMsg(false)
      setIsStreaming(false)
    })

    eventSourceRef.current.onerror = (error) => {
      if (userStopped) {
        setUserStopped(false)
        setCurrentResp(null)
        currentRespRef.current = null
        setStopMsg(false)
        setIsStreaming(false)
        eventSourceRef.current?.close()
        eventSourceRef.current = null
        return
      }
      console.error("Error with SSE:", error)
      const currentResp = currentRespRef.current
      if (currentResp) {
        setMessages((prevMessages) => [
          ...prevMessages,
          {
            messageRole: "assistant",
            message: `Error occurred: please try again`,
            externalId: currentResp.messageId,
            sources: currentResp.sources,
            citationMap: currentResp.citationMap,
            thinking: currentResp.thinking,
            mode: isAgenticMode ? MessageMode.Agentic : MessageMode.Ask,
          } as FrontendSelectPublicMessage,
        ])
      }
      setCurrentResp(null)
      currentRespRef.current = null
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      setStopMsg(false)
      setIsStreaming(false)
    }

    setQuery("")
  }

  const handleStop = async () => {
    setUserStopped(true)

    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    setIsStreaming(false)

    if (chatId && isStreaming) {
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
      }
    }

    if (currentRespRef.current && currentRespRef.current.resp) {
      setMessages((prevMessages) => [
        ...prevMessages,
        {
          messageRole: "assistant",
          message: currentRespRef.current?.resp || " ",
          externalId: currentRespRef.current?.messageId,
          sources: currentRespRef.current?.sources,
          citationMap: currentRespRef.current?.citationMap,
          thinking: currentRespRef.current?.thinking, // This is now string | AgentReasoningStep[]
          mode: isAgenticMode ? MessageMode.Agentic : MessageMode.Ask,
        } as FrontendSelectPublicMessage,
      ])
    }

    setCurrentResp(null)
    currentRespRef.current = null
    setStopMsg(false)
    setTimeout(() => {
      router.invalidate()
    }, 1000)
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
            thinking: isAgenticMode ? [] : "", // Conditional thinking init
            sources: [],
            mode: isAgenticMode ? MessageMode.Agentic : MessageMode.Ask,
          } as FrontendSelectPublicMessage)
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
              thinking: isAgenticMode ? [] : "", // Conditional thinking init
              mode: isAgenticMode ? MessageMode.Agentic : MessageMode.Ask,
            } as FrontendSelectPublicMessage
          }
          return msg as FrontendSelectPublicMessage
        })
      }
    })

    const url = new URL(`/api/v1/message/retry`, window.location.origin)
    url.searchParams.append("messageId", encodeURIComponent(messageId))

    if (isAgenticMode) {
      url.searchParams.append("agentic", "true")
    }

    setStopMsg(true)
    eventSourceRef.current = new EventSource(url.toString(), {
      withCredentials: true,
    })

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ResponseUpdate,
      (event) => {
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
      let newThinkingForRetry: string | AgentReasoningStep[]
      if (isAgenticMode) {
        try {
          const parsedStep = JSON.parse(event.data) as AgentReasoningStep
          newThinkingForRetry = [parsedStep] // Start with the new step
        } catch (e) {
          console.error(
            "Failed to parse agentic reasoning step during retry:",
            e,
            event.data,
          )
          const logStep: AgentReasoningStep = {
            type: AgentReasoningStepType.LogMessage,
            message: `Raw (parse error during retry): ${event.data}`,
          }
          newThinkingForRetry = [logStep]
        }
      } else {
        newThinkingForRetry = event.data
      }

      if (userMsgWithErr) {
        setMessages((prevMessages) => {
          const index = prevMessages.findIndex(
            (msg) => msg.externalId === messageId,
          )

          if (index === -1 || index + 1 >= prevMessages.length) {
            return prevMessages
          }

          const newMessages = [...prevMessages]
          const existingThinking = newMessages[index + 1].thinking
          if (isAgenticMode) {
            newMessages[index + 1].thinking = Array.isArray(existingThinking)
              ? [
                  ...existingThinking,
                  ...(newThinkingForRetry as AgentReasoningStep[]),
                ]
              : newThinkingForRetry
          } else {
            newMessages[index + 1].thinking =
              (existingThinking || "") + (newThinkingForRetry as string)
          }
          return newMessages
        })
      } else {
        setMessages(
          (prevMessages) =>
            prevMessages.map((msg) => {
              if (msg.externalId === messageId && msg.isRetrying) {
                const existingThinking = msg.thinking
                let updatedThinking: string | AgentReasoningStep[]
                if (isAgenticMode) {
                  updatedThinking = Array.isArray(existingThinking)
                    ? [
                        ...existingThinking,
                        ...(newThinkingForRetry as AgentReasoningStep[]),
                      ]
                    : newThinkingForRetry
                } else {
                  updatedThinking =
                    (existingThinking || "") + (newThinkingForRetry as string)
                }
                return { ...msg, thinking: updatedThinking }
              }
              return msg
            }) as FrontendSelectPublicMessage[],
        )
      }
    })

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ResponseMetadata,
      (event) => {
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
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      setIsStreaming(false)
    })

    eventSourceRef.current.addEventListener(ChatSSEvents.Error, (event) => {
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
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      setIsStreaming(false)
    })

    eventSourceRef.current.onerror = (error) => {
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
      eventSourceRef.current?.close()
      eventSourceRef.current = null
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
    setUserHasScrolled(!isAtBottom)
  }

  useEffect(() => {
    const container = messagesContainerRef.current
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
                      thinking={
                        message.thinking ??
                        (message.mode === MessageMode.Agentic ? [] : "")
                      }
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
                      isStreaming={false}
                      isDebugMode={isDebugMode}
                      onShowRagTrace={handleShowRagTrace}
                      messageMode={message.mode || MessageMode.Ask}
                      isAgenticMode={message.mode === MessageMode.Agentic}
                    />
                    {userMessageWithErr && (
                      <ChatMessage
                        message={message.errorMessage}
                        thinking={
                          message.thinking ??
                          (message.mode === MessageMode.Agentic ? [] : "")
                        }
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
                        isStreaming={false}
                        isDebugMode={isDebugMode}
                        onShowRagTrace={handleShowRagTrace}
                        messageMode={message.mode || MessageMode.Ask}
                        isAgenticMode={message.mode === MessageMode.Agentic}
                      />
                    )}
                  </Fragment>
                )
              })}
              {currentResp && (
                <ChatMessage
                  message={currentResp.resp}
                  citations={currentResp.sources}
                  thinking={currentResp.thinking || (isAgenticMode ? [] : "")} // Ensure correct type
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
                  isStreaming={true}
                  isDebugMode={isDebugMode}
                  onShowRagTrace={handleShowRagTrace}
                  messageMode={
                    isAgenticMode ? MessageMode.Agentic : MessageMode.Ask
                  }
                  isAgenticMode={isAgenticMode}
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
              handleSend={handleSend}
              handleStop={handleStop}
              isStreaming={isStreaming}
              isAgenticMode={isAgenticMode}
              setIsAgenticMode={setIsAgenticMode}
              chatId={chatId}
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
  isStreaming, // Removed default, now required
  isDebugMode,
  onShowRagTrace,
  messageMode, // New required prop
  isAgenticMode = false, // Kept for other potential uses, defaults to false
}: {
  message: string
  thinking: string | AgentReasoningStep[] // Updated prop type
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
  isStreaming: boolean
  isDebugMode: boolean
  onShowRagTrace: (messageId: string) => void
  messageMode: MessageMode
  isAgenticMode?: boolean
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

  // Custom component to render agentic thinking content with better handling of code blocks during streaming
  const AgenticThinkingRenderer = ({
    steps,
  }: { steps: AgentReasoningStep[] }) => {
    return (
      <div className="agentic-thinking">
        {steps.map((step, index) => {
          switch (step.type) {
            case AgentReasoningStepType.AnalyzingQuery:
              return (
                <div key={index} className="text-[#627384] mb-1 mt-2">
                  {step.details}
                </div>
              )
            case AgentReasoningStepType.Iteration:
              return (
                <div
                  key={index}
                  className="text-[#1C1D1F] font-medium mb-2 mt-3"
                >
                  ### Iteration {step.iteration}
                </div>
              )
            case AgentReasoningStepType.Planning:
              return (
                <div key={index} className="text-[#627384] mb-1 mt-2">
                  {step.details}
                </div>
              )
            case AgentReasoningStepType.ToolSelected:
              return (
                <div key={index} className="text-[#627384] mb-1">
                  <span className="font-medium">Tool selected:</span>
                  <span className="inline-block bg-[#F3F5F8] rounded px-1 ml-1 font-mono text-sm">
                    {step.toolName}
                  </span>
                </div>
              )
            case AgentReasoningStepType.ToolParameters:
              const params = step as AgentReasoningToolParameters
              return (
                <div key={index} className="text-[#627384] mb-1">
                  <div className="font-medium">Parameters:</div>
                  <pre className="bg-[#F3F5F8] p-2 rounded text-sm font-mono overflow-x-auto mb-2 language-json">
                    <code>{JSON.stringify(params.parameters, null, 2)}</code>
                  </pre>
                </div>
              )
            case AgentReasoningStepType.ToolExecuting:
              return (
                <div key={index} className="text-[#627384] mb-1 mt-2">
                  Executing tool:{" "}
                  <span className="inline-block bg-[#F3F5F8] rounded px-1 ml-1 font-mono text-sm">
                    {step.toolName}
                  </span>
                  ...
                </div>
              )
            case AgentReasoningStepType.ToolResult:
              const resultStep = step as AgentReasoningToolResult
              return (
                <div key={index} className="text-[#627384] mb-1 mt-2">
                  <div className="font-medium">
                    Tool result ({resultStep.toolName}):
                  </div>
                  <div>{resultStep.resultSummary}</div>
                  {resultStep.itemsFound !== undefined && (
                    <div>(Found {resultStep.itemsFound} item(s))</div>
                  )}
                  {resultStep.error && (
                    <div className="text-red-500">
                      Error: {resultStep.error}
                    </div>
                  )}
                </div>
              )
            case AgentReasoningStepType.Synthesis:
              return (
                <div key={index} className="text-[#627384] mb-1 mt-2">
                  {step.details}
                </div>
              )
            case AgentReasoningStepType.ValidationError:
              return (
                <div key={index} className="text-orange-500 mb-1 mt-2">
                  Validation Error: {step.details}
                </div>
              )
            case AgentReasoningStepType.BroadeningSearch:
              return (
                <div key={index} className="text-blue-500 mb-1 mt-2">
                  Broadening Search: {step.details}
                </div>
              )
            case AgentReasoningStepType.LogMessage:
              if (step.message === "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━") {
                return <hr key={index} className="my-2 border-gray-300" />
              }
              return (
                <div key={index} className="text-[#627384] mb-1">
                  {step.message}
                </div>
              )
            default:
              const _exhaustiveCheck: never = step // Ensures all cases are handled
              return <div key={index}>Unknown step: {JSON.stringify(step)}</div>
          }
        })}
      </div>
    )
  }

  return (
    <div
      className={`rounded-[16px] ${isUser ? "bg-[#F0F2F4] text-[#1C1D1F] text-[15px] leading-[25px] self-end pt-[14px] pb-[14px] pl-[20px] pr-[20px]" : "text-[#1C1D1F] text-[15px] leading-[25px] self-start"}`}
    >
      {isUser ? (
        message
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
                  {messageMode === MessageMode.Agentic &&
                  Array.isArray(thinking) ? (
                    <AgenticThinkingRenderer steps={thinking} />
                  ) : (
                    typeof thinking === "string" &&
                    thinking.length > 0 && (
                      <MarkdownPreview
                        source={processMessage(thinking)} // For 'ask' mode, process for citations
                        wrapperElement={{
                          "data-color-mode": "light",
                        }}
                        style={{
                          padding: 0,
                          backgroundColor: "transparent",
                          color: "#627384",
                        }}
                      />
                    )
                  )}
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
  agentic: z
    .string()
    .transform((val) => val === "true")
    .optional()
    .default("false"),
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
