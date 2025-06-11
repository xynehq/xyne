import { useRef, useState, useEffect, useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { api } from "@/api"
import { ChatSSEvents, Citation } from "shared/types"
import { toast } from "@/hooks/use-toast"

// Module-level storage for persistent EventSource connections
interface StreamState {
  es: EventSource
  partial: string
  thinking: string
  sources: Citation[]
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
  citationMap: Record<number, number>
  messageId?: string
  chatId?: string
  isStreaming: boolean
  isRetrying?: boolean
}

// Global map to store active streams - persists across component unmounts
const activeStreams = new Map<string, StreamState>()

// Helper function to parse HTML message input
const parseMessageInput = (htmlString: string) => {
  const container = document.createElement("div")
  container.innerHTML = htmlString
  const parts: Array<any> = []

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) {
        parts.push({ type: "text", value: node.textContent })
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (
        el.tagName.toLowerCase() === "a" &&
        el.classList.contains("reference-pill") &&
        (el.dataset.docId || el.dataset.referenceId)
      ) {
        const entity = el.dataset.entity
        const isContactPill =
          entity === "OtherContacts" || entity === "Contacts"
        let imgSrc: string | null = null
        const imgElement = el.querySelector("img")
        if (imgElement) {
          imgSrc = imgElement.getAttribute("src")
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
          },
        })
      } else if (el.tagName.toLowerCase() === "a" && el.getAttribute("href")) {
        if (
          !(
            el.classList.contains("reference-pill") &&
            (el.dataset.docId || el.dataset.referenceId)
          )
        ) {
          parts.push({
            type: "link",
            value: el.getAttribute("href") || "",
          })
        } else {
          Array.from(el.childNodes).forEach(walk)
        }
      }
    }
  }

  Array.from(container.childNodes).forEach(walk)
  return parts
}

// Notify all subscribers of a stream state change
const notifySubscribers = (streamId: string) => {
  const stream = activeStreams.get(streamId)
  if (stream) {
    stream.subscribers.forEach(callback => callback())
  }
}

// Start a new stream or continue existing one
export const startStream = async (
  streamKey: string,
  messageToSend: string,
  selectedSources: string[] = [],
  isReasoningActive: boolean = true,
  queryClient?: any,
  router?: any,
  onTitleUpdate?: (title: string) => void
): Promise<void> => {
  if (!messageToSend) {
    console.log("[SSEManager] Cannot start stream: no message provided")
    return
  }
  
  // Check if stream already exists and is active
  if (activeStreams.has(streamKey) && activeStreams.get(streamKey)?.isStreaming) {
    console.log(`[SSEManager] Stream ${streamKey} already active, skipping`)
    return
  }

  console.log(`[SSEManager] Starting stream for ${streamKey}`)

  // Parse message content
  const parsedMessageParts = parseMessageInput(messageToSend)
  const hasRichContent = parsedMessageParts.some(
    (part) => part.type === "pill" || part.type === "link"
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

  // Determine if this is a new chat (streamKey is a UUID) or existing chat
  const isNewChat = !streamKey.match(/^[a-z0-9]+$/) // Real chatIds are typically shorter alphanumeric
  const chatId = isNewChat ? null : streamKey

  // Construct URL
  const url = new URL(`/api/v1/message/create`, window.location.origin)
  if (chatId) {
    url.searchParams.append("chatId", chatId)
    console.log(`[SSEManager] Using existing chatId: ${chatId}`)
  } else {
    console.log(`[SSEManager] Starting new chat with temporary key: ${streamKey}`)
  }
  url.searchParams.append("modelId", "gpt-4o-mini")
  url.searchParams.append("message", finalMessagePayload)
  if (isReasoningActive) {
    url.searchParams.append("isReasoningEnabled", "true")
  }

  console.log(`[SSEManager] SSE URL: ${url.toString()}`)

  // Create EventSource
  const eventSource = new EventSource(url.toString(), {
    withCredentials: true,
  })

  // Initialize stream state
  const streamState: StreamState = {
    es: eventSource,
    partial: "",
    thinking: "",
    sources: [],
    citationMap: {},
    messageId: undefined,
    chatId: chatId || undefined,
    isStreaming: true,
    subscribers: new Set(),
  }

  activeStreams.set(streamKey, streamState)
  console.log(`[SSEManager] Created stream state for ${streamKey}`)

  // Setup event listeners
  eventSource.addEventListener('open', () => {
    console.log(`[SSEManager] EventSource connection opened for ${streamKey}`)
  })

  eventSource.addEventListener(ChatSSEvents.Start, () => {
    console.log(`[SSEManager] Stream started for ${streamKey}`)
  })

  eventSource.addEventListener(ChatSSEvents.ResponseUpdate, (event) => {
    console.log(`[SSEManager] Response update for ${streamKey}: ${event.data.slice(0, 50)}...`)
    streamState.partial += event.data
    notifySubscribers(streamKey)
  })

  eventSource.addEventListener(ChatSSEvents.Reasoning, (event) => {
    console.log(`[SSEManager] Reasoning for ${streamKey}: ${event.data.slice(0, 50)}...`)
    streamState.thinking += event.data
    notifySubscribers(streamKey)
  })

  eventSource.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
    console.log(`[SSEManager] Citations update for ${streamKey}`)
    const { contextChunks, citationMap } = JSON.parse(event.data)
    streamState.sources = contextChunks
    streamState.citationMap = citationMap
    notifySubscribers(streamKey)
  })

  eventSource.addEventListener(ChatSSEvents.ResponseMetadata, (event) => {
    const { chatId: realId, messageId } = JSON.parse(event.data)
    console.log(`[SSEManager] ResponseMetadata for ${streamKey} - chatId: ${realId}, messageId: ${messageId}`)
    
    streamState.messageId = messageId
    streamState.chatId = realId
      
    // If this is a new chat (UUID streamKey) and we got the real chatId, close stream and navigate
    if (realId && streamKey !== realId && !streamKey.match(/^[a-z0-9]+$/)) {
      console.log(`[SSEManager] New chat created, closing UUID stream and will remount with ${realId}`)
      activeStreams.delete(streamKey)
      console.log(`[SSEManager] New chat created, transferring stream from UUID key to real chatId: ${realId}`)
      // Transfer the active stream to the real chatId so it stays open through navigation
      activeStreams.set(realId, streamState)
      notifySubscribers(realId);
      // Handle navigation for new chats - this will cause component remount with real chatId
      if (router && router.state.location.pathname === "/chat") {
        console.log(`[SSEManager] Navigating to new chat: /chat/${realId}`)
        const isGlobalDebugMode = import.meta.env.VITE_SHOW_DEBUG_INFO === "true"
          router.navigate({
            to: "/chat/$chatId",
            params: { chatId: realId },
            search: !isGlobalDebugMode ? {} : {},
            replace: true,
          })
      }

      // Update React Query cache for new chats
      if (queryClient) {
        console.log(`[SSEManager] Transferring cache from ${streamKey} to ${realId}`)
        const oldData = queryClient.getQueryData(["chatHistory", null])
        if (oldData) {
          queryClient.setQueryData(["chatHistory", realId], oldData)
          queryClient.removeQueries({ queryKey: ["chatHistory", null] })
        }
      }
      
      // Don't notify subscribers - the stream is closed and component will remount
      streamKey = realId
    }
    notifySubscribers(streamKey)
  })

  eventSource.addEventListener(ChatSSEvents.ChatTitleUpdate, (event) => {
    console.log(`[SSEManager] Title update for ${streamKey}: ${event.data}`)
    if (onTitleUpdate) {
      onTitleUpdate(event.data)
    }
  })

  eventSource.addEventListener(ChatSSEvents.End, () => {
    console.log(`[SSEManager] Stream ended for ${streamKey}`)
    streamState.isStreaming = false
    
    // Invalidate and refetch chat history using the final chatId
    const finalChatId = streamState.chatId || streamKey
    if (finalChatId && queryClient) {
      console.log(`[SSEManager] Invalidating cache for chatId: ${finalChatId}`)
      queryClient.invalidateQueries({ queryKey: ["chatHistory", finalChatId] })
    }
    
    notifySubscribers(finalChatId)
    
    // Don't remove the stream here - keep it for potential reconnection
    // Only clean up the EventSource
    eventSource.close()
  })

  eventSource.addEventListener(ChatSSEvents.Error, (event) => {
    console.error(`[SSEManager] Stream error for ${streamKey}:`, event.data)
    streamState.isStreaming = false
    eventSource.close()
    
    toast({
      title: "Error",
      description: event.data,
      variant: "destructive",
    })
    const finalChatId = streamState.chatId || streamKey
    notifySubscribers(finalChatId)
  })

  eventSource.onerror = (error) => {
    console.error(`[SSEManager] EventSource error for ${streamKey}:`, error)
    streamState.isStreaming = false
    
    toast({
      title: "Error",
      description: "Connection error. Please try again.",
      variant: "destructive",
    })
    const finalChatId = streamState.chatId || streamKey
    notifySubscribers(finalChatId)
    eventSource.close()
  }
}

// Stop a specific stream
export const stopStream = async (streamKey: string, queryClient?: any, setRetryIsStreaming?: (isRetrying: boolean) => void): Promise<void> => {
  console.log('[useChatStream] stopStream called with streamKey:', streamKey)
  const stream = activeStreams.get(streamKey)
  
  if (!stream) {
    console.log(`[SSEManager] No stream found for ${streamKey}`)
    return
  }

  console.log(`[SSEManager] Stopping stream for ${streamKey}`)
  
  stream.isStreaming = false
  stream.es.close()
  
  // Set retry streaming flag to false when stopping
  if (setRetryIsStreaming) {
    setRetryIsStreaming(false)
  }
  
  // Send stop request to backend using the real chatId if available
  const currentChatId = stream.chatId || streamKey  
  if (currentChatId) {
    console.log(`[SSEManager] Sending stop request for chatId: ${currentChatId}`)
    try {
      await api.chat.stop.$post({
        json: { chatId: currentChatId },
      })
      
      // Only invalidate cache for normal queries, not for retry streams
      if (queryClient && !stream.isRetrying) {
        await new Promise(resolve => setTimeout(resolve, 500))
        // Force immediate refetch to ensure the stopped message appears as saved
        console.log(`[SSEManager] Force refetching chat history for persistence`)
        await queryClient.refetchQueries({ queryKey: ["chatHistory", currentChatId] })
      } else if (stream.isRetrying) {
        console.log(`[SSEManager] Skipping cache invalidation for retry stop`)
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
    citationMap: stream.citationMap,
    messageId: stream.messageId,
    chatId: stream.chatId,
    isStreaming: stream.isStreaming,
  }
}

// Periodic check for dead streams:
setInterval(() => {
  activeStreams.forEach((stream, key) => {
    if (stream.es.readyState === EventSource.CLOSED) {
      activeStreams.delete(key);
    }
  });
}, 30000);

// React hook that subscribes to stream updates
export const useChatStream = (
  chatId: string | null,
  onTitleUpdate?: (title: string) => void,
  setRetryIsStreaming?: (isRetrying: boolean) => void
) => {
  const queryClient = useQueryClient()
  const router = useRouter()
  
  // Generate a consistent stream key for this hook instance
  const streamKeyRef = useRef<string | null>(null)
  if (!streamKeyRef.current) {
    streamKeyRef.current = chatId ?? crypto.randomUUID()
  }
  
  // Use the current chatId as the stream key, or the generated UUID for new chats
  const currentStreamKey = chatId ?? streamKeyRef.current
  
  const [streamInfo, setStreamInfo] = useState<StreamInfo>(() => getStreamState(currentStreamKey))
  const subscriberRef = useRef<(() => void) | null>(null)

  // Subscribe to stream updates
  useEffect(() => {
    const streamKey = currentStreamKey
    console.log(`[useChatStream] Subscribing to stream ${streamKey}`)
    
    // Create subscriber function
    const subscriber = () => {
      console.log(`[useChatStream] Stream update received for ${streamKey}`)
      setStreamInfo(getStreamState(streamKey))
    }
    
    subscriberRef.current = subscriber
    
    // Add subscriber to the stream if it exists
    const stream = activeStreams.get(streamKey)
    if (stream) {
      stream.subscribers.add(subscriber)
      // Immediately call subscriber to get current state
      subscriber()
    } else {
      // Update initial state even if no stream exists yet
      setStreamInfo(getStreamState(streamKey))
    }
    
    // Cleanup subscription on unmount or chatId change
    return () => {
      console.log(`[useChatStream] Unsubscribing from stream ${streamKey}`)
      const stream = activeStreams.get(streamKey)
      if (stream && subscriberRef.current) {
        stream.subscribers.delete(subscriberRef.current)
      }
    }
  }, [currentStreamKey])

  // Wrapped functions that include necessary context
  const wrappedStartStream = useCallback(async (
    messageToSend: string,
    selectedSources: string[] = [],
    isReasoningActive: boolean = true
  ) => {
    const streamKey = currentStreamKey
    console.log(`[useChatStream] Starting stream with key: ${streamKey}`)
    
    await startStream(
      streamKey,
      messageToSend,
      selectedSources,
      isReasoningActive,
      queryClient,
      router,
      onTitleUpdate
    )
    
    // Force immediate update of local state after starting stream
    setStreamInfo(getStreamState(streamKey))
    
    // Ensure our subscriber is registered for new streams
    const stream = activeStreams.get(streamKey)
    if (stream && subscriberRef.current) {
      stream.subscribers.add(subscriberRef.current)
      // Immediately push the current buffer into React state
      subscriberRef.current()
    }
    
    // Update our stream key reference for future operations
    streamKeyRef.current = streamKey
  }, [currentStreamKey, queryClient, router, onTitleUpdate])

  const wrappedStopStream = useCallback(async () => {
    await stopStream(currentStreamKey, queryClient, setRetryIsStreaming)
  }, [currentStreamKey, queryClient, setRetryIsStreaming])

  const retryMessage = useCallback(async (
    messageId: string,
    isReasoningActive: boolean = true
  ) => {
    if (!messageId) return

    console.log(`[useChatStream] Retrying message: ${messageId}`)

    // STEP 1 – mark old answer as streaming and clear its content
    if (chatId) {
      queryClient.setQueryData(["chatHistory", chatId], (old: any) => {
        if (!old?.messages) return old
        return {
          ...old,
          messages: old.messages.map((m: any) =>
            m.externalId === messageId
              ? { ...m, isRetrying: true, message: "" } // reset content, keep position
              : m,
          ),
        }
      })
    }

    const url = new URL(`/api/v1/message/retry`, window.location.origin)
    url.searchParams.append("messageId", encodeURIComponent(messageId))
    url.searchParams.append("isReasoningEnabled", `${isReasoningActive}`)

    // For retry, we'll use a simpler approach since it's less common
    // and doesn't need the full persistent stream management
    const eventSource = new EventSource(url.toString(), {
      withCredentials: true,
    })

    // Set retry streaming flag to true when starting
    if (setRetryIsStreaming) {
      setRetryIsStreaming(true)
    }

    // Use chatId directly for retry operations since after remount it will be the real chatId
    const retryStreamKey = chatId || currentStreamKey
    
    // Create temporary stream state for retry
    const streamState: StreamState = {
      es: eventSource,
      partial: "",
      thinking: "",
      sources: [],
      citationMap: {},
      messageId: undefined,
      chatId: chatId || undefined,
      isStreaming: false,
      isRetrying: true,
      subscribers: new Set(),
    }

    activeStreams.set(retryStreamKey, streamState)

    // Subscribe UI updates for retry stream
    if (subscriberRef.current) {
      streamState.subscribers.add(subscriberRef.current)
      subscriberRef.current()
    }

    // STEP 2 – helper to update the cached message in-place
    const patchContent = (delta: string, isFinal = false) => {
      if (!chatId) return
      queryClient.setQueryData(["chatHistory", chatId], (old: any) => {
        if (!old?.messages) return old
        return {
          ...old,
          messages: old.messages.map((m: any) =>
            m.externalId === messageId
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

    // Setup event listeners for retry
    eventSource.addEventListener(ChatSSEvents.ResponseUpdate, (event) => {
      streamState.partial += event.data
      patchContent(event.data) // incremental text
    })

    eventSource.addEventListener(ChatSSEvents.Reasoning, (event) => {
      streamState.thinking += event.data
    })

    eventSource.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
      const { contextChunks, citationMap } = JSON.parse(event.data)
      streamState.sources = contextChunks
      streamState.citationMap = citationMap
    })

    eventSource.addEventListener(ChatSSEvents.ResponseMetadata, (event) => {
      const { messageId: newMessageId } = JSON.parse(event.data)
      streamState.messageId = newMessageId
    })

    eventSource.addEventListener(ChatSSEvents.End, () => {
      patchContent(streamState.partial, true) // final text
      if (chatId) {
        queryClient.invalidateQueries({ queryKey: ["chatHistory", chatId] })
      }
      // Set retry streaming flag to false when done
      if (setRetryIsStreaming) {
        setRetryIsStreaming(false)
      }
      eventSource.close()
    })

    eventSource.addEventListener(ChatSSEvents.Error, (event) => {
      console.error("Retry stream error:", event.data)
      toast({
        title: "Error",
        description: event.data,
        variant: "destructive",
      })
      // Set retry streaming flag to false on error
      if (setRetryIsStreaming) {
        setRetryIsStreaming(false)
      }
      eventSource.close()
    })

    eventSource.onerror = () => {
      console.error("Retry EventSource error")
      // Set retry streaming flag to false on connection error
      if (setRetryIsStreaming) {
        setRetryIsStreaming(false)
      }
      eventSource.close()
    }
  }, [currentStreamKey, queryClient, chatId, setRetryIsStreaming])

  return {
    ...streamInfo,
    startStream: wrappedStartStream,
    stopStream: wrappedStopStream,
    retryMessage,
    onTitleUpdate,
  }
} 