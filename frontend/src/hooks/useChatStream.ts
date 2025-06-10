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
}

// Global map to store active streams - persists across component unmounts
const activeStreams = new Map<string, StreamState>()

// Map real chatId to frontend-generated UUID to avoid component remounting
const chatIdToUUIDMap = new Map<string, string>()

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
  const resolvedKey = chatIdToUUIDMap.get(streamId) || streamId
  const stream = activeStreams.get(resolvedKey)
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

  let initialKey = chatIdToUUIDMap.get(streamKey) ?? streamKey
  
  // Check if stream already exists and is active
  if (activeStreams.has(initialKey) && activeStreams.get(initialKey)?.isStreaming) {
    console.log(`[SSEManager] Stream ${initialKey} already active, skipping`)
    return
  }

  console.log(`[SSEManager] Starting stream for ${initialKey}`)

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
    console.log(`[SSEManager] Starting new chat with temporary key: ${initialKey}`)
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

  activeStreams.set(initialKey, streamState)
  console.log(`[SSEManager] Created stream state for ${initialKey}`)

  // Immediately notify subscribers so UI shows streaming state right away
  notifySubscribers(initialKey)

  // Setup event listeners
  eventSource.addEventListener('open', () => {
    console.log(`[SSEManager] EventSource connection opened for ${initialKey}`)
  })

  eventSource.addEventListener(ChatSSEvents.Start, () => {
    console.log(`[SSEManager] Stream started for ${initialKey}`)
  })

  eventSource.addEventListener(ChatSSEvents.ResponseUpdate, (event) => {
    console.log(`[SSEManager] Response update for ${initialKey}: ${event.data.slice(0, 50)}...`)
    streamState.partial += event.data
    
    // Notify subscribers using current key (might have migrated)
    const currentKey = streamState.chatId || initialKey
    notifySubscribers(currentKey)
  })

  eventSource.addEventListener(ChatSSEvents.Reasoning, (event) => {
    console.log(`[SSEManager] Reasoning for ${initialKey}: ${event.data.slice(0, 50)}...`)
    streamState.thinking += event.data
    
    // Notify subscribers using current key (might have migrated)
    const currentKey = streamState.chatId || initialKey
    notifySubscribers(currentKey)
  })

  eventSource.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
    console.log(`[SSEManager] Citations update for ${initialKey}`)
    const { contextChunks, citationMap } = JSON.parse(event.data)
    streamState.sources = contextChunks
    streamState.citationMap = citationMap
    
    // Notify subscribers using current key (might have migrated)
    const currentKey = streamState.chatId || initialKey
    notifySubscribers(currentKey)
  })

  eventSource.addEventListener(ChatSSEvents.ResponseMetadata, (event) => {
    const { chatId: realId, messageId } = JSON.parse(event.data)
    console.log(`[SSEManager] ResponseMetadata for ${initialKey} - chatId: ${realId}, messageId: ${messageId}`)
    
    streamState.messageId = messageId

    // Instead of migrating streams, just map the chatId to UUID to avoid component remounting
    if (realId && initialKey !== realId) {
      console.log(`[SSEManager] Mapping chatId ${realId} to UUID ${initialKey}`)
      
      // Set up the mapping from real chatId to UUID
      chatIdToUUIDMap.set(realId, initialKey)
      streamState.chatId = realId
      
      // Handle navigation for new chats
      if (router && router.state.location.pathname === "/chat") {
        console.log(`[SSEManager] New chat created, navigating to: /chat/${realId}`)
        const isGlobalDebugMode = import.meta.env.VITE_SHOW_DEBUG_INFO === "true"
        // setTimeout(() => {
          router.navigate({
            to: "/chat/$chatId",
            params: { chatId: realId },
            search: !isGlobalDebugMode ? {} : {},
            replace: true,
          })
        // }, 1000)
      }

      // Update React Query cache for new chats
      if (queryClient) {
        console.log(`[SSEManager] Transferring cache from ${initialKey} to ${realId}`)
        const oldData = queryClient.getQueryData(["chatHistory", null])
        if (oldData) {
          queryClient.setQueryData(["chatHistory", realId], oldData)
          queryClient.removeQueries({ queryKey: ["chatHistory", null] })
        }
      }
      
      // Notify subscribers using the UUID key (no remounting)
      notifySubscribers(initialKey)
    } else {
      // No mapping needed, just update existing stream
      streamState.chatId = realId
      notifySubscribers(initialKey)
    }
  })

  eventSource.addEventListener(ChatSSEvents.ChatTitleUpdate, (event) => {
    console.log(`[SSEManager] Title update for ${initialKey}: ${event.data}`)
    if (onTitleUpdate) {
      onTitleUpdate(event.data)
    }
  })

  eventSource.addEventListener(ChatSSEvents.End, () => {
    console.log(`[SSEManager] Stream ended for ${initialKey}`)
    streamState.isStreaming = false
    
    // Invalidate and refetch chat history using the final chatId
    const finalChatId = streamState.chatId
    if (finalChatId && queryClient) {
      console.log(`[SSEManager] Invalidating cache for chatId: ${finalChatId}`)
      queryClient.invalidateQueries({ queryKey: ["chatHistory", finalChatId] })
    }
    
    // Notify subscribers using current key (might have migrated)
    const currentKey = streamState.chatId || initialKey
    notifySubscribers(currentKey)
    
    // Don't remove the stream here - keep it for potential reconnection
    // Only clean up the EventSource
    eventSource.close()
  })

  eventSource.addEventListener(ChatSSEvents.Error, (event) => {
    console.error(`[SSEManager] Stream error for ${initialKey}:`, event.data)
    streamState.isStreaming = false
    eventSource.close()
    
    toast({
      title: "Error",
      description: event.data,
      variant: "destructive",
    })
    
    // Notify subscribers using current key (might have migrated)
    const currentKey = streamState.chatId || initialKey
    notifySubscribers(currentKey)
  })

  eventSource.onerror = (error) => {
    console.error(`[SSEManager] EventSource error for ${initialKey}:`, error)
    streamState.isStreaming = false
    
    toast({
      title: "Error",
      description: "Connection error. Please try again.",
      variant: "destructive",
    })
    
    // Notify subscribers using current key (might have migrated)
    const currentKey = streamState.chatId || initialKey
    notifySubscribers(currentKey)
    eventSource.close()
  }
}

// Stop a specific stream
export const stopStream = async (streamKey: string, queryClient?: any): Promise<void> => {
  const resolvedKey = chatIdToUUIDMap.get(streamKey) || streamKey
  const stream = activeStreams.get(resolvedKey)
  
  if (!stream) {
    console.log(`[SSEManager] No stream found for ${streamKey}`)
    return
  }

  console.log(`[SSEManager] Stopping stream for ${streamKey}`)
  
  stream.isStreaming = false
  stream.es.close()
  
  // Send stop request to backend using the real chatId if available
  const currentChatId = stream.chatId
  if (currentChatId) {
    console.log(`[SSEManager] Sending stop request for chatId: ${currentChatId}`)
    try {
      await api.chat.stop.$post({
        json: { chatId: currentChatId },
      })
      
      // Invalidate and refetch chat history just like natural stream end
      if (queryClient) {
        console.log(`[SSEManager] Invalidating cache for stopped stream chatId: ${currentChatId}`)
        queryClient.invalidateQueries({ queryKey: ["chatHistory", currentChatId] })
        // Force immediate refetch to ensure the stopped message appears as saved
        console.log(`[SSEManager] Force refetching chat history for persistence`)
        await queryClient.refetchQueries({ queryKey: ["chatHistory", currentChatId] })
        
        // Add a small delay to ensure backend has processed the stop request
        await new Promise(resolve => setTimeout(resolve, 500))
        
        // Final refetch to ensure complete persistence
        await queryClient.refetchQueries({ queryKey: ["chatHistory", currentChatId] })
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
  notifySubscribers(resolvedKey)
}

// Get current stream state (for hook consumers)
export const getStreamState = (streamKey: string): StreamInfo => {
  const resolvedKey = chatIdToUUIDMap.get(streamKey) || streamKey
  const stream = activeStreams.get(resolvedKey)
  
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

// React hook that subscribes to stream updates
export const useChatStream = (
  chatId: string | null,
  onTitleUpdate?: (title: string) => void
) => {
  const queryClient = useQueryClient()
  const router = useRouter()
  
  // Generate a consistent stream key for this hook instance
  const streamKeyRef = useRef<string | null>(null)
  if (!streamKeyRef.current) {
    streamKeyRef.current = chatId ?? crypto.randomUUID()
  }
  
  // Update stream key if chatId changes (e.g., after migration)
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
    const resolvedKey = chatIdToUUIDMap.get(streamKey) || streamKey
    const stream = activeStreams.get(resolvedKey)
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
      const resolvedKey = chatIdToUUIDMap.get(streamKey) || streamKey
      const stream = activeStreams.get(resolvedKey)
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
    let streamKey = chatId ?? crypto.randomUUID()
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

    streamKey = chatIdToUUIDMap.get(streamKey) ?? streamKey
    
    // Force immediate update of local state after starting stream
    setStreamInfo(getStreamState(streamKey))
    
    // Ensure our subscriber is registered for hot streams (e.g. UUID-based new chats)
    const resolvedStreamKey = chatIdToUUIDMap.get(streamKey) || streamKey
    const stream = activeStreams.get(resolvedStreamKey)
    if (stream && subscriberRef.current) {
      stream.subscribers.add(subscriberRef.current)
      // Immediately push the current buffer into React state
      subscriberRef.current()
    }
    
    // Update our stream key reference for future operations
    streamKeyRef.current = streamKey
  }, [chatId, queryClient, router, onTitleUpdate])

  const wrappedStopStream = useCallback(async () => {
    await stopStream(currentStreamKey, queryClient)
  }, [currentStreamKey, queryClient])

  const retryMessage = useCallback(async (
    messageId: string,
    isReasoningActive: boolean = true
  ) => {
    if (!messageId || streamInfo.isStreaming) return

    console.log(`[useChatStream] Retrying message: ${messageId}`)

    const url = new URL(`/api/v1/message/retry`, window.location.origin)
    url.searchParams.append("messageId", encodeURIComponent(messageId))
    url.searchParams.append("isReasoningEnabled", `${isReasoningActive}`)

    // For retry, we'll use a simpler approach since it's less common
    // and doesn't need the full persistent stream management
    const eventSource = new EventSource(url.toString(), {
      withCredentials: true,
    })

    const streamKey = currentStreamKey
    
    // Create temporary stream state for retry
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

    const resolvedRetryKey = chatIdToUUIDMap.get(streamKey) || streamKey
    activeStreams.set(resolvedRetryKey, streamState)

    // Subscribe UI updates for retry stream
    if (subscriberRef.current) {
      streamState.subscribers.add(subscriberRef.current)
      subscriberRef.current()
    }

    // Setup event listeners for retry
    eventSource.addEventListener(ChatSSEvents.ResponseUpdate, (event) => {
      streamState.partial += event.data
      notifySubscribers(streamKey)
    })

    eventSource.addEventListener(ChatSSEvents.Reasoning, (event) => {
      streamState.thinking += event.data
      notifySubscribers(streamKey)
    })

    eventSource.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
      const { contextChunks, citationMap } = JSON.parse(event.data)
      streamState.sources = contextChunks
      streamState.citationMap = citationMap
      notifySubscribers(streamKey)
    })

    eventSource.addEventListener(ChatSSEvents.ResponseMetadata, (event) => {
      const { messageId: newMessageId } = JSON.parse(event.data)
      streamState.messageId = newMessageId
      notifySubscribers(streamKey)
    })

    eventSource.addEventListener(ChatSSEvents.End, () => {
      streamState.isStreaming = false
      if (chatId) {
        queryClient.invalidateQueries({ queryKey: ["chatHistory", chatId] })
      }
      notifySubscribers(streamKey)
      eventSource.close()
    })

    eventSource.addEventListener(ChatSSEvents.Error, (event) => {
      console.error("Retry stream error:", event.data)
      streamState.isStreaming = false
      toast({
        title: "Error",
        description: event.data,
        variant: "destructive",
      })
      notifySubscribers(streamKey)
      eventSource.close()
    })

    eventSource.onerror = () => {
      streamState.isStreaming = false
      console.error("Retry EventSource error")
      notifySubscribers(streamKey)
      eventSource.close()
    }
  }, [currentStreamKey, streamInfo.isStreaming, queryClient, chatId])

  return {
    ...streamInfo,
    startStream: wrappedStartStream,
    stopStream: wrappedStopStream,
    retryMessage,
    onTitleUpdate,
  }
} 