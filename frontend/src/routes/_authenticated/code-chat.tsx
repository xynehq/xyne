import { useEffect, useRef, useState } from "react"
import {
  createFileRoute,
  useLoaderData,
  useParams,
  useRouter,
  useRouteContext,
} from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { Sidebar } from "../../components/Sidebar"
import { ChatBox } from "@/components/ChatBox"
import { api } from "@/api"
import { errorComponent } from "@/components/error"
import { ChatSSEvents, PublicUser, PublicWorkspace } from "shared/types"

// --- Types ---
interface CodeChatMessageData {
  role: "user" | "ai" | "system"
  content: string
  messageId?: string
}

interface CodeChatLoaderData {
  chat?: {
    externalId: string
    title: string | null
  }
  messages: CodeChatMessageData[]
  error?: unknown
}

interface CodeChatParams {
  chatId?: string
}

interface CodeChatPageProps {
  user: PublicUser
  workspace: PublicWorkspace
}

interface AuthenticatedContext {
  user: PublicUser
  workspace: PublicWorkspace
}

// --- Helper Component ---
const CodeChatMessageComponent = ({
  message,
  isUser,
  isStreaming = false,
}: {
  message: CodeChatMessageData | { role: "ai"; content: string | null }
  isUser: boolean
  isStreaming?: boolean
}) => {
  const role = message.role
  const content = message.content

  return (
    <div
      key={(message as CodeChatMessageData).messageId || `streaming-${role}`}
      className={`mb-4 ${
        isUser
          ? "bg-[#F0F2F4] text-[#1C1D1F] text-[15px] leading-[25px] self-end pt-[14px] pb-[14px] pl-[20px] pr-[20px] rounded-[16px] ml-auto max-w-[85%]"
          : role === "ai"
            ? "text-[#1C1D1F] text-[15px] leading-[25px] self-start max-w-[85%]"
            : "bg-yellow-50 text-[#1C1D1F] text-[14px] leading-[22px] self-center rounded-[10px] p-3 max-w-[75%] mx-auto"
      }`}
    >
      {isUser ? (
        <div className="whitespace-pre-wrap break-words">{content}</div>
      ) : role === "ai" ? (
        <div className="flex items-start">
          <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-white text-sm mr-2 flex-shrink-0">
            AI
          </div>
          <div className="whitespace-pre-wrap">
            {content || (isStreaming ? "..." : "")}
          </div>
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words">{content}</div>
      )}
    </div>
  )
}

export function CodeChatPage({ user, workspace }: CodeChatPageProps) {
  const params = Route.useParams() as CodeChatParams
  const router = useRouter()
  const isWithChatId = !!params.chatId
  const loaderData = useLoaderData({
    from: isWithChatId
      ? "/_authenticated/code-chat/$chatId"
      : "/_authenticated/code-chat",
  }) as CodeChatLoaderData | undefined
  const queryClient = useQueryClient()

  const [query, setQuery] = useState("")
  const [messages, setMessages] = useState<CodeChatMessageData[]>(
    isWithChatId ? loaderData?.messages || [] : [],
  )
  const [chatId, setChatId] = useState<string | null>(params.chatId || null)
  const [chatTitle, setChatTitle] = useState<string | null>(
    isWithChatId ? loaderData?.chat?.title || null : null,
  )
  const [isStreaming, setIsStreaming] = useState(false)
  const [currentResp, setCurrentResp] = useState<string | null>(null)

  const currentRespRef = useRef<string>("")
  const currentAssistantMessageIdRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    setMessages(isWithChatId ? loaderData?.messages || [] : [])
    setChatId(params.chatId || null)
    setChatTitle(isWithChatId ? loaderData?.chat?.title || null : null)
    setIsStreaming(false)
    setCurrentResp(null)
    currentRespRef.current = ""
    currentAssistantMessageIdRef.current = null
    console.log("Current Code Chat ID:", params.chatId || "New Chat")
  }, [params.chatId, loaderData, isWithChatId])

  useEffect(() => {
    const container = messagesContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [messages, currentResp])

  const handleSend = async () => {
    if (!query.trim() || isStreaming) return

    const userMessage: CodeChatMessageData = { role: "user", content: query }
    setMessages((prev) => [...prev, userMessage])
    const currentQuery = query
    setQuery("")
    setIsStreaming(true)
    setCurrentResp("")
    currentRespRef.current = ""
    currentAssistantMessageIdRef.current = null

    const url = new URL(`/api/v1/code-message/create`, window.location.origin)

    const currentChatId = chatId
    if (currentChatId) {
      url.searchParams.append("chatId", currentChatId)
    }
    url.searchParams.append("message", encodeURIComponent(currentQuery))

    const eventSource = new EventSource(url.toString(), {
      withCredentials: true,
    })

    eventSource.addEventListener(ChatSSEvents.ResponseMetadata, (event) => {
      try {
        const metadata = JSON.parse(event.data)
        if (metadata.chatId && !currentChatId) {
          console.log("Received new chatId:", metadata.chatId)
          setChatId(metadata.chatId)
          router.history.push(`/code-chat/${metadata.chatId}`, {})
        }
        if (metadata.messageId) {
          currentAssistantMessageIdRef.current = metadata.messageId
        }
      } catch (e) {
        console.error("Failed to parse metadata:", e)
      }
    })

    eventSource.addEventListener(ChatSSEvents.ChatTitleUpdate, (event) => {
      console.log("Received ChatTitleUpdate:", event.data)
      setChatTitle(event.data)
      queryClient.invalidateQueries({ queryKey: ["all-chats"] })
    })

    eventSource.addEventListener(ChatSSEvents.ResponseUpdate, (event) => {
      const chunk = event.data
      currentRespRef.current += chunk
      setCurrentResp(currentRespRef.current)
    })

    eventSource.addEventListener(ChatSSEvents.End, (event) => {
      if (currentRespRef.current) {
        const aiMessage: CodeChatMessageData = {
          role: "ai",
          content: currentRespRef.current,
          messageId: currentAssistantMessageIdRef.current || undefined,
        }
        setMessages((prev) => [...prev, aiMessage])
      }
      setCurrentResp(null)
      currentRespRef.current = ""
      currentAssistantMessageIdRef.current = null
      eventSource.close()
      setIsStreaming(false)
      inputRef.current?.focus()
    })

    eventSource.addEventListener(ChatSSEvents.Error, (event) => {
      console.error("Error with Code Chat SSE:", event.data)
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Error: ${event.data || "Unknown error"}` },
      ])
      setCurrentResp(null)
      currentRespRef.current = ""
      currentAssistantMessageIdRef.current = null
      eventSource.close()
      setIsStreaming(false)
    })

    eventSource.onerror = (error) => {
      console.error("Error with Code Chat SSE connection:", error)
      setMessages((prev) => [
        ...prev,
        { role: "system", content: "Error connecting to the server." },
      ])
      setCurrentResp(null)
      currentRespRef.current = ""
      currentAssistantMessageIdRef.current = null
      eventSource.close()
      setIsStreaming(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (loaderData?.error) {
    const errorMessage =
      loaderData.error instanceof Error
        ? loaderData.error.message
        : typeof loaderData.error === "string"
          ? loaderData.error
          : "Unknown loading error"
    return (
      <div className="h-full w-full flex items-center justify-center">
        <p className="text-red-500">Error loading chat: {errorMessage}</p>
      </div>
    )
  }

  return (
    <div className="h-full w-full flex flex-row bg-white">
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} />
      <div className="h-full w-full flex flex-col relative">
        <div className="flex w-full fixed bg-white h-[48px] border-b-[1px] border-[#E6EBF5] justify-center">
          <h1 className="text-lg font-medium my-auto">
            {chatTitle ||
              (chatId ? `Chat ${chatId.slice(-6)}` : "New Code Chat")}
          </h1>
        </div>

        <div
          className="h-full w-full flex flex-col overflow-y-auto pt-[48px] pb-[100px] px-4"
          ref={messagesContainerRef}
          style={{ maxWidth: "850px", margin: "0 auto", width: "100%" }}
        >
          <div className="flex flex-col flex-1">
            {messages.map((msg) => (
              <CodeChatMessageComponent
                key={msg.messageId || `msg-${msg.role}-${Math.random()}`}
                message={msg}
                isUser={msg.role === "user"}
              />
            ))}
            {isStreaming && (
              <CodeChatMessageComponent
                message={{ role: "ai", content: currentResp }}
                isUser={false}
                isStreaming={true}
              />
            )}
          </div>
        </div>

        <div className="fixed bottom-0 w-full flex justify-center pb-5">
          <div className="w-full max-w-[850px] px-4">
            <ChatBox
              query={query}
              setQuery={setQuery}
              handleSend={handleSend}
              isStreaming={isStreaming}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Route Definition ---
export const Route = createFileRoute("/_authenticated/code-chat")({
  component: () => {
    const { user, workspace } = useRouteContext({
      from: "/_authenticated",
    }) as AuthenticatedContext
    return <CodeChatPage user={user} workspace={workspace} />
  },
  errorComponent: errorComponent,
})
