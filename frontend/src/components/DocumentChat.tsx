import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  Fragment,
} from "react"
import DOMPurify from "dompurify"
import { useQueryClient } from "@tanstack/react-query"
import { useTheme } from "@/components/ThemeContext"
import { useToast } from "@/hooks/use-toast"
import { useChatStream } from "@/hooks/useChatStream"
import { useChatHistory } from "@/hooks/useChatHistory"
import { ChatBox, ChatBoxRef } from "@/components/ChatBox"
import { api } from "@/api"
import MarkdownPreview from "@uiw/react-markdown-preview"
import { Copy, ThumbsUp, ThumbsDown } from "lucide-react"
import {
  SelectPublicMessage,
  ImageCitation,
  MessageFeedback,
  AttachmentMetadata,
  UploadStatus,
} from "shared/types"
import { PublicUser } from "shared/types"
import logo from "@/assets/logo.svg"
import { EnhancedReasoning } from "@/components/EnhancedReasoning"
import { AttachmentGallery } from "@/components/AttachmentGallery"
import { jsonToHtmlMessage } from "@/routes/_authenticated/chat"
import {
  cleanCitationsFromResponse,
  processMessage,
  createTableComponents,
} from "@/utils/chatUtils.tsx"
import { ToolsListItem } from "@/types"
import { ImageCitationComponent } from "../routes/_authenticated/chat"
import { createCitationLink, Citation } from "@/components/CitationLink"
import Retry from "@/assets/retry.svg"
import { PersistentMap } from "@/utils/chatUtils.tsx"
import { MermaidCodeWrapper } from "@/hooks/useMermaidRenderer"

// Persistent storage for tempChatId -> actual chatId mapping using sessionStorage
const TEMP_CHAT_ID_MAP_KEY = "tempChatIdToChatIdMap"
const tempChatIdToChatIdMap = new PersistentMap(TEMP_CHAT_ID_MAP_KEY)

export const THINKING_PLACEHOLDER = "Thinking"

interface DocumentChatProps {
  user: PublicUser
  documentId: string
  documentName: string
  initialChatId?: string | null
  onChatCreated?: (chatId: string) => void
  onChunkIndexChange?: (chunkIndex: number | null, itemId: string, docId: string) => void
  uploadStatus?: UploadStatus
  isKnowledgeBaseChat?: boolean 
}

const ChatMessage = React.memo(
  ({
    message,
    thinking,
    isUser,
    responseDone,
    isRetrying,
    isStreaming = false,
    imageCitations = [],
    messageId,
    dots = "",
    feedbackStatus,
    onFeedback,
    onRetry,
    attachments = [],
    citations = [],
    citationMap,
    onCitationClick,
    disableRetry = false,
  }: {
    message: string
    thinking: string
    isUser: boolean
    responseDone: boolean
    onRetry: (messageId: string) => void
    isRetrying?: boolean
    isStreaming?: boolean
    imageCitations?: ImageCitation[]
    messageId?: string
    dots: string
    feedbackStatus?: MessageFeedback | null
    onFeedback?: (messageId: string, feedback: MessageFeedback) => void
    attachments?: AttachmentMetadata[]
    citations?: Citation[]
    citationMap?: Record<number, number>
    onCitationClick?: (citation: Citation, chunkIndex?: number) => void
    disableRetry?: boolean
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
          className={`rounded-[16px] max-w-full min-w-0 ${
            isUser
              ? "bg-[#F0F2F4] dark:bg-slate-700 text-[#1C1D1F] dark:text-slate-100 text-[15px] leading-[25px] self-end pt-[14px] pb-[14px] pl-[20px] pr-[20px] break-words overflow-wrap-anywhere"
              : "text-[#1C1D1F] dark:text-[#F1F3F4] text-[15px] leading-[25px] self-start w-full max-w-full min-w-0"
          }`}
        >
          {isUser ? (
            <div
              className="break-words overflow-wrap-anywhere word-break-break-all max-w-full min-w-0"
              dangerouslySetInnerHTML={{
                __html: jsonToHtmlMessage(DOMPurify.sanitize(message)),
              }}
            />
          ) : (
            <div className="flex flex-col mt-[40px] w-full max-w-full min-w-0 mb-[35px]">
              <div className="flex flex-row w-full max-w-full min-w-0">
                <img
                  className="mr-[20px] w-[32px] self-start flex-shrink-0"
                  src={logo}
                  alt="Assistant"
                />
                <div className="mt-[4px] markdown-content w-full min-w-0 flex-1">
                  {thinking && (
                    <EnhancedReasoning
                      content={thinking}
                      isStreaming={isStreaming}
                      className="mb-4"
                      citations={citations}
                      citationMap={citationMap}
                    />
                  )}
                  {message === "" &&
                  (!responseDone || isRetrying || isStreaming) ? (
                    <div className="flex-grow text-[#1C1D1F] dark:text-[#F1F3F4]">
                      {`${THINKING_PLACEHOLDER}${dots}`}
                    </div>
                  ) : message !== "" ? (
                    <MarkdownPreview
                      key={`markdown-${messageId || "unknown"}`}
                      source={processMessage(
                        message,
                        citationMap,
                        citationUrls,
                      )}
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
                        a: createCitationLink(
                          citations,
                          onCitationClick,
                          false,
                        ),
                        code: MermaidCodeWrapper,
                        img: ({ src, alt, ...props }: any) => {
                          if (src?.startsWith("image-citation:")) {
                            const citationKey = src.replace(
                              "image-citation:",
                              "",
                            )
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
                  <div className="flex ml-[52px] mt-[12px] items-center">
                    <Copy
                      size={16}
                      stroke={`${isCopied ? "#4F535C" : "#B2C3D4"}`}
                      className="cursor-pointer"
                      onMouseDown={() => setIsCopied(true)}
                      onMouseUp={() => setIsCopied(false)}
                      onClick={() =>
                        navigator.clipboard.writeText(
                          cleanCitationsFromResponse(message),
                        )
                      }
                    />
                    <img
                      className={`ml-[18px] ${disableRetry || !messageId ? "opacity-50" : "cursor-pointer"}`}
                      src={Retry}
                      onClick={() =>
                        messageId && !disableRetry && onRetry?.(messageId)
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
                          className={`ml-[18px] ${
                            onFeedback ? "cursor-pointer" : "opacity-50"
                          }`}
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
                          className={`ml-[10px] ${
                            onFeedback ? "cursor-pointer" : "opacity-50"
                          }`}
                          onClick={() =>
                            onFeedback &&
                            onFeedback(messageId, MessageFeedback.Dislike)
                          }
                        />
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  },
  (prevProps, nextProps) => {
    // Only re-render if essential props change
    // Less aggressive memoization to allow proper mermaid rendering during streaming
    if (prevProps.isStreaming !== nextProps.isStreaming) return false
    if (prevProps.message !== nextProps.message) return false
    if (prevProps.thinking !== nextProps.thinking) return false
    if (prevProps.dots !== nextProps.dots) return false
    if (prevProps.responseDone !== nextProps.responseDone) return false
    if (prevProps.isRetrying !== nextProps.isRetrying) return false
    if (prevProps.feedbackStatus !== nextProps.feedbackStatus) return false
    if (prevProps.messageId !== nextProps.messageId) return false

    // Allow re-renders for citations and citationMap changes (important for mermaid)
    if (prevProps.citations?.length !== nextProps.citations?.length)
      return false
    if (
      JSON.stringify(prevProps.citationMap) !==
      JSON.stringify(nextProps.citationMap)
    )
      return false

    return true
  },
)

// Memoized Messages Area to prevent re-renders when typing in chat box
const MessagesArea = React.memo(
  ({
    messages,
    currentResp,
    handleRetry,
    dots,
    feedbackMap,
    handleFeedback,
    handleCitationClick,
    disableRetry,
    isStreaming,
  }: {
    messages: SelectPublicMessage[]
    currentResp: any
    handleRetry: (messageId: string) => void
    dots: string
    feedbackMap: Record<string, MessageFeedback | null>
    handleFeedback: (messageId: string, feedback: MessageFeedback) => void
    handleCitationClick: (citation: Citation, chunkIndex?: number) => void
    disableRetry: boolean
    isStreaming: boolean
  }) => (
    <div className="space-y-4">
      {messages.map((message: SelectPublicMessage, index: number) => {
        // Create stable key for messages - avoid using message content to prevent remounting during streaming
        const messageKey =
          message.externalId || `msg-${index}-${message.messageRole}`

        return (
          <Fragment key={messageKey}>
            <ChatMessage
              key={messageKey}
              message={message.message}
              isUser={message.messageRole === "user"}
              responseDone={message.externalId !== "current-resp"}
              thinking={message.thinking}
              imageCitations={message.imageCitations || []}
              messageId={message.externalId}
              isRetrying={message.isRetrying}
              isStreaming={message.isStreaming}
              onRetry={handleRetry}
              dots={
                message.isRetrying || message.externalId === "current-resp"
                  ? dots
                  : ""
              }
              feedbackStatus={feedbackMap[message.externalId!] || null}
              onFeedback={handleFeedback}
              attachments={message.attachments || []}
              citations={message.sources || []}
              citationMap={message.citationMap}
              onCitationClick={handleCitationClick}
              disableRetry={disableRetry}
            />
          </Fragment>
        )
      })}

      {currentResp && (
        <ChatMessage
          key={`streaming-${currentResp.messageId}`}
          message={currentResp.resp}
          imageCitations={currentResp.imageCitations}
          thinking={currentResp.thinking || ""}
          isUser={false}
          responseDone={false}
          isStreaming={isStreaming}
          dots={dots}
          messageId={currentResp.messageId}
          feedbackStatus={null}
          onFeedback={handleFeedback}
          disableRetry={disableRetry}
          attachments={[]}
          citations={currentResp.sources || []}
          citationMap={currentResp.citationMap}
          onCitationClick={handleCitationClick}
          onRetry={handleRetry}
        />
      )}
    </div>
  ),
  (prevProps, nextProps) => {
    // Less aggressive memoization to allow proper mermaid rendering
    if (prevProps.messages.length !== nextProps.messages.length) return false
    if (prevProps.currentResp?.resp !== nextProps.currentResp?.resp)
      return false
    if (prevProps.currentResp?.thinking !== nextProps.currentResp?.thinking)
      return false
    if (
      prevProps.currentResp?.sources?.length !==
      nextProps.currentResp?.sources?.length
    )
      return false
    if (prevProps.dots !== nextProps.dots) return false
    if (prevProps.disableRetry !== nextProps.disableRetry) return false
    if (prevProps.isStreaming !== nextProps.isStreaming) return false

    // Check if any message content has changed - be more thorough
    for (let i = 0; i < prevProps.messages.length; i++) {
      const prevMsg = prevProps.messages[i]
      const nextMsg = nextProps.messages[i]
      if (
        prevMsg?.message !== nextMsg?.message ||
        prevMsg?.thinking !== nextMsg?.thinking ||
        prevMsg?.externalId !== nextMsg?.externalId ||
        prevMsg?.sources?.length !== nextMsg?.sources?.length
      ) {
        return false
      }
    }

    return true
  },
)

export const DocumentChat: React.FC<DocumentChatProps> = ({
  user,
  documentId,
  documentName,
  initialChatId,
  onChatCreated,
  onChunkIndexChange,
  uploadStatus,
  isKnowledgeBaseChat = false,
}) => {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [chatId, setChatId] = useState<string | null>(null)
  const [chatTitle] = useState<string>(`Chat with ${documentName}`)
  const [query, setQuery] = useState("")
  const [dots, setDots] = useState("")
  const [feedbackMap, setFeedbackMap] = useState<
    Record<string, MessageFeedback | null>
  >({})
  const [userHasScrolled, setUserHasScrolled] = useState(false)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [allCitations, setAllCitations] = useState<Map<string, Citation>>(
    new Map(),
  ) // State for all citations
  const chatBoxRef = useRef<ChatBoxRef>(null)
  // Citation state management
  // const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null)
  // Add retryIsStreaming state
  const [retryIsStreaming, setRetryIsStreaming] = useState(false)

  // Custom setChatId function that handles the mapping
  const handleSetChatId = useCallback(
    (newChatId: string) => {
      if (initialChatId && newChatId !== initialChatId) {
        // Map the tempChatId to the actual chatId from server
        tempChatIdToChatIdMap.set(initialChatId, newChatId)
        // Notify parent component about the chat creation
        onChatCreated?.(newChatId)
      }
      setChatId(newChatId)
    },
    [initialChatId, onChatCreated],
  )

  // Use custom hooks for streaming and history
  const { data: historyData } = useChatHistory(chatId)
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
    undefined,
    setRetryIsStreaming,
    true,
    handleSetChatId,
  ) // preventNavigation = true

  const disableRetry = isStreaming || retryIsStreaming
  const messages = historyData?.messages || []

  // Update chatId when initialChatId (tempChatId) changes
  useEffect(() => {
    if (initialChatId) {
      // Check if we have a mapped chatId for this tempChatId
      const mappedChatId = tempChatIdToChatIdMap.get(initialChatId)
      if (mappedChatId) {
        setChatId(mappedChatId)
      }
    } else {
      setChatId(null)
    }
  }, [initialChatId])

  // Create a current streaming response
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

  // Auto-scroll effect
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container || userHasScrolled) return

    container.scrollTop = container.scrollHeight
  }, [messages, partial])

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
            !newCitations?.has(citation?.itemId || citation.url)
          ) {
            newCitations.set(citation?.itemId || citation.url, citation)
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
    // Populate feedbackMap from loaded messages
    if (historyData?.messages) {
      const initialFeedbackMap: Record<string, MessageFeedback | null> = {}
      historyData.messages.forEach((msg: SelectPublicMessage) => {
        if (msg.externalId && msg.feedback !== undefined) {
          initialFeedbackMap[msg.externalId] = extractFeedbackType(msg.feedback)
        }
      })
      setFeedbackMap(initialFeedbackMap)
    }

    inputRef.current?.focus()
  }, [historyData?.messages])

  // Dots animation for thinking state
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

  // Handle scroll detection
  const handleScroll = () => {
    const container = messagesContainerRef.current
    if (!container) return

    const threshold = 100
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      threshold
    setUserHasScrolled(!isAtBottom)
  }

  // Handle sending messages
  // Handle sending messages
  const handleSend = async (
    messageToSend: string,
    metadata?: AttachmentMetadata[],
    selectedSources: string[] = [],
    agentIdFromChatBox?: string | null,
    toolsList?: ToolsListItem[] | null,
    selectedModel?: string,
    isFollowUp: boolean = false,
    selectedKbItems: string[] = [],
  ) => {
    if (!messageToSend || isStreaming || retryIsStreaming) return

    setUserHasScrolled(false)
    setQuery("")

    // Automatically add the document ID to selected Kbitems
    const kbItemsWithChat = [...selectedKbItems]
    if (!kbItemsWithChat.includes(documentId)) {
      kbItemsWithChat.push(documentId)
    }

    // Add user message optimistically to React Query cache with display text
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

    try {
      await startStream(
        messageToSend,
        [],
        false, // isAgenticMode
        null,
        [],
        metadata,
        selectedModel,
        isFollowUp,
        kbItemsWithChat,
      )
    } catch (error) {
      // If there's an error, clear the optimistically added message from cache
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

      console.error("Failed to send message:", error)
      toast({
        title: "Error",
        description: "Failed to send message",
        variant: "destructive",
      })
    }
  }

  const handleRetry = async (
    messageId: string,
    selectedKbItems: string[] = [],
  ) => {
    if (!messageId || isStreaming) return
    setRetryIsStreaming(true)
    // Automatically add the document ID to selected kbitems
    const kbItemsWithChat = [...selectedKbItems]
    if (!kbItemsWithChat.includes(documentId)) {
      kbItemsWithChat.push(documentId)
    }
    await retryMessage(
      messageId,
      false,
      undefined,
      undefined,
      [],
      kbItemsWithChat,
    )
  }

  // Handle feedback
  const handleFeedback = async (
    messageId: string,
    feedback: MessageFeedback,
  ) => {
    if (!messageId) return

    setFeedbackMap((prev) => {
      const currentFeedback = prev[messageId]
      return {
        ...prev,
        [messageId]: currentFeedback === feedback ? null : feedback,
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

  const handleCitationClick = (citation: Citation, chunkIndex?: number) => {
    onChunkIndexChange?.(chunkIndex ?? null, citation.itemId ?? documentId, citation.docId)
  }

  // Populate feedbackMap from loaded messages
  useEffect(() => {
    if (historyData?.messages) {
      const initialFeedbackMap: Record<string, MessageFeedback | null> = {}
      historyData.messages.forEach((msg: SelectPublicMessage) => {
        if (msg.externalId && msg.feedback !== undefined) {
          initialFeedbackMap[msg.externalId] =
            msg.feedback as MessageFeedback | null
        }
      })
      setFeedbackMap(initialFeedbackMap)
    }
  }, [historyData?.messages])

  return (
    <div className="flex flex-col h-full">
      {/* Chat header */}
      <div className="h-12 bg-white dark:bg-[#1E1E1E] flex items-center px-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
          {chatTitle}
        </h3>
      </div>

      {/* Messages area */}
      <div
        className="flex-1 overflow-y-auto p-4"
        ref={messagesContainerRef}
        onScroll={handleScroll}
      >
        {messages.length === 0 && !currentResp && (
          <div className="text-center text-gray-500 dark:text-gray-400 text-sm mt-8">
            <p className="mb-2">Start chatting with this document</p>
            <p className="text-xs">
              Ask questions about the content, request summaries, or get
              explanations.
            </p>
          </div>
        )}

        <MessagesArea
          messages={messages}
          currentResp={currentResp}
          handleRetry={handleRetry}
          dots={dots}
          feedbackMap={feedbackMap}
          handleFeedback={handleFeedback}
          handleCitationClick={handleCitationClick}
          disableRetry={disableRetry}
          isStreaming={isStreaming}
        />
      </div>

      {/* Chat input area */}
      <div className="pl-4 pr-4 flex-shrink-0 flex justify-center">
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
          setIsAgenticMode={() => {}}
          isAgenticMode={false}
          user={user}
          hideButtons={true}
          chatId={chatId}
          uploadStatus={uploadStatus}
          isKnowledgeBaseChat={isKnowledgeBaseChat}
        />
      </div>
    </div>
  )
}

export default DocumentChat
