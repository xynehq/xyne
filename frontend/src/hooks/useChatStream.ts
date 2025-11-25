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
import { CharacterAnimationManager } from "@/utils/streamRenderer"

interface DeepResearchStep {
  id: string
  type: "reasoning" | "web_search" | "analysis" | "synthesis"
  title: string
  content?: string
  sourceUrl?: string
  sourcesCount?: number
  recentSources?: string[]
  timestamp: number
  status: "active" | "completed" | "error"
  query?: string // Search query for web_search steps
  focus?: string // What the reasoning/analysis is focusing on
  stepNumber?: number // Sequential number for same type steps
  isReasoningDelta?: boolean // Whether this is a delta update for reasoning content
  fullReasoningContent?: string // Complete reasoning content when step is done
}

// Clarification types for HITL
export interface ClarificationOption {
  id: string
  label: string
}

export interface ClarificationRequest {
  clarificationId: string
  question: string
  options: ClarificationOption[]
  context?: any
}

// Module-level storage for persistent EventSource connections
interface StreamState {
  es: EventSource
  partial: string
  thinking: string
  deepResearchSteps: DeepResearchStep[]
  sources: Citation[]
  imageCitations: ImageCitation[]
  citationMap: Record<number, number>
  messageId?: string
  chatId?: string
  isStreaming: boolean
  isRetrying?: boolean
  subscribers: Set<() => void>
  response?: string

  // Character animation display versions
  displayPartial: string
  animationManager: CharacterAnimationManager

  // HITL clarification state
  clarificationRequest?: ClarificationRequest
  waitingForClarification: boolean
}

interface StreamInfo {
  partial: string
  thinking: string
  deepResearchSteps: DeepResearchStep[]
  sources: Citation[]
  imageCitations: ImageCitation[]
  citationMap: Record<number, number>
  messageId?: string
  chatId?: string
  isStreaming: boolean
  isRetrying?: boolean
  // Character animation display versions
  displayPartial: string
  // HITL clarification state
  clarificationRequest?: ClarificationRequest
  waitingForClarification: boolean
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
            parentThreadId: el.dataset.parentThreadId,
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
      streamState.thinking += data + "\n"
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
    let retryCount = 0
    const maxRetries = 3
    let isResolved = false
    let currentEventSource: EventSource | null = null

    const cleanup = () => {
      if (currentEventSource) {
        currentEventSource.onopen = null
        currentEventSource.onerror = null
        if (currentEventSource.readyState !== EventSource.CLOSED) {
          currentEventSource.close()
        }
      }
    }

    const tryRefreshAndRetry = async () => {
      if (triedRefresh) {
        // After refresh, try up to 3 more times before giving up
        if (retryCount >= maxRetries) {
          reject(
            new Error(
              `Connection failed after token refresh and ${maxRetries} retry attempts`,
            ),
          )
          return
        }

        retryCount++
        // Exponential backoff: 100ms, 200ms, 400ms
        const delay = 100 * Math.pow(2, retryCount - 1)
        setTimeout(() => make(), delay)
        return
      }

      triedRefresh = true
      try {
        const refresh = await fetch("/api/v1/refresh-token", {
          method: "POST",
          credentials: "include",
        })

        if (refresh.ok) {
          // Small delay before retry to avoid rapid reconnection
          setTimeout(() => make(), 100)
        } else {
          reject(new Error("Token refresh failed"))
        }
      } catch (e) {
        reject(new Error("Token refresh failed"))
      }
    }

    const make = () => {
      try {
        cleanup() // Clean up any previous attempt
        const es = new EventSource(url, { withCredentials: true })
        currentEventSource = es

        // Set a timeout for the connection attempt
        const connectionTimeout = setTimeout(() => {
          if (!isResolved) {
            cleanup()
            tryRefreshAndRetry()
          }
        }, 5000) // 5 second timeout

        es.onopen = () => {
          if (!isResolved) {
            clearTimeout(connectionTimeout)
            isResolved = true
            resolve(es)
          }
        }

        es.onerror = async (e) => {
          clearTimeout(connectionTimeout)

          if (isResolved) {
            // If already resolved, don't handle the error here
            return
          }

          // Check if EventSource is in a failed state
          if (es.readyState === EventSource.CLOSED) {
            cleanup()
            await tryRefreshAndRetry()
          }
        }
      } catch (error) {
        if (!isResolved) {
          reject(
            new Error(
              `Failed to create EventSource: ${error instanceof Error ? error.message : "Unknown error"}`,
            ),
          )
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
  isAgenticMode: boolean = false,
  queryClient?: any,
  router?: any,
  onTitleUpdate?: (title: string) => void,
  agentIdFromChatParams?: string | null,
  toolsList?: ToolsListItem[],
  metadata?: AttachmentMetadata[],
  preventNavigation?: boolean,
  setChatId?: (chatId: string) => void,
  selectedModel?: string,
  selectedKbItems: string[] = [],
  isFollowUp: boolean = false,
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
  // Build selected model JSON configuration (optional)
  let modelConfig: { model?: string; capabilities?: any } | null = null
  if (selectedModel) {
    try {
      const parsed = JSON.parse(selectedModel)
      modelConfig =
        typeof parsed === "string"
          ? { model: parsed, capabilities: [] }
          : parsed
    } catch {
      // Treat raw value as a label/model id
      modelConfig = { model: String(selectedModel), capabilities: [] }
    }
  }

  // Add selectedKbItems parameter if provided
  if (selectedKbItems && selectedKbItems.length > 0) {
    url.searchParams.append("selectedKbItems", JSON.stringify(selectedKbItems))
  }

  if (modelConfig) {
    url.searchParams.append("selectedModelConfig", JSON.stringify(modelConfig))
  }
  url.searchParams.append("message", finalMessagePayload)

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

  url.searchParams.append("isFollowUp", isFollowUp ? "true" : "false")

  // Create EventSource with auth handling
  let eventSource: EventSource
  try {
    eventSource = await createAuthEventSource(url.toString())
  } catch (err) {
    console.error("Failed to create EventSource:", err)
    toast({
      title: "Error",
      description: "Something went wrong. Please try again.",
      variant: "destructive",
    })
    return
  }

  const streamState: StreamState = {
    es: eventSource,
    partial: "",
    thinking: "",
    deepResearchSteps: [],
    sources: [],
    imageCitations: [],
    citationMap: {},
    messageId: undefined,
    chatId: chatId || undefined,
    isStreaming: true,
    isRetrying: false,
    subscribers: new Set(),
    response: "",
    // Character animation display versions
    displayPartial: "",
    animationManager: new CharacterAnimationManager(),
    // HITL clarification state
    clarificationRequest: undefined,
    waitingForClarification: false,
  }

  activeStreams.set(streamKey, streamState)

  streamState.es.addEventListener(ChatSSEvents.ResponseUpdate, (event) => {
    streamState.partial += event.data

    // Add chunk to character animation queue for main response
    const responseQueue = streamState.animationManager.getQueue(
      "response",
      (displayText: string) => {
        streamState.displayPartial = displayText
        notifySubscribers(streamKey)
      },
    )
    responseQueue.addChunk(event.data)
  })

  streamState.es.addEventListener(ChatSSEvents.Reasoning, (event) => {
    appendReasoningData(streamState, event.data)
    notifySubscribers(streamKey)
  })

  streamState.es.addEventListener(
    ChatSSEvents.DeepResearchReasoning,
    (event) => {
      try {
        const stepData = JSON.parse(event.data)
        const newStep: DeepResearchStep = {
          id: stepData.id || crypto.randomUUID(),
          type: stepData.type || "reasoning",
          title: stepData.title || "Processing...",
          content: stepData.content,
          sourceUrl: stepData.sourceUrl,
          sourcesCount: stepData.sourcesCount,
          recentSources: stepData.recentSources || [],
          timestamp: stepData.timestamp || Date.now(),
          status: stepData.status || "active",
          query: stepData.query,
          focus: stepData.focus,
          stepNumber: stepData.stepNumber,
          isReasoningDelta: stepData.isReasoningDelta,
          fullReasoningContent: stepData.fullReasoningContent,
        }

        // Always look for existing step first by id
        const existingIndex = streamState.deepResearchSteps.findIndex(
          (step) => step.id === newStep.id,
        )

        if (existingIndex >= 0) {
          // Update existing step with new data
          streamState.deepResearchSteps[existingIndex] = {
            ...streamState.deepResearchSteps[existingIndex],
            ...newStep,
          }
        } else {
          // Add new step
          streamState.deepResearchSteps.push(newStep)
        }

        notifySubscribers(streamKey)
      } catch (error) {
        console.error("Error parsing deep research step:", error)
      }
    },
  )

  streamState.es.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
    const { contextChunks, citationMap, updatedResponse } = JSON.parse(
      event.data,
    )
    streamState.sources = contextChunks
    streamState.citationMap = citationMap
    streamState.response = updatedResponse

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

  // HITL: Handle clarification requests
  streamState.es.addEventListener(
    ChatSSEvents.ClarificationRequested,
    (event) => {
      try {
        const clarificationData: ClarificationRequest = JSON.parse(event.data)
        streamState.clarificationRequest = clarificationData
        streamState.waitingForClarification = true
        streamState.isStreaming = false // Pause streaming

        notifySubscribers(streamKey)
      } catch (error) {
        console.error(
          "[ClarificationRequested] Error parsing clarification request:",
          error,
          event.data,
        )
      }
    },
  )

  // HITL: Handle clarification responses
  streamState.es.addEventListener(
    ChatSSEvents.ClarificationProvided,
    (event) => {
      try {
        const { clarificationId, selectedId } = JSON.parse(event.data)
        console.log(
          `Clarification provided: ${clarificationId} -> ${selectedId}`,
        )
        streamState.waitingForClarification = false
        streamState.clarificationRequest = undefined
        streamState.isStreaming = true // Resume streaming
        notifySubscribers(streamKey)
      } catch (error) {
        console.error("Error parsing clarification response:", error)
      }
    },
  )

  streamState.es.addEventListener(ChatSSEvents.End, async () => {
    streamState.es.close()
    // Wait for all character animations to complete before finalizing
    await streamState.animationManager.waitForAllAnimationsComplete()
    streamState.isStreaming = false

    // Finalize character animations with complete content
    streamState.animationManager.setImmediate(
      "response",
      streamState.response || streamState.partial,
    )
    streamState.animationManager.setImmediate("thinking", streamState.thinking)

    // Ensure display versions match final content
    streamState.displayPartial = streamState.response || streamState.partial

    // Now that streaming is complete, notify subscribers so citations appear
    notifySubscribers(streamKey)

    // Create new complete message with accumulated text and citations
    if (
      streamKey &&
      queryClient &&
      streamState.chatId &&
      streamState.messageId
    ) {
      queryClient.setQueryData(
        ["chatHistory", streamState.chatId],
        (old: any) => {
          if (!old?.messages) return old

          // When streaming completes, consolidate all accumulated data (response, citations, thinking) into a final message object
          // Save the complete assistant message to React Query cache to persist the conversation history
          // Use streamState.response if available (from CitationsUpdate for web search), otherwise use streamState.partial (from ResponseUpdate for regular chat)
          const finalMessage = streamState.response || streamState.partial

          const newAssistantMessage = {
            externalId: streamState.messageId,
            messageRole: "assistant",
            message: finalMessage,
            sources: streamState.sources,
            citationMap: streamState.citationMap,
            thinking: streamState.thinking,
            imageCitations: streamState.imageCitations,
            deepResearchSteps: streamState.deepResearchSteps,
            isStreaming: false,
            attachments: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }

          return {
            ...old,
            messages: [...old.messages, newAssistantMessage],
          }
        },
      )
    }
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

  // Stop all animations and cleanup
  stream.animationManager.stopAll()

  // Ensure display versions show current content immediately
  stream.displayPartial = stream.partial

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

  // Cleanup animation manager before deleting stream
  stream.animationManager.cleanup()
  activeStreams.delete(streamKey)
}

// Get current stream state (for hook consumers)
export const getStreamState = (streamKey: string): StreamInfo => {
  const stream = activeStreams.get(streamKey)

  if (!stream) {
    return {
      partial: "",
      thinking: "",
      deepResearchSteps: [],
      sources: [],
      imageCitations: [],
      citationMap: {},
      messageId: undefined,
      chatId: undefined,
      isStreaming: false,
      displayPartial: "",
      clarificationRequest: undefined,
      waitingForClarification: false,
    }
  }

  return {
    partial: stream.partial,
    thinking: stream.thinking,
    deepResearchSteps: stream.deepResearchSteps,
    sources: stream.sources,
    imageCitations: stream.imageCitations,
    citationMap: stream.citationMap,
    messageId: stream.messageId,
    chatId: stream.chatId,
    isStreaming: stream.isStreaming,
    displayPartial: stream.displayPartial,
    clarificationRequest: stream.clarificationRequest,
    waitingForClarification: stream.waitingForClarification,
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
      isAgenticMode: boolean = false,
      agentIdFromChatParams?: string | null,
      toolsList?: ToolsListItem[],
      metadata?: AttachmentMetadata[],
      selectedModel?: string,
      isFollowUp: boolean = false,
      selectedKbItems: string[] = [],
    ) => {
      const streamKey = currentStreamKey

      await startStream(
        streamKey,
        messageToSend,
        selectedSources,
        isAgenticMode,
        queryClient,
        router,
        onTitleUpdate,
        agentIdFromChatParams,
        toolsList,
        metadata,
        preventNavigation,
        setChatId,
        selectedModel,
        selectedKbItems,
        isFollowUp,
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
      isAgenticMode: boolean = false,
      attachmentFileIds?: string[],
      selectedModelConfig?: string | null,
      selectedSources: string[] = [],
      selectedKbItems: string[] = [],
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
      url.searchParams.append("messageId", messageId)
      if (isAgenticMode) {
        url.searchParams.append("agentic", "true")
      }
      if (selectedModelConfig) {
        url.searchParams.append("selectedModelConfig", selectedModelConfig)
      }
      if (attachmentFileIds) {
        url.searchParams.append(
          "attachmentFileIds",
          attachmentFileIds.join(","),
        )
      }
      // Add selectedKbItems parameter if provided
      if (selectedKbItems && selectedKbItems.length > 0) {
        url.searchParams.append(
          "selectedKbItems",
          JSON.stringify(selectedKbItems),
        )
      }

      let eventSource: EventSource
      try {
        eventSource = await createAuthEventSource(url.toString())
      } catch (err) {
        console.error("Failed to create EventSource:", err)
        toast({
          title: "Error",
          description: "Something went wrong. Please try again.",
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
        deepResearchSteps: [],
        sources: [],
        imageCitations: [],
        citationMap: {},
        messageId: undefined,
        chatId: chatId || undefined,
        isStreaming: false,
        isRetrying: true,
        subscribers: new Set(),
        response: "",

        // Character animation display versions
        displayPartial: "",
        animationManager: new CharacterAnimationManager(),

        // HITL clarification state
        clarificationRequest: undefined,
        waitingForClarification: false,
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

        // Add chunk to character animation queue for retry response
        const responseQueue = streamState.animationManager.getQueue(
          "response",
          (displayText: string) => {
            streamState.displayPartial = displayText
            // Update the UI with animated text for retry messages
            // patchResponseContent(displayText, false)
            if (chatId) {
              queryClient.setQueryData(["chatHistory", chatId], (old: any) => {
                if (!old?.messages) return old
                return {
                  ...old,
                  messages: old.messages.map((m: any) =>
                    (
                      isError
                        ? m.externalId === targetMessageId
                        : m.externalId === messageId &&
                          m.messageRole === "assistant"
                    )
                      ? {
                          ...m,
                          message: displayText,
                          isRetrying: true,
                        }
                      : m,
                  ),
                }
              })
            }
            notifySubscribers(retryStreamKey)
          },
        )
        responseQueue.addChunk(event.data)

        notifySubscribers(retryStreamKey)
      })

      eventSource.addEventListener(ChatSSEvents.Reasoning, (event) => {
        appendReasoningData(streamState, event.data)
        patchReasoningContent(event.data)
      })

      eventSource.addEventListener(ChatSSEvents.CitationsUpdate, (event) => {
        const { contextChunks, citationMap, updatedResponse } = JSON.parse(
          event.data,
        )
        streamState.sources = contextChunks
        streamState.citationMap = citationMap
        streamState.response = updatedResponse

        // Update React Query cache with current animated text AND new citation data
        if (chatId) {
          queryClient.setQueryData(["chatHistory", chatId], (old: any) => {
            if (!old?.messages) return old
            return {
              ...old,
              messages: old.messages.map((m: any) =>
                (
                  isError
                    ? m.externalId === targetMessageId
                    : m.externalId === messageId &&
                      m.messageRole === "assistant"
                )
                  ? {
                      ...m,
                      message:
                        streamState.displayPartial ?? streamState.partial,
                      sources: contextChunks,
                      citationMap: citationMap,
                      isRetrying: true,
                    }
                  : m,
              ),
            }
          })
        }

        notifySubscribers(retryStreamKey)
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

      eventSource.addEventListener(ChatSSEvents.End, async () => {
        // Wait for all character animations to complete before finalizing retry
        await streamState.animationManager.waitForAllAnimationsComplete()

        // Update the retry message with final content and citation data
        const finalContent = streamState.response || streamState.partial
        if (chatId) {
          queryClient.setQueryData(["chatHistory", chatId], (old: any) => {
            if (!old?.messages) return old
            return {
              ...old,
              messages: old.messages.map((m: any) =>
                (
                  isError
                    ? m.externalId === targetMessageId
                    : m.externalId === messageId &&
                      m.messageRole === "assistant"
                )
                  ? {
                      ...m,
                      message: finalContent,
                      sources: streamState.sources,
                      citationMap: streamState.citationMap,
                      thinking: streamState.thinking,
                      imageCitations: streamState.imageCitations,
                      deepResearchSteps: streamState.deepResearchSteps,
                      isRetrying: false,
                    }
                  : m,
              ),
            }
          })
        }

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
        streamState.animationManager.cleanup()
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
        streamState.animationManager.cleanup()
        notifySubscribers(retryStreamKey)
        activeStreams.delete(retryStreamKey)
        eventSource.close()
      }
    },
    [currentStreamKey, queryClient, chatId, setRetryIsStreaming],
  )

  const provideClarification = useCallback(
    async (
      clarificationId: string,
      selectedOptionId: string,
      selectedOptionLabel: string,
      customInput?: string,
    ) => {
      if (!chatId) {
        console.error(
          "[provideClarification] Cannot provide clarification without a chatId",
        )
        return
      }

      try {
        // Call the clarification API endpoint
        // Use fetch directly in case the generated types haven't been updated yet
        const response = await api.chat.clarification.$post({
          json: {
            chatId,
            clarificationId,
            selectedOption: {
              selectedOptionId,
              selectedOption: selectedOptionLabel,
              customInput: customInput || undefined,
            },
          },
        })

        if (!response.ok) {
          const errorText = await response.text()
          console.error("[provideClarification] API error:", errorText)
          throw new Error(
            `Failed to provide clarification: ${response.status} ${errorText}`,
          )
        }

        // Clear the clarification request from the stream state
        const stream = activeStreams.get(chatId)
        if (stream) {
          stream.clarificationRequest = undefined
          stream.waitingForClarification = false
          stream.isStreaming = true // Resume streaming
          notifySubscribers(chatId)
        } else {
          console.warn(
            "[provideClarification] No active stream found for chatId:",
            chatId,
          )
        }
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to provide clarification. Please try again.",
          variant: "destructive",
        })
      }
    },
    [chatId],
  )

  return {
    ...streamInfo,
    startStream: wrappedStartStream,
    stopStream: wrappedStopStream,
    retryMessage,
    onTitleUpdate,
    provideClarification,
  }
}
