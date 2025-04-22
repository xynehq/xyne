import { createFileRoute } from "@tanstack/react-router"
// Import the component from the base code-chat file
import { CodeChatPage } from "@/routes/_authenticated/code-chat"
import { api } from "@/api"
import { errorComponent } from "@/components/error"

// Define the expected shape of the data returned by the loader
// This should match the structure returned by your `api.codeChat.$post` endpoint
// Assuming it's similar to the chat endpoint, maybe like this:
interface CodeChatLoaderResponse {
  chat?: {
    // Optional chat object
    externalId: string // Assuming externalId is used for chatId
    title: string | null
    // Add other chat properties if needed
  }
  messages: Array<{
    role: "user" | "ai" | "system"
    content: string
    messageId?: string
  }>
  error?: unknown // Keep error handling generic
}

export const Route = createFileRoute("/_authenticated/code-chat/$chatId")({
  // Use the imported CodeChatPage component
  component: CodeChatPage,
  // Loader now mirrors the chat.$chatId.tsx loader structure
  loader: async ({ params }): Promise<CodeChatLoaderResponse> => {
    console.log(
      "Loading existing code chat via POST for chatId:",
      params.chatId,
    )
    try {
      // Use the existing POST request endpoint for code chat
      const res = await api.chat.$post({
        json: { chatId: params.chatId },
      })

      if (!res.ok) {
        // Try to get a meaningful error message
        let errorMsg = `Failed to fetch code chat: ${res.status} ${res.statusText}`
        try {
          const errorBody = await res.json()
          errorMsg = errorBody?.error || errorBody?.message || errorMsg
        } catch (e) {
          /* Ignore parsing error */
        }
        throw new Error(errorMsg)
      }

      // Directly return the JSON response, assuming it matches CodeChatLoaderResponse
      const data = (await res.json()) as CodeChatLoaderResponse
      // Ensure messages is always an array, even if API returns null/undefined
      return { ...data, messages: data.messages || [] }
    } catch (error) {
      console.error("Error loading code chat details:", error)
      // Return an object containing the error, similar to chat.$chatId.tsx
      // Also provide default values for the component to avoid crashing
      return {
        error: error,
        messages: [],
        chat: {
          // Provide a minimal chat object structure
          externalId: params.chatId,
          title: null,
        },
      }
    }
  },
  errorComponent: errorComponent,
})
