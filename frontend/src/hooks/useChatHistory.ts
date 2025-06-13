import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api"
import { SelectPublicMessage } from "shared/types"

interface ChatHistoryData {
  messages: SelectPublicMessage[]
  chat?: {
    title: string | null
    isBookmarked: boolean
  }
}

export const useChatHistory = (chatId: string | null) => {
  const queryClient = useQueryClient()

  const query = useQuery<ChatHistoryData>({
    queryKey: ["chatHistory", chatId],
    queryFn: async () => {
      console.log(`[useChatHistory] Fetching data for chatId: ${chatId}`)
      
      if (!chatId) {
        console.log(`[useChatHistory] No chatId provided, returning empty messages`)
        return { messages: [] }
      }

      try {
        const response = await api.chat.$post({
          json: { chatId }
        })
        
        if (!response.ok) {
          throw new Error("Failed to fetch chat history")
        }
        
        const data = await response.json()
        console.log(`[useChatHistory] Fetched ${data.messages?.length || 0} messages for chatId: ${chatId}`)
        return data as ChatHistoryData
      } catch (error) {
        console.error("Error fetching chat history:", error)
        throw error
      }
    },
    enabled: !!chatId, // Only fetch when we have a chatId
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnWindowFocus: false,
  })

  // Helper function to add a message optimistically
  const addMessageOptimistically = (message: SelectPublicMessage) => {
    console.log(`[useChatHistory] Adding message optimistically to chatId: ${chatId}`)
    
    queryClient.setQueryData<ChatHistoryData>(
      ["chatHistory", chatId],
      (oldData) => {
        if (!oldData) {
          console.log(`[useChatHistory] Creating new chat history with first message`)
          return { messages: [message] }
        }
        console.log(`[useChatHistory] Adding message to existing ${oldData.messages.length} messages`)
        return {
          ...oldData,
          messages: [...oldData.messages, message],
        }
      }
    )
  }

  // Helper function to update the last message
  const updateLastMessage = (updater: (msg: SelectPublicMessage) => SelectPublicMessage) => {
    if (!chatId) return

    queryClient.setQueryData<ChatHistoryData>(
      ["chatHistory", chatId],
      (oldData) => {
        if (!oldData || oldData.messages.length === 0) return oldData
        
        const messages = [...oldData.messages]
        const lastIndex = messages.length - 1
        messages[lastIndex] = updater(messages[lastIndex])
        
        return {
          ...oldData,
          messages,
        }
      }
    )
  }

  // Helper function to update chat metadata
  const updateChatMetadata = (updates: Partial<{ title: string | null; isBookmarked: boolean }>) => {
    if (!chatId) return

    queryClient.setQueryData<ChatHistoryData>(
      ["chatHistory", chatId],
      (oldData) => {
        if (!oldData) return oldData
        
        return {
          ...oldData,
          chat: {
            ...oldData.chat,
            title: oldData.chat?.title || null,
            isBookmarked: oldData.chat?.isBookmarked || false,
            ...updates,
          }
        }
      }
    )
  }

  return {
    ...query,
    addMessageOptimistically,
    updateLastMessage,
    updateChatMetadata,
  }
} 