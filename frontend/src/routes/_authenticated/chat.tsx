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
import { useEffect, useRef, useState } from "react"
import { ChatSSEvents, SelectPublicMessage, Citation } from "shared/types"
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

type CurrentResp = {
  resp: string
  chatId?: string
  messageId?: string
  sources?: Citation[]
  citationMap?: Record<number, number>
  thinking?: string
}

interface ChatPageProps {
  user: PublicUser
  workspace: PublicWorkspace
}

export const ChatPage = ({ user, workspace }: ChatPageProps) => {
  const params = Route.useParams()
  const router = useRouter()
  let chatParams: XyneChat = useSearch({
    from: "/_authenticated/chat",
  })
  const isWithChatId = !!(params as any).chatId
  const data = useLoaderData({
    from: isWithChatId
      ? "/_authenticated/chat/$chatId"
      : "/_authenticated/chat",
  })

  const queryClient = useQueryClient()

  // query and param both can't exist same time
  if (chatParams.q && isWithChatId) {
    router.navigate({
      to: "/chat/$chatId",
      params: { chatId: (params as any).chatId },
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

  const renameChatMutation = useMutation<
    { chatId: string; title: string }, // The type of data returned from the mutation
    Error, // The type of error
    { chatId: string; newTitle: string } // The type of variables passed to the mutation
  >({
    mutationFn: async ({ chatId, newTitle }) => {
      return await renameChat(chatId, newTitle)
    },
    onSuccess: ({ chatId, title }) => {
      // Update the UI by renaming the chat
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

          // Remove the old version from all pages
          const filteredPages = oldData.pages.map((page) =>
            page.filter((c) => c.externalId !== chatId),
          )

          // Insert the updated chat at the front of the first page
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
      // lastPage?.length < pageSize becomes true, when there are no more pages
      if (lastPage?.length < pageSize) {
        return undefined
      }
      // Otherwise, next page = current number of pages fetched so far
      return allPages?.length
    },
    initialPageParam: 0,
  })
  const currentChat = historyItems?.pages
    ?.flat()
    .find((item) => item.externalId === chatId)

  useEffect(() => {
    // Only update local state if we are not currently editing the title
    // This prevents overwriting local edits while user is typing
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
    // Reset the state when the chatId changes
    if (!hasHandledQueryParam.current || isWithChatId) {
      setMessages(isWithChatId ? data?.messages || [] : [])
    }
    setChatId((params as any).chatId || null)
    setChatTitle(isWithChatId ? data?.chat?.title || null : null)
    setBookmark(isWithChatId ? !!data?.chat?.isBookmarked || false : false)
    // only reset explicitly
    // hasHandledQueryParam part was added to prevent conflict between
    // this setting current resp to null and the handleSend trying to show
    // the assistant as thinking when the first message comes from query param
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

  // New useEffect to handle query parameters
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
    if (!messageToSend) return
    // Prevent the user from sending a query if streaming is already in progress.
    if (isStreaming) return

    setQuery("")
    // Append the user's message to the chat
    setMessages((prevMessages) => [
      ...prevMessages,
      { messageRole: "user", message: messageToSend },
    ])

    setIsStreaming(true)
    setCurrentResp({ resp: "", thinking: "" })
    currentRespRef.current = { resp: "", sources: [], thinking: "" }

    const url = new URL(`/api/v1/message/create`, window.location.origin)
    if (chatId) {
      url.searchParams.append("chatId", chatId)
    }
    url.searchParams.append("modelId", "gpt-4o-mini")
    url.searchParams.append("message", encodeURIComponent(messageToSend))

    const eventSource = new EventSource(url.toString(), {
      withCredentials: true,
    })

    eventSource.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
      const { contextChunks, citationMap } = JSON.parse(event.data)
      if (currentRespRef.current) {
        currentRespRef.current.sources = contextChunks
        currentRespRef.current.citationMap = citationMap
        setCurrentResp((prevResp) => ({
          ...prevResp,
          resp: prevResp?.resp || "",
          sources: contextChunks,
          citationMap,
        }))
      }
    })

    eventSource.addEventListener(ChatSSEvents.Reasoning, (event) => {
      setCurrentResp((prevResp) => ({
        ...(prevResp || { resp: "", thinking: event.data || "" }),
        thinking: (prevResp?.thinking || "") + event.data,
      }))
    })

    eventSource.addEventListener(ChatSSEvents.Start, (event) => {})

    eventSource.addEventListener(ChatSSEvents.ResponseUpdate, (event) => {
      setCurrentResp((prevResp) => {
        const updatedResp = prevResp
          ? { ...prevResp, resp: prevResp.resp + event.data }
          : { resp: event.data }
        currentRespRef.current = updatedResp // Update the ref
        return updatedResp
      })
    })

    eventSource.addEventListener(ChatSSEvents.ResponseMetadata, (event) => {
      const { chatId, messageId } = JSON.parse(event.data)
      setChatId(chatId)

      if (chatId) {
        // we are redirecting after 1 second
        // becase the chat may not have actually been created
        // if it's not created and redirect to that url we try to fetch it
        // and on error we redirect back to /chat
        // need to create an event source event on when to navigate
        setTimeout(() => {
          router.navigate({
            to: "/chat/$chatId",
            params: { chatId },
          })
        }, 1000)
      }

      // this will be optional
      if (messageId) {
        // there is a race condition between end and metadata events
        // the message id would not reach and this would prevent the
        // retry of just now streamed message as no message id
        if (currentRespRef.current) {
          setCurrentResp((resp) => {
            const updatedResp = resp || { resp: "" }
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
    })

    eventSource.addEventListener(ChatSSEvents.ChatTitleUpdate, (event) => {
      setChatTitle(event.data)
    })

    eventSource.addEventListener(ChatSSEvents.End, (event) => {
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
      eventSource.close()
      setIsStreaming(false)
    })

    eventSource.addEventListener(ChatSSEvents.Error, (event) => {
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
      eventSource.close()
      setIsStreaming(false)
    })

    // Handle error events
    eventSource.onerror = (error) => {
      console.error("Error with SSE:", error)
      const currentResp = currentRespRef.current
      if (currentResp) {
        setMessages((prevMessages) => [
          ...prevMessages,
          {
            messageRole: "assistant",
            message: `Error occured: please try again`,
          },
        ])
      }
      setCurrentResp(null)
      currentRespRef.current = null
      eventSource.close()
      setIsStreaming(false)
    }

    // Clear the input
    setQuery("")
  }

  const handleRetry = async (messageId: string) => {
    if (!messageId) return
    // Prevent retry if streaming is already happening
    if (isStreaming) return

    setIsStreaming(true) // Start streaming for retry

    // If user retries on error case
    const userMsgWithErr = messages.find(
      (msg) =>
        msg.externalId === messageId &&
        msg.messageRole === "user" &&
        msg.errorMessage,
    )
    // Update the assistant message being retried
    setMessages((prevMessages) => {
      if (userMsgWithErr) {
        // Create a copy of prevMessages so we can modify it
        const updatedMessages = [...prevMessages]
        // Find the index of the message you want to update
        const index = updatedMessages.findIndex(
          (msg) => msg.externalId === messageId && msg.messageRole === "user",
        )

        if (index !== -1) {
          // Update the errorMessage of that specific message
          updatedMessages[index] = {
            ...updatedMessages[index],
            errorMessage: "",
          }
          // Insert a new message right after
          updatedMessages.splice(index + 1, 0, {
            messageRole: "assistant",
            message: "",
            isRetrying: true,
            sources: [],
          })
        }

        return updatedMessages
      } else {
        return prevMessages.map((msg) => {
          if (msg.externalId === messageId && msg.messageRole === "assistant") {
            return { ...msg, message: "", isRetrying: true, sources: [] }
          }
          return msg
        })
      }
    })

    const url = new URL(`/api/v1/message/retry`, window.location.origin)
    url.searchParams.append("messageId", encodeURIComponent(messageId))
    const eventSource = new EventSource(url.toString(), {
      withCredentials: true,
    })

    eventSource.addEventListener(ChatSSEvents.ResponseUpdate, (event) => {
      if (userMsgWithErr) {
        setMessages((prevMessages) => {
          // Find the index of the message where externalId matches messageId
          const index = prevMessages.findIndex(
            (msg) => msg.externalId === messageId,
          )

          // If no match is found or index+1 is out of range, return the original array
          if (index === -1 || index + 1 >= prevMessages.length) {
            return prevMessages
          }

          // Create a shallow copy of the array
          const newMessages = [...prevMessages]

          // Create a copy of the message object at index+1 and add the `message` field
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
    })

    eventSource.addEventListener(ChatSSEvents.Reasoning, (event) => {
      setCurrentResp((prevResp) => ({
        ...(prevResp || { resp: "", thinking: event.data || "" }),
        thinking: (prevResp?.thinking || "") + event.data,
      }))
    })

    eventSource.addEventListener(ChatSSEvents.ResponseMetadata, (event) => {
      const userMessage = messages.find(
        (msg) => msg.externalId === messageId && msg.messageRole === "user",
      )
      if (userMessage) {
        const { messageId: newMessageId } = JSON.parse(event.data)

        if (newMessageId) {
          setMessages((prevMessages) => {
            // Find the index of the message where externalId matches messageId
            const index = prevMessages.findIndex(
              (msg) => msg.externalId === messageId,
            )

            if (index === -1 || index + 1 >= prevMessages.length) {
              // If no match is found or index+1 is out of range, return the original array
              return prevMessages
            }

            // Create a shallow copy of the array
            const newMessages = [...prevMessages]

            // Create a copy of the message object at index+1 and add the `message` field
            newMessages[index + 1] = {
              ...newMessages[index + 1],
              externalId: newMessageId,
            }
            return newMessages
          })
        }
      }
    })

    eventSource.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
      const { contextChunks, citationMap } = JSON.parse(event.data)
      setMessages((prevMessages) => {
        if (userMsgWithErr) {
          // Find the index of the message where externalId matches messageId
          const index = prevMessages.findIndex(
            (msg) => msg.externalId === messageId,
          )

          if (index === -1 || index + 1 >= prevMessages.length) {
            // If no match is found or index+1 is out of range, return the original array
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
    })

    eventSource.addEventListener(ChatSSEvents.End, (event) => {
      setMessages((prevMessages) => {
        if (userMsgWithErr) {
          // Find the index of the message where externalId matches messageId
          const index = prevMessages.findIndex(
            (msg) => msg.externalId === messageId,
          )

          if (index === -1 || index + 1 >= prevMessages.length) {
            // If no match is found or index+1 is out of range, return the original array
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
      eventSource.close()
      setIsStreaming(false) // Stop streaming after retry
    })

    eventSource.addEventListener(ChatSSEvents.Error, (event) => {
      console.error("Retry Error with SSE:", event.data)
      setMessages((prevMessages) => {
        if (userMsgWithErr) {
          // Find the index of the message where externalId matches messageId
          const index = prevMessages.findIndex(
            (msg) => msg.externalId === messageId,
          )

          if (index === -1 || index + 1 >= prevMessages.length) {
            // If no match is found or index+1 is out of range, return the original array
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
      eventSource.close()
      setIsStreaming(false)
    })

    eventSource.onerror = (error) => {
      console.error("Retry SSE Error:", error)
      setMessages((prevMessages) => {
        if (userMsgWithErr) {
          // Find the index of the message where externalId matches messageId
          const index = prevMessages.findIndex(
            (msg) => msg.externalId === messageId,
          )

          if (index === -1 || index + 1 >= prevMessages.length) {
            // If no match is found or index+1 is out of range, return the original array
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
      eventSource.close()
      setIsStreaming(false) // Stop streaming on error
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

    const threshold = 100 // pixels from bottom to consider "at bottom"
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

  // if invalid chatId
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
        titleRef.current.focus() // Focus on the span for immediate editing
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
      setEditedTitle(chatTitle) // Revert to original title
      setIsEditing(false)
      if (titleRef.current) {
        titleRef.current.value = chatTitle! // Revert UI to original title
      }
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditedTitle(e.target.value) // Update state with edited content
  }

  const handleBlur = () => {
    if (editedTitle !== chatTitle) {
      // Revert to original title if editing is canceled
      setEditedTitle(chatTitle)
      if (titleRef.current) {
        titleRef.current.value = chatTitle! // Revert UI to original title
      }
    }
    setIsEditing(false)
  }

  return (
    <div className="h-full w-full flex flex-row bg-white">
      <Sidebar photoLink={user.photoLink ?? ""} role={user?.role} />
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
        >
          <div className={`w-full h-full flex flex-col items-center`}>
            <div
              onScroll={handleScroll}
              className="flex flex-col w-full  max-w-3xl flex-grow mb-[60px] mt-[56px]"
            >
              {messages.map((message, index) => {
                const isSourcesVisible =
                  showSources && currentMessageId === message.externalId
                const userMessageWithErr =
                  message.messageRole === "user" && message?.errorMessage

                return (
                  <>
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
                      />
                    )}
                  </>
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
                />
              )}
              <div className="absolute bottom-0 left-0 w-full h-[80px] bg-white"></div>
            </div>
            <ChatBox
              query={query}
              setQuery={setQuery}
              handleSend={handleSend}
              isStreaming={isStreaming}
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
    <div className="h-full w-1/4 top-[48px] right-0 fixed border-l-[1px] border-[#E6EBF5] bg-white overflow-y-auto">
      <div className="ml-[40px] mt-[24px]">
        <div className="flex items-center">
          <span
            className="text-[#929FBA] font-normal text-[12px] tracking-[0.08em]"
            style={{ fontFamily: "JetBrains Mono" }}
          >
            SOURCES
          </span>
          <X
            stroke="#9EAEBE"
            size={14}
            className="ml-auto mr-[40px] cursor-pointer"
            onClick={closeSources}
          />
        </div>
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
}) => {
  const [isCopied, setIsCopied] = useState(false)
  const citationUrls = citations?.map((c: Citation) => c.url)

  const processMessage = (text: string) => {
    // First split any grouped citations
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
                  {thinking}
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
                />
              )}
            </div>
          </div>
          {responseDone && !isRetrying && (
            <div className="flex flex-col">
              <div className="flex ml-[52px] mt-[24px] items-center">
                <Copy
                  size={16}
                  stroke={`${isCopied ? "#4F535C" : "#B2C3D4"}`}
                  className={`cursor-pointer`}
                  onMouseDown={(e) => setIsCopied(true)}
                  onMouseUp={(e) => setIsCopied(false)}
                  onClick={() => {
                    navigator.clipboard.writeText(processMessage(message))
                  }}
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
  q: z.string(),
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
