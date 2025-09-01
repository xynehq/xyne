import { useRef, useState, useEffect, useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { api } from "@/api"
import {
  AttachmentMetadata,
  ChatSSEvents,
  Citation,
  SelectPublicMessage,
  ImageCitation,
} from "shared/types"
import { toast } from "@/hooks/use-toast"
import { ToolsListItem } from "@/types"

// Module-level storage for persistent EventSource connections
interface StreamState {
  es: EventSource
  partial: string
  thinking: string
  sources: Citation[]
  imageCitations: ImageCitation[]
  citationMap: Record<number, number>
  messageId?: string
  chatId?: string
  isStreaming: boolean
  isRetrying?: boolean
  subscribers: Set<() => void>
}

interface StreamInfo {
  partial: string
  thinking: string
  sources: Citation[]
  imageCitations: ImageCitation[]
  citationMap: Record<number, number>
  messageId?: string
  chatId?: string
  isStreaming: boolean
  isRetrying?: boolean
}

// Global map to store active streams - persists across component unmounts
const activeStreams = new Map<string, StreamState>()

// Helper function to parse HTML message input safely
const parseMessageInput = (htmlString: string) => {
  // Create a DOMParser instance for safer parsing
  const parser = new DOMParser()

  // Parse the HTML string as XML to avoid script execution
  const doc = parser.parseFromString(htmlString, "text/html")

  // Check if parsing failed
  if (doc.querySelector("parsererror")) {
    // If parsing failed, treat as plain text
    return [{ type: "text" as const, value: htmlString }]
  }

  const parts: Array<{ type: "text" | "pill" | "link"; value: any }> = []

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) {
        parts.push({ type: "text", value: node.textContent })
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement

      // Only process safe elements and ignore potentially dangerous ones
      const tagName = el.tagName.toLowerCase()

      // Skip dangerous elements completely
      if (
        [
          "script",
          "style",
          "iframe",
          "object",
          "embed",
          "form",
          "input",
        ].includes(tagName)
      ) {
        return
      }

      if (
        tagName === "a" &&
        el.classList.contains("reference-pill") &&
        (el.dataset.docId || el.dataset.referenceId)
      ) {
        const entity = el.dataset.entity
        const isContactPill =
          entity === "OtherContacts" || entity === "Contacts"
        let imgSrc: string | null = null
        const imgElement = el.querySelector("img")
        if (imgElement) {
          // Validate image source to prevent javascript: URLs
          const src = imgElement.getAttribute("src")
          if (
            src &&
            (src.startsWith("http://") ||
              src.startsWith("https://") ||
              src.startsWith("data:image/") ||
              src.startsWith("/"))
          ) {
            imgSrc = src
          }
        }
        parts.push({
          type: "pill",
          value: {
            docId: el.dataset.docId || el.dataset.referenceId!,
            url: isContactPill ? null : el.getAttribute("href"),
            title: el.getAttribute("title"),
            app: el.dataset.app,
            entity: entity,
            imgSrc: imgSrc,
            wholeSheet:
              el.dataset.wholeSheet === "true"
                ? true
                : el.dataset.wholeSheet === "false"
                  ? false
                  : undefined,
            threadId: el.dataset.threadId,
          },
        })
      } else if (tagName === "a" && el.getAttribute("href")) {
        const href = el.getAttribute("href")
        // Validate href to prevent javascript: URLs and other dangerous protocols
        if (
          href &&
          (href.startsWith("http://") ||
            href.startsWith("https://") ||
            href.startsWith("/") ||
            href.startsWith("mailto:"))
        ) {
          if (
            !(
              el.classList.contains("reference-pill") &&
              (el.dataset.docId || el.dataset.referenceId)
            )
          ) {
            parts.push({
              type: "link",
              value: href,
            })
          } else {
            Array.from(el.childNodes).forEach(walk)
          }
        } else {
          // Invalid href, process children as text
          Array.from(el.childNodes).forEach(walk)
        }
      } else {
        // For other elements, just process their children
        Array.from(el.childNodes).forEach(walk)
      }
    }
  }

  Array.from(doc.body.childNodes).forEach(walk)
  return parts
}

// Notify all subscribers of a stream state change
const notifySubscribers = (streamId: string) => {
  const stream = activeStreams.get(streamId)
  if (stream) {
    stream.subscribers.forEach((callback) => callback())
  }
}


// Helper function to append reasoning data to stream state
const appendReasoningData = (streamState: StreamState, data: string) => {
  try {
    const stepData = JSON.parse(data)
    
    // If this is a valid reasoning step, add it as a new line
    if (stepData.step || stepData.text) {
      streamState.thinking += data + '\n'
    } else {
      // Fallback to simple text accumulation
      streamState.thinking += data
    }
  } catch (e) {
    // Not JSON, just add as text
    streamState.thinking += data
  }
}

export async function createAuthEventSource(url: string): Promise<EventSource> {
  return new Promise((resolve, reject) => {
    let triedRefresh = false

    const make = () => {
      const es = new EventSource(url, { withCredentials: true })

      es.onopen = () => resolve(es)

      es.onerror = async () => {
        // es.close()

        if (!triedRefresh) {
          triedRefresh = true
          // Attempt token refresh
          const refresh = await fetch("/api/v1/refresh-token", {
            method: "POST",
            credentials: "include",
          })
          if (!refresh.ok) return reject(new Error("Token refresh failed"))

          // Retry opening the stream
          make()
        } else {
          reject(new Error("SSE connection failed after refresh"))
        }
      }
    }

    make()
  })

}

// Start a new stream or continue existing one
export const startStream = async (
  streamKey: string,
  messageToSend: string,
  selectedSources: string[] = [],
  isReasoningActive: boolean = true,
  isAgenticMode: boolean = false,
  queryClient?: any,
  router?: any,
  onTitleUpdate?: (title: string) => void,
  agentIdFromChatParams?: string | null,
  toolsList?: ToolsListItem[],
  metadata?: AttachmentMetadata[],
  preventNavigation?: boolean,
  setChatId?: (chatId: string) => void,
): Promise<void> => {
  if (!messageToSend) return

  // Check if stream already exists and is active
  if (
    activeStreams.has(streamKey) &&
    activeStreams.get(streamKey)?.isStreaming
  ) {
    return
  }

  // Parse message content
  const parsedMessageParts = parseMessageInput(messageToSend)
  const hasRichContent = parsedMessageParts.some(
    (part) => part.type === "pill" || part.type === "link",
  )

  let finalMessagePayload: string
  if (hasRichContent) {
    finalMessagePayload = JSON.stringify(parsedMessageParts)
  } else {
    finalMessagePayload = parsedMessageParts
      .filter((part) => part.type === "text")
      .map((part) => part.value)
      .join("")
  }

  const isNewChat = streamKey.length === 36 && streamKey.includes("-")
  const chatId = isNewChat ? null : streamKey

  const url = new URL(`/api/v1/message/create`, window.location.origin)
  if (chatId) {
    url.searchParams.append("chatId", chatId)
  }
  if (isAgenticMode) {
    url.searchParams.append("agentic", "true")
  }
  url.searchParams.append("modelId", "gpt-4o-mini")
  url.searchParams.append("message", finalMessagePayload)

  if (isReasoningActive) {
    url.searchParams.append("isReasoningEnabled", "true")
  }

  // Add selectedSources parameter if provided
  if (selectedSources && selectedSources.length > 0) {
    url.searchParams.append("selectedSources", JSON.stringify(selectedSources))
  }

  // Add toolsList parameter if provided
  if (toolsList && toolsList.length > 0) {
    url.searchParams.append("toolsList", JSON.stringify(toolsList))
  }

  // Add metadata parameter if provided
  if (metadata && metadata.length > 0) {
    url.searchParams.append("attachmentMetadata", JSON.stringify(metadata))
  }

  const agentIdToUse = agentIdFromChatParams
  if (agentIdToUse) {
    url.searchParams.append("agentId", agentIdToUse)
  }

  // Create EventSource with auth handling
  let eventSource: EventSource
  try {
    eventSource = await createAuthEventSource(url.toString())
  } catch (err) {
    console.error("Failed to create EventSource:", err)
    toast({
      title: "Failed to create EventSource",
      description: "Failed to create EventSource",
      variant: "destructive",
    })
    return
  }

  const streamState: StreamState = {
    es: eventSource,
    partial: "",
    thinking: "",
    sources: [],
    imageCitations: [],
    citationMap: {},
    messageId: undefined,
    chatId: chatId || undefined,
    isStreaming: true,
    isRetrying: false,
    subscribers: new Set(),
  }

  activeStreams.set(streamKey, streamState)

  streamState.es.addEventListener(ChatSSEvents.ResponseUpdate, (event) => {
    streamState.partial += event.data
    notifySubscribers(streamKey)
  })

  streamState.es.addEventListener(ChatSSEvents.Reasoning, (event) => {
    appendReasoningData(streamState, event.data)
    notifySubscribers(streamKey)
  })

  streamState.es.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
    const { contextChunks, citationMap } = JSON.parse(event.data)
    streamState.sources = contextChunks
    streamState.citationMap = citationMap
    notifySubscribers(streamKey)
  })

  streamState.es.addEventListener(ChatSSEvents.AttachmentUpdate, (event) => {
    const { attachments } = JSON.parse(event.data)
    // Update the last user message in the query cache with attachment data
    if (queryClient && streamState.chatId) {
      queryClient.setQueryData(
        ["chatHistory", streamState.chatId],
        (old: { messages: SelectPublicMessage[] } | undefined) => {
          if (!old?.messages || old.messages.length === 0) return old
          const updatedMessages = [...old.messages]
          for (let i = updatedMessages.length - 1; i >= 0; i--) {
            if (updatedMessages[i].messageRole === "user") {
              updatedMessages[i] = {
                ...updatedMessages[i],
                attachments,
              }
              break
            }
          }
          return {
            ...old,
            messages: updatedMessages,
          }
        },
      )
    }
    notifySubscribers(streamKey)
  })

  streamState.es.addEventListener(ChatSSEvents.ImageCitationUpdate, (event) => {
    const imageCitation: ImageCitation = JSON.parse(event.data)
    streamState.imageCitations = imageCitation

    notifySubscribers(streamKey)
  })

  streamState.es.addEventListener(ChatSSEvents.ResponseMetadata, (event) => {
    const { chatId: realId, messageId } = JSON.parse(event.data)
    streamState.messageId = messageId
    streamState.chatId = realId

    if (realId && streamKey !== realId && !streamKey.match(/^[a-z0-9]+$/)) {
      activeStreams.delete(streamKey)
      activeStreams.set(realId, streamState)

      // Only navigate if preventNavigation is not true
      if (
        !preventNavigation &&
        router &&
        router.state.location.pathname === "/chat"
      ) {
        const isGlobalDebugMode =
          import.meta.env.VITE_SHOW_DEBUG_INFO === "true"
        router.navigate({
          to: "/chat/$chatId",
          params: { chatId: realId },
          search: isGlobalDebugMode ? { debug: true } : {},
          replace: true,
        })
      }

      if (queryClient) {
        const oldData = queryClient.getQueryData(["chatHistory", null])
        if (oldData) {
          queryClient.setQueryData(["chatHistory", realId], oldData)
          queryClient.removeQueries({ queryKey: ["chatHistory", null] })
        }
      }
      streamKey = realId
      if (setChatId) {
        setChatId(realId)
      }
    }
    notifySubscribers(streamKey)
  })

  streamState.es.addEventListener(ChatSSEvents.ChatTitleUpdate, (event) => {
    if (onTitleUpdate) {
      onTitleUpdate(event.data)
    }
  })

  streamState.es.addEventListener(ChatSSEvents.End, () => {
    streamState.isStreaming = false
    streamState.es.close()

    if (streamKey && queryClient) {
      queryClient.invalidateQueries({ queryKey: ["chatHistory", streamKey] })
    }
    notifySubscribers(streamKey)
  })

  streamState.es.addEventListener(ChatSSEvents.Error, (event) => {
    console.error(`Stream error:`, event.data)
    streamState.isStreaming = false
    streamState.es.close()

    // Clear failed messages from cache for new chats
    if (!chatId && queryClient) {
      queryClient.removeQueries({ queryKey: ["chatHistory", null] })
    }

    toast({
      title: "Error",
      description: event.data,
      variant: "destructive",
    })
    notifySubscribers(streamKey)
  })

  streamState.es.onerror = (error) => {
    console.error(`EventSource error:`, error)
    streamState.isStreaming = false
    streamState.es.close()

    // Clear failed messages from cache for new chats
    if (!chatId && queryClient) {
      queryClient.removeQueries({ queryKey: ["chatHistory", null] })
    }

    toast({
      title: "Error",
      description: "Connection error. Please try again.",
      variant: "destructive",
    })
    notifySubscribers(streamKey)
  }
}

// Stop a specific stream
export const stopStream = async (
  streamKey: string,
  queryClient?: any,
  setRetryIsStreaming?: (isRetrying: boolean) => void,
): Promise<void> => {
  const stream = activeStreams.get(streamKey)

  if (!stream) return

  if (setRetryIsStreaming) {
    setRetryIsStreaming(false)
    stream.isRetrying = false
  }

  stream.isStreaming = false
  stream.es.close()

  const currentChatId = stream.chatId || streamKey
  if (currentChatId) {
    try {
      await api.chat.stop.$post({
        json: { chatId: currentChatId },
      })

      if (queryClient) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await queryClient.refetchQueries({
          queryKey: ["chatHistory", currentChatId],
        })
      }
    } catch (error) {
      console.error("Failed to send stop request:", error)
      toast({
        title: "Error",
        description: "Could not stop streaming.",
        variant: "destructive",
        duration: 1000,
      })
    }
  }
  notifySubscribers(currentChatId)
  activeStreams.delete(streamKey)
}

// Get current stream state (for hook consumers)
export const getStreamState = (streamKey: string): StreamInfo => {
  const stream = activeStreams.get(streamKey)

  if (!stream) {
    return {
      partial: "",
      thinking: "",
      sources: [],
      imageCitations: [],
      citationMap: {},
      messageId: undefined,
      chatId: undefined,
      isStreaming: false,
    }
  }

  return {
    partial: stream.partial,
    thinking: stream.thinking,
    sources: stream.sources,
    imageCitations: stream.imageCitations,
    citationMap: stream.citationMap,
    messageId: stream.messageId,
    chatId: stream.chatId,
    isStreaming: stream.isStreaming,
  }
}

// React hook that subscribes to stream updates
export const useChatStream = (
  chatId: string | null,
  onTitleUpdate?: (title: string) => void,
  setRetryIsStreaming?: (isRetrying: boolean) => void,
  preventNavigation?: boolean,
  setChatId?: (chatId: string) => void,
) => {
  const queryClient = useQueryClient()
  const router = useRouter()

  const streamKeyRef = useRef<string | null>(null)
  const lastChatIdRef = useRef<string | null>(null)

  if (chatId !== lastChatIdRef.current) {
    streamKeyRef.current = chatId ?? crypto.randomUUID()
    lastChatIdRef.current = chatId
  }

  if (!streamKeyRef.current) {
    streamKeyRef.current = chatId ?? crypto.randomUUID()
  }

  const currentStreamKey = chatId ?? streamKeyRef.current

  const [streamInfo, setStreamInfo] = useState<StreamInfo>(() =>
    getStreamState(currentStreamKey),
  )
  const subscriberRef = useRef<(() => void) | null>(null)
  const currentStreamKeyRef = useRef<string>(currentStreamKey)

  useEffect(() => {
    currentStreamKeyRef.current = currentStreamKey
  }, [currentStreamKey])

  useEffect(() => {
    const stream = activeStreams.get(
      router.state.location.pathname.split("/").pop() || "",
    )
    if (setRetryIsStreaming) {
      setRetryIsStreaming(stream?.isRetrying || false)
    }
  }, [router.state.location.pathname])

  useEffect(() => {
    const streamKey = currentStreamKey

    if (subscriberRef.current) {
      activeStreams.forEach((stream, key) => {
        if (subscriberRef.current) {
          stream.subscribers.delete(subscriberRef.current)
        }
      })
    }

    const subscriber = () => {
      if (currentStreamKeyRef.current === streamKey) {
        setStreamInfo(getStreamState(streamKey))
      }
    }

    subscriberRef.current = subscriber

    const stream = activeStreams.get(streamKey)
    if (stream) {
      stream.subscribers.add(subscriber)
      subscriber()
    } else {
      setStreamInfo(getStreamState(streamKey))
    }

    return () => {
      const stream = activeStreams.get(streamKey)
      if (stream && subscriberRef.current) {
        stream.subscribers.delete(subscriberRef.current)
      }
    }
  }, [currentStreamKey])

  const wrappedStartStream = useCallback(
    async (
      messageToSend: string,
      selectedSources: string[] = [],
      isReasoningActive: boolean = true,
      isAgenticMode: boolean = false,
      agentIdFromChatParams?: string | null,
      toolsList?: ToolsListItem[],
      metadata?: AttachmentMetadata[],
    ) => {
      const streamKey = currentStreamKey

      await startStream(
        streamKey,
        messageToSend,
        selectedSources,
        isReasoningActive,
        isAgenticMode,
        queryClient,
        router,
        onTitleUpdate,
        agentIdFromChatParams,
        toolsList,
        metadata,
        preventNavigation,
        setChatId,
      )

      setStreamInfo(getStreamState(streamKey))

      const stream = activeStreams.get(streamKey)
      if (stream && subscriberRef.current) {
        stream.subscribers.add(subscriberRef.current)
        subscriberRef.current()
      }

      streamKeyRef.current = streamKey
    },
    [currentStreamKey, queryClient, router, onTitleUpdate, preventNavigation],
  )

  const wrappedStopStream = useCallback(async () => {
    await stopStream(currentStreamKey, queryClient, setRetryIsStreaming)
  }, [currentStreamKey, queryClient, setRetryIsStreaming])

  const retryMessage = useCallback(
    async (
      messageId: string,
      isReasoningActive: boolean = false,
      isAgenticMode: boolean = false,
      attachmentFileIds?: string[],
    ) => {
      if (!messageId) return

      let isError = false
      let targetMessageId: string | null = null

      if (chatId) {
        try {
          await queryClient.fetchQuery({
            queryKey: ["chatHistory", chatId],
          })
        } catch (err) {
          console.error(
            "Failed to fetch latest chat history before retry:",
            err,
          )
        }
      }

      if (chatId) {
        queryClient.setQueryData(["chatHistory", chatId], (old: any) => {
          if (!old?.messages) return old
          return {
            ...old,
            messages: old.messages.map((m: any) =>
              m.externalId === messageId && m.messageRole === "assistant"
                ? { ...m, isRetrying: true, message: "", thinking: "" }
                : m,
            ),
          }
        })

        const chatData = queryClient.getQueryData<any>(["chatHistory", chatId])
        if (chatData && chatData.messages) {
          const matched = chatData.messages.find(
            (msg: any) => msg.externalId === messageId,
          )

          if (matched && matched.errorMessage && matched.errorMessage !== "") {
            isError = true
            const matchedIndex = chatData.messages.findIndex(
              (msg: any) => msg.externalId === messageId,
            )

            targetMessageId = crypto.randomUUID()
            const assistantMessage = {
              ...JSON.parse(JSON.stringify(matched)),
              chatExternalId: chatId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              externalId: targetMessageId,
              messageRole: "assistant",
              message: "",
              isRetrying: true,
              sources: [],
              thinking: "",
              errorMessage: "",
            }

            queryClient.setQueryData(["chatHistory", chatId], (old: any) => {
              if (!old?.messages) return old
              const insertIndex = matchedIndex + 1
              const updatedMessages = [
                ...old.messages.slice(0, insertIndex),
                assistantMessage,
                ...old.messages.slice(insertIndex),
              ]

              return {
                ...old,
                messages: updatedMessages,
              }
            })

            queryClient.setQueryData(["chatHistory", chatId], (old: any) => {
              if (!old?.messages) return old
              return {
                ...old,
                messages: old.messages.map((m: any) => {
                  if (m.externalId === messageId && m.messageRole === "user") {
                    return {
                      ...m,
                      errorMessage: "",
                    }
                  }
                  return m
                }),
              }
            })
          }
        }
      }

      const url = new URL(`/api/v1/message/retry`, window.location.origin)
      url.searchParams.append("messageId", encodeURIComponent(messageId))
      if (isReasoningActive) {
        url.searchParams.append("isReasoningEnabled", "true")
      }
      if (isAgenticMode) {
        url.searchParams.append("agentic", "true")
      }
      if (attachmentFileIds) {
        url.searchParams.append(
          "attachmentFileIds",
          attachmentFileIds.join(","),
        )
      }

      let eventSource: EventSource
      try {
        eventSource = await createAuthEventSource(url.toString())
      } catch (err) {
        console.error("Failed to create EventSource:", err)
        toast({
          title: "Failed to create EventSource",
          description: "Failed to create EventSource",
          variant: "destructive",
        })
        return
      }

      if (setRetryIsStreaming) {
        setRetryIsStreaming(true)
      }

      const retryStreamKey = chatId || currentStreamKey

      const streamState: StreamState = {
        es: eventSource,
        partial: "",
        thinking: "",
        sources: [],
        imageCitations: [],
        citationMap: {},
        messageId: undefined,
        chatId: chatId || undefined,
        isStreaming: false,
        isRetrying: true,
        subscribers: new Set(),
      }

      activeStreams.set(retryStreamKey, streamState)

      if (
        subscriberRef.current &&
        retryStreamKey === currentStreamKeyRef.current
      ) {
        streamState.subscribers.add(subscriberRef.current)
        subscriberRef.current()
      }
      notifySubscribers(retryStreamKey)

      const patchResponseContent = (delta: string, isFinal = false) => {
        if (!chatId) return
        queryClient.setQueryData(["chatHistory", chatId], (old: any) => {
          if (!old?.messages) return old
          return {
            ...old,
            messages: old.messages.map((m: any) =>
              (
                isError
                  ? m.externalId === targetMessageId
                  : m.externalId === messageId && m.messageRole === "assistant"
              )
                ? {
                    ...m,
                    message: isFinal ? delta : (m.message || "") + delta,
                    isRetrying: !isFinal,
                  }
                : m,
            ),
          }
        })
      }

      const patchReasoningContent = (delta: string) => {
        if (!chatId) return
        queryClient.setQueryData(["chatHistory", chatId], (old: any) => {
          if (!old?.messages) return old
          return {
            ...old,
            messages: old.messages.map((m: any) =>
              (
                isError
                  ? m.externalId === targetMessageId
                  : m.externalId === messageId && m.messageRole === "assistant"
              )
                ? {
                    ...m,
                    thinking: (m.thinking || "") + delta,
                  }
                : m,
            ),
          }
        })
      }

      eventSource.addEventListener(ChatSSEvents.ResponseUpdate, (event) => {
        streamState.partial += event.data
        patchResponseContent(event.data)
      })

      eventSource.addEventListener(ChatSSEvents.Reasoning, (event) => {
        
        appendReasoningData(streamState, event.data)
        patchReasoningContent(event.data)
      })

      eventSource.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
        const { contextChunks, citationMap } = JSON.parse(event.data)
        streamState.sources = contextChunks
        streamState.citationMap = citationMap
      })

      eventSource.addEventListener(ChatSSEvents.AttachmentUpdate, (event) => {
        const { attachments } = JSON.parse(event.data)
        // Update the last user message in the query cache with attachment data
        if (queryClient && streamState.chatId) {
          queryClient.setQueryData(
            ["chatHistory", streamState.chatId],
            (old: any) => {
              if (!old?.messages || old.messages.length === 0) return old
              const updatedMessages = [...old.messages]
              for (let i = updatedMessages.length - 1; i >= 0; i--) {
                if (updatedMessages[i].messageRole === "user") {
                  updatedMessages[i] = {
                    ...updatedMessages[i],
                    attachments,
                  }
                  break
                }
              }
              return {
                ...old,
                messages: updatedMessages,
              }
            },
          )
        }
        notifySubscribers(retryStreamKey)
      })

      eventSource.addEventListener(
        ChatSSEvents.ImageCitationUpdate,
        (event) => {
          const imageCitation: ImageCitation = JSON.parse(event.data)
          streamState.imageCitations = imageCitation
        },
      )

      eventSource.addEventListener(ChatSSEvents.ResponseMetadata, (event) => {
        const { messageId: newMessageId } = JSON.parse(event.data)
        streamState.messageId = newMessageId
      })

      eventSource.addEventListener(ChatSSEvents.End, () => {
        patchResponseContent(streamState.partial)
        if (chatId) {
          queryClient.invalidateQueries({ queryKey: ["chatHistory", chatId] })
        }
        if (setRetryIsStreaming) {
          setRetryIsStreaming(false)
        }
        streamState.isRetrying = false
        notifySubscribers(retryStreamKey)
        activeStreams.delete(retryStreamKey)
        eventSource.close()
      })

      eventSource.addEventListener(ChatSSEvents.Error, (event) => {
        console.error("Retry stream error:", event.data)
        toast({
          title: "Error",
          description: event.data,
          variant: "destructive",
        })
        if (setRetryIsStreaming) {
          setRetryIsStreaming(false)
        }
        streamState.isRetrying = false
        notifySubscribers(retryStreamKey)
        activeStreams.delete(retryStreamKey)
        eventSource.close()
      })

      eventSource.onerror = () => {
        console.error("Retry EventSource error")
        if (setRetryIsStreaming) {
          setRetryIsStreaming(false)
        }
        streamState.isRetrying = false
        notifySubscribers(retryStreamKey)
        activeStreams.delete(retryStreamKey)
        eventSource.close()
      }
    },
    [currentStreamKey, queryClient, chatId, setRetryIsStreaming],
  )

  return {
    ...streamInfo,
    startStream: wrappedStartStream,
    stopStream: wrappedStopStream,
    retryMessage,
    onTitleUpdate,
  }
}
