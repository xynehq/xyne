import React, {
    useState,
    useEffect,
    useRef,
    useCallback,
    Fragment,
  } from "react"
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
  } from "shared/types"
  import { PublicUser } from "shared/types"
  import logo from "@/assets/logo.svg"
  import { splitGroupedCitationsWithSpaces } from "@/lib/utils"
  import { EnhancedReasoning } from "@/components/EnhancedReasoning"
  import { AttachmentGallery } from "@/components/AttachmentGallery"
  import { renderToStaticMarkup } from "react-dom/server"
  import { Pill } from "@/components/Pill"
  import { Reference } from "@/types"
  import {
    textToImageCitationIndex,
    ImageCitationComponent,
    textToCitationIndex,
    REASONING_STATE_KEY,
  } from "../routes/_authenticated/chat"
  import { createCitationLink, Citation } from "@/components/CitationLink"
  import Retry from "@/assets/retry.svg"
  
  // Module-level map to store tempChatId -> actual chatId mapping (backend-generated)
  export const tempChatIdToChatIdMap = new Map<string, string>()
  
  export const THINKING_PLACEHOLDER = "Thinking"
  
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
  
  interface DocumentChatProps {
    user: PublicUser
    documentId: string
    documentName: string
    initialChatId?: string | null
    onChatCreated?: (chatId: string) => void
    onChunkIndexChange?: (chunkIndex: number | null) => void
  }
  
  const ChatMessage = ({
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
    
    const processMessage = (text: string) => {
      text = splitGroupedCitationsWithSpaces(text)
      text = text.replace(
        /(\[\d+_\d+\])/g,
        (fullMatch, capturedCitation, offset, string) => {
          // Check if this image citation appears earlier in the string
          const firstIndex = string.indexOf(fullMatch)
          if (firstIndex < offset) {
            // remove duplicate image citations
            return ""
          }
          return capturedCitation
        },
      )
      text = text.replace(
        textToImageCitationIndex,
        (match, citationKey, offset, string) => {
          // Check if this image citation appears earlier in the string
          const firstIndex = string.indexOf(match)
          if (firstIndex < offset) {
            // remove duplicate image citations
            return ""
          }
          return `![image-citation:${citationKey}](image-citation:${citationKey})`
        },
      )

      if (citationMap) {
        return text.replace(textToCitationIndex, (match, num) => {
          const index = citationMap[num]
          const url = citationUrls[index]
          return typeof index === "number" && url ? `[${index + 1}](${url})` : ""
        })
      } else {
        return text.replace(textToCitationIndex, (match, num) => {
          const url = citationUrls[num - 1]
          return url ? `[${num}](${url})` : ""
        })
      }
    }
  
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
              dangerouslySetInnerHTML={{ __html: jsonToHtmlMessage(message) }}
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
                  {message === "" && (!responseDone || isRetrying || isStreaming) ? (
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
                        a: createCitationLink(citations, onCitationClick, false),
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
                        table: ({ children, ...props }: any) => (
                          <div className="overflow-x-auto max-w-full">
                            <table 
                              {...props}
                              className="min-w-full border-collapse"
                              style={{
                                wordBreak: "break-word",
                                tableLayout: "auto"
                              }}
                            >
                              {children}
                            </table>
                          </div>
                        ),
                        td: ({ children, ...props }: any) => (
                          <td 
                            {...props}
                            style={{
                              wordBreak: "break-word",
                              overflowWrap: "break-word",
                              maxWidth: "200px",
                              ...props.style
                            }}
                          >
                            {children}
                          </td>
                        ),
                        th: ({ children, ...props }: any) => (
                          <th 
                            {...props}
                            style={{
                              wordBreak: "break-word",
                              overflowWrap: "break-word",
                              maxWidth: "200px",
                              ...props.style
                            }}
                          >
                            {children}
                          </th>
                        ),
                        pre: ({ children, ...props }: any) => (
                          <pre 
                            {...props}
                            className="overflow-x-auto max-w-full"
                            style={{
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              overflowWrap: "break-word",
                              ...props.style
                            }}
                          >
                            {children}
                          </pre>
                        ),
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
                        code: ({ children, inline, ...props }: any) => {
                          if (inline) {
                            return (
                              <code 
                                {...props}
                                style={{
                                  wordBreak: "break-all",
                                  overflowWrap: "break-word",
                                  ...props.style
                                }}
                              >
                                {children}
                              </code>
                            )
                          }
                          return (
                            <code 
                              {...props}
                              style={{
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                overflowWrap: "break-word",
                                ...props.style
                              }}
                            >
                              {children}
                            </code>
                          )
                        },
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
                        navigator.clipboard.writeText(processMessage(message))
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
  }
  
  export const DocumentChat: React.FC<DocumentChatProps> = ({
    user,
    documentId,
    documentName,
    initialChatId,
    onChatCreated,
    onChunkIndexChange,
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
    const [isReasoningActive, setIsReasoningActive] = useState(() => {
      const storedValue = localStorage.getItem(REASONING_STATE_KEY)
      return storedValue ? JSON.parse(storedValue) : true
    })
    const chatBoxRef = useRef<ChatBoxRef>(null)
    // Citation state management
    // const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null)
    // Add retryIsStreaming state
    const [retryIsStreaming, setRetryIsStreaming] = useState(false)

    useEffect(() => {
      if (isReasoningActive) {
        console.log("isReasoningActive", isReasoningActive)
      }
    }, [isReasoningActive])

    
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
    } = useChatStream(chatId, undefined, setRetryIsStreaming, true, handleSetChatId) // preventNavigation = true
    
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

    useEffect(() => {
      localStorage.setItem(REASONING_STATE_KEY, JSON.stringify(isReasoningActive))
    }, [isReasoningActive])
  
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
    const handleSend = async (
      messageToSend: string,
      metadata?: AttachmentMetadata[],
      selectedSources: string[] = [],
    ) => {
      if (!messageToSend || isStreaming || retryIsStreaming) return
  
      setUserHasScrolled(false)
      setQuery("")
  
      // Automatically add the document ID to selected sources
      const sourcesWithDocument = [...selectedSources]
      if (!sourcesWithDocument.includes(documentId)) {
        sourcesWithDocument.push(documentId)
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
          sourcesWithDocument, // Use the sources array that includes the document ID
          isReasoningActive, // isReasoningActive
          false, // isAgenticMode
          null,
          [],
          metadata,
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

    const handleRetry = async (messageId: string) => {
      if (!messageId || isStreaming) return
      setRetryIsStreaming(true)
      await retryMessage(messageId, isReasoningActive, false)
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
      // onChunkIndexChange?.(chunkIndex || null)
      // console.log("citation", citation, "chunkIndex", chunkIndex)
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
  
          <div className="space-y-4">
            {messages.map((message: SelectPublicMessage, index: number) => (
              <Fragment key={message.externalId ?? index}>
                <ChatMessage
                  key={
                    message.externalId
                      ? `${message.externalId}-msg`
                      : `msg-${index}`
                  }
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
                    message.isRetrying ||
                    message.externalId === "current-resp"
                      ? dots
                      : ""
                  }
                  feedbackStatus={feedbackMap[message.externalId!] || null}
                  onFeedback={handleFeedback}
                  attachments={message.attachments || []}
                  citations={message.sources || []}
                  citationMap={undefined}
                  onCitationClick={handleCitationClick}
                  disableRetry={disableRetry}
                />
              </Fragment>
            ))}
  
            {currentResp && (
              <ChatMessage
                key={currentResp.messageId}
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
            isReasoningActive={isReasoningActive}
            setIsReasoningActive={setIsReasoningActive}
            user={user}
            hideButtons={true}
          />
        </div>
      </div>
    )
  }
  
  export default DocumentChat