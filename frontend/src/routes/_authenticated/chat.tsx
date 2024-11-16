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
import { Bookmark, Copy, Ellipsis } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { ChatSSEvents, SelectPublicMessage, Citation } from "shared/types"
import AssistantLogo from "@/assets/assistant-logo.svg"
import Retry from "@/assets/retry.svg"
import { PublicUser, PublicWorkspace } from "shared/types"
import { ChatBox } from "@/components/ChatBox"
import { z } from "zod"

type CurrentResp = {
  resp: string
  chatId?: string
  messageId?: string
  sources?: Citation[]
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

  // query and param both can't exist same time
  if (chatParams.q && isWithChatId) {
    router.navigate({
      to: "/chat/$chatId",
      params: { chatId: (params as any).chatId },
    })
  }

  const hasHandledQueryParam = useRef(false)

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

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

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
    if (!hasHandledQueryParam.current) {
      setMessages(isWithChatId ? data?.messages || [] : [])
    }
    setChatId((params as any).chatId || null)
    setChatTitle(isWithChatId ? data?.chat?.title || null : null)
    setBookmark(isWithChatId ? !!data?.chat?.isBookmarked || false : false)
    // only reset explicitly
    if (!isStreaming) {
      setCurrentResp(null)
      currentRespRef.current = null
    }
    inputRef.current?.focus()
    setQuery("")
  }, [(params as any).chatId])

  const handleSend = async (messageToSend: string) => {
    if (!messageToSend) return

    setQuery("")
    // Append the user's message to the chat
    setMessages((prevMessages) => [
      ...prevMessages,
      { messageRole: "user", message: messageToSend },
    ])

    // Set currentResp to an empty response to shift layout immediately
    setCurrentResp({ resp: "" })
    currentRespRef.current = { resp: "", sources: [] }

    const url = new URL(`/api/v1/message/create`, window.location.origin)
    if (chatId) {
      url.searchParams.append("chatId", chatId)
    }
    url.searchParams.append("modelId", "gpt-4o-mini")
    url.searchParams.append("message", encodeURIComponent(messageToSend))

    const eventSource = new EventSource(url.toString(), {
      withCredentials: true,
    })
    setIsStreaming(true)

    eventSource.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
      const { contextChunks } = JSON.parse(event.data)
      if (currentRespRef.current) {
        currentRespRef.current.sources = contextChunks
      }
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
        setCurrentResp((resp) => {
          const updatedResp = resp || { resp: "" }
          updatedResp.chatId = chatId
          updatedResp.messageId = messageId
          currentRespRef.current = updatedResp // Update the ref
          return updatedResp
        })
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
          { messageRole: "assistant", message: currentResp.resp },
        ])
      }
      setCurrentResp(null)
      currentRespRef.current = null
      eventSource.close()
      setIsStreaming(false)
    }

    // Clear the input
    setQuery("")
    setIsStreaming(true)
  }

  const handleRetry = async (messageId: string) => {
    if (!messageId) return

    setIsStreaming(true) // Start streaming for retry

    // Update the assistant message being retried
    setMessages((prevMessages) =>
      prevMessages.map((msg) => {
        if (msg.externalId === messageId && msg.messageRole === "assistant") {
          return { ...msg, message: "", isRetrying: true, sources: [] }
        }
        return msg
      }),
    )

    const url = new URL(`/api/v1/message/retry`, window.location.origin)
    url.searchParams.append("messageId", encodeURIComponent(messageId))
    const eventSource = new EventSource(url.toString(), {
      withCredentials: true,
    })

    eventSource.addEventListener(ChatSSEvents.ResponseUpdate, (event) => {
      setMessages((prevMessages) =>
        prevMessages.map((msg) =>
          msg.externalId === messageId && msg.isRetrying
            ? { ...msg, message: msg.message + event.data }
            : msg,
        ),
      )
    })

    eventSource.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
      const { contextChunks } = JSON.parse(event.data)
      setMessages((prevMessages) =>
        prevMessages.map((msg) =>
          msg.externalId === messageId && msg.isRetrying
            ? { ...msg, sources: contextChunks }
            : msg,
        ),
      )
    })

    eventSource.addEventListener(ChatSSEvents.End, (event) => {
      setMessages((prevMessages) =>
        prevMessages.map((msg) =>
          msg.externalId === messageId && msg.isRetrying
            ? { ...msg, isRetrying: false }
            : msg,
        ),
      )
      eventSource.close()
      setIsStreaming(false) // Stop streaming after retry
    })

    eventSource.onerror = (error) => {
      console.error("Retry SSE Error:", error)
      setMessages((prevMessages) =>
        prevMessages.map((msg) =>
          msg.isRetrying ? { ...msg, isRetrying: false } : msg,
        ),
      )
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
  if (data.error) {
    return (
      <div className="h-full w-full flex flex-col bg-white">
        <Sidebar />
        <div className="ml-[120px]">Error: Could not get data</div>
      </div>
    )
  }
  return (
    <div className="h-full w-full flex flex-row bg-white">
      <Sidebar photoLink={user.photoLink ?? ""} />
      <div className="h-full w-full flex flex-col">
        <div className="flex w-full fixed bg-white h-[48px] border-b-[1px] border-[#E6EBF5] justify-center">
          <div className="flex h-[48px] items-center max-w-2xl w-full">
            <span className="flex-grow text-[#1C1D1F] text-[16px] font-normal overflow-hidden text-ellipsis whitespace-nowrap">
              {chatTitle}
            </span>
            <Bookmark
              {...(bookmark ? { fill: "#4A4F59" } : { outline: "#4A4F59" })}
              className="ml-[40px] cursor-pointer"
              onClick={handleBookmark}
              size={18}
            />
            <Ellipsis stroke="#4A4F59" className="ml-[20px]" size={18} />
          </div>
        </div>

        <div
          className={`h-full w-full flex "items-end" overflow-y-auto justify-center`}
          ref={messagesContainerRef}
        >
          <div
            className={`w-full h-full max-w-3xl flex flex-col "justify-between"`}
          >
            <div
              onScroll={handleScroll}
              className="flex flex-col flex-grow mb-[60px] mt-[56px]"
            >
              {messages.map((message, index) => (
                <ChatMessage
                  key={index}
                  message={message.message}
                  isUser={message.messageRole === "user"}
                  responseDone={true}
                  citations={message?.sources?.map((c: Citation) => c.url)}
                  messageId={message.externalId}
                  handleRetry={handleRetry}
                  dots={message.isRetrying ? dots : ""}
                />
              ))}
              {currentResp && (
                <ChatMessage
                  message={currentResp.resp}
                  citations={currentResp.sources?.map((c: Citation) => c.url)}
                  isUser={false}
                  responseDone={false}
                  handleRetry={handleRetry}
                  dots={dots}
                />
              )}
              <div className="absolute bottom-0 left-0 w-full h-[80px] bg-white"></div>
            </div>
            <ChatBox
              query={query}
              setQuery={setQuery}
              handleSend={handleSend}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

const ChatMessage = ({
  message,
  isUser,
  responseDone,
  isRetrying,
  citations = [],
  messageId,
  handleRetry,
  dots = "",
}: {
  message: string
  isUser: boolean
  responseDone: boolean
  isRetrying?: boolean
  citations?: string[]
  messageId?: string
  dots: string
  handleRetry: (messageId: string) => void
}) => {
  const [isCopied, setIsCopied] = useState(false)
  const processMessage = (text: string) => {
    let citationIndex = 0

    return text.replace(/\[(\d+)\]/g, (match, num) => {
      const url = citations[citationIndex]

      if (url) {
        citationIndex++
        return `[[${citationIndex}]](${url})`
      }

      return match
    })
  }

  return (
    <div
      className={`max-w-[75%] rounded-[16px] ${isUser ? "bg-[#F0F2F4] text-[#1C1D1F] text-[15px] leading-[25px] self-end pt-[14px] pb-[14px] pl-[20px] pr-[20px]" : "text-[#1C1D1F] text-[15px] leading-[25px] self-start"}`}
    >
      {isUser ? (
        message
      ) : (
        <div className="flex flex-col mt-[40px]">
          <div className="flex flex-row">
            <img
              className={"mr-[20px] w-[32px] self-start"}
              src={AssistantLogo}
            />
            <div className="mt-[4px] markdown-content">
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
            <div className="flex ml-[52px] mt-[24px]">
              <Copy
                size={16}
                stroke={`${isCopied ? "#4F535C" : "#9EA6B8"}`}
                className={`cursor-pointer`}
                onMouseDown={(e) => setIsCopied(true)}
                onMouseUp={(e) => setIsCopied(false)}
                onClick={() => {
                  navigator.clipboard.writeText(processMessage(message))
                }}
              />
              <img
                className="ml-[18px] cursor-pointe"
                src={Retry}
                onClick={() => handleRetry(messageId!)}
              />
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
})
