import MarkdownPreview from "@uiw/react-markdown-preview"
import { api } from "@/api"
import { Sidebar } from "@/components/Sidebar"
import {
  createFileRoute,
  useLoaderData,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import {
  ArrowRight,
  Bookmark,
  Copy,
  Ellipsis,
  Globe,
  Paperclip,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { ChatSSEvents, SelectPublicMessage } from "shared/types"
import AssistantLogo from "@/assets/assistant-logo.svg"
import Retry from "@/assets/retry.svg"
import { PublicUser, PublicWorkspace } from "shared/types"

type CurrentResp = {
  resp: string
  chatId?: string
  messageId?: string
}

interface ChatPageProps {
  user: PublicUser
  workspace: PublicWorkspace
}

export const ChatPage = ({ user, workspace }: ChatPageProps) => {
  const params = Route.useParams()
  const router = useRouter()
  const isWithChatId = !!(params as any).chatId
  const data = useLoaderData({
    from: isWithChatId
      ? "/_authenticated/chat/$chatId"
      : "/_authenticated/chat",
  })

  useEffect(() => {
    if (data?.error) {
      router.navigate({ to: "/chat" })
    }
  }, [data, router])

  const [query, setQuery] = useState("")
  const [messages, setMessages] = useState<SelectPublicMessage[]>(
    isWithChatId ? data?.messages || [] : [],
  )
  const [chatId, setChatId] = useState<string | null>(
    (params as any).chatId || null,
  )
  const [chatTitle, setChatTitle] = useState<string | null>(
    isWithChatId ? data?.chat.title || null : null,
  )
  const [currentResp, setCurrentResp] = useState<CurrentResp | null>(null)
  const currentRespRef = useRef<CurrentResp | null>(null)
  const [chatStarted, setChatStarted] = useState<boolean>(
    isWithChatId ? !!data?.messages : false,
  )
  const [bookmark, setBookmark] = useState<boolean>(
    isWithChatId ? !!data?.chat.isBookmarked || false : false,
  )
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const [userHasScrolled, setUserHasScrolled] = useState(false)
  const [citations, setCitations] = useState<any[]>([])

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

  const handleSend = async () => {
    if (!query) return // Avoid empty messages

    // Append the user's message to the chat
    setMessages((prevMessages) => [
      ...prevMessages,
      { messageRole: "user", message: query },
    ])

    const url = new URL(`/api/v1/message/create`, window.location.origin)
    if (chatId) {
      url.searchParams.append("chatId", chatId)
    }
    url.searchParams.append("modelId", "llama")
    url.searchParams.append("message", encodeURIComponent(query))

    const eventSource = new EventSource(url.toString(), {
      withCredentials: true,
    })

    eventSource.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
      const { contextChunks } = JSON.parse(event.data)
      setCitations(contextChunks)
    })

    eventSource.addEventListener(ChatSSEvents.Start, (event) => {
      setChatStarted(true)
      setCitations([])
    })

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
      setCurrentResp((resp) => {
        const updatedResp = resp || { resp: "" }
        updatedResp.chatId = chatId
        updatedResp.messageId = messageId
        currentRespRef.current = updatedResp // Update the ref
        return updatedResp
      })
    })

    eventSource.addEventListener(ChatSSEvents.ChatTitleUpdate, (event) => {
      setChatTitle(event.data)
    })

    eventSource.addEventListener(ChatSSEvents.End, (event) => {
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
    }

    // Clear the input
    setQuery("")
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

  return (
    <div className="h-full w-full flex flex-row bg-white">
      <Sidebar />
      <div className="h-full w-full flex flex-col">
        {chatStarted && (
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
        )}
        <div
          className={`h-full w-full flex ${chatStarted ? "items-end" : "items-center"}  overflow-y-auto justify-center`}
          ref={messagesContainerRef}
        >
          <div
            className={`w-full h-full max-w-3xl flex-grow flex flex-col ${chatStarted ? "justify-between" : "justify-center"}`}
          >
            {/* Chat Messages Container */}
            <div
              onScroll={handleScroll}
              className="flex flex-col mb-[60px] mt-[56px]"
            >
              {messages.map((message, index) => (
                <ChatMessage
                  key={index}
                  message={message.message}
                  isUser={message.messageRole === "user"}
                  responseDone={true}
                  citations={citations.map((c) => c.url)}
                />
              ))}
              {currentResp && (
                <ChatMessage
                  message={currentResp.resp}
                  isUser={false}
                  responseDone={false}
                />
              )}
              <div className="absolute bottom-0 left-0 w-full h-[80px] bg-white"></div>
            </div>

            {/* Bottom Bar with Input and Icons */}
            <div className="flex flex-col w-full border rounded-[20px] sticky bottom-[20px] bg-white">
              {/* Expanding Input Area */}
              <div className="relative flex items-center">
                <textarea
                  ref={inputRef}
                  rows={1}
                  placeholder="Type your message..."
                  className="flex-grow resize-none bg-transparent outline-none text-sm text-[#1C1D1F] placeholder-gray-500 pl-[16px] pt-[14px] max-h-[108px] overflow-auto"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                  style={{
                    height: "auto",
                    minHeight: "40px", // Minimum height
                    maxHeight: "108px", // Maximum height
                  }}
                />
              </div>
              <div className="flex ml-[16px] mr-[6px] mb-[6px] items-center space-x-3 pt-2">
                <Globe size={16} className="text-[#A9B2C5]" />
                <Paperclip size={16} className="text-[#A9B2C5]" />
                <button
                  onClick={handleSend}
                  style={{ marginLeft: "auto" }}
                  className="flex mr-6 bg-[#464B53] text-white hover:bg-[#5a5f66] rounded-full w-[32px] h-[32px] items-center justify-center"
                >
                  <ArrowRight className="text-white" size={16} />
                </button>
              </div>
            </div>
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
  citations = [], // Add citations prop
}: {
  message: string
  isUser: boolean
  responseDone: boolean
  citations?: string[] // Array of citation URLs
}) => {
  // Process message to replace citation markers with links
  const processMessage = (text: string) => {
    return text.replace(/\[(\d+)\]/g, (match, num) => {
      const index = parseInt(num)
      const url = citations[index]
      if (url) {
        return `[${match}](${url})`
      }
      return match
    })
  }

  return (
    <div
      className={`max-w-[75%] rounded-[16px] ${
        isUser
          ? "bg-[#F0F2F4] text-[#1C1D1F] text-[15px] leading-[25px] self-end pt-[14px] pb-[14px] pl-[20px] pr-[20px]"
          : "text-[#1C1D1F] text-[15px] leading-[25px] self-start"
      }`}
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
            </div>
          </div>
          {responseDone && (
            <div className="flex ml-[52px] mt-[24px]">
              <Copy size={16} stroke="#9EA6B8" />
              <img className="ml-[18px]" src={Retry} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

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
