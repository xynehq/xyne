// Types for the client configuration
interface FireworksConfig {
  apiKey: string
  timeout?: number
  maxRetries?: number
}

// Types for message roles
type MessageRole = "system" | "user" | "assistant" | "function"

// Interface for chat messages
interface ChatMessage {
  role: MessageRole
  content: string
  name?: string
  function_call?: {
    name: string
    arguments: string
  }
}

// Interface for model parameters
interface ModelParameters {
  model?: string
  max_tokens?: number
  top_p?: number
  top_k?: number
  presence_penalty?: number
  frequency_penalty?: number
  temperature?: number
  stream?: boolean
  stop?: string | string[]
  prompt_truncate_len?: number
  repetition_penalty?: number
  mirostat_lr?: number
  mirostat_target?: number
  ignore_eos?: boolean
  context_length_exceeded_behavior?: "truncate" | "error"
}

// Interface for API request options
type ToolDef = {
  type: 'function'
  function: { name: string; description?: string; parameters?: any }
}

interface RequestOptions extends ModelParameters {
  messages: ChatMessage[]
  tools?: ToolDef[]
  tool_choice?: 'auto' | 'none' | 'required'
}

// Interfaces for API responses
interface Choice {
  index: number
  message?: {
    role: MessageRole
    content: string
    function_call?: {
      name: string
      arguments: string
    }
  }
  delta?: {
    role?: MessageRole
    content?: string
    function_call?: {
      name: string
      arguments: string
    }
  }
  finish_reason: string | null
}

interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

interface CompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Choice[]
  usage: Usage
}

class Fireworks {
  private apiKey: string
  private timeout: number
  private maxRetries: number
  private readonly baseUrl: string

  constructor({
    apiKey,
    timeout = 4 * 60 * 1000,
    maxRetries = 10,
  }: FireworksConfig) {
    this.apiKey = apiKey
    this.timeout = timeout
    this.maxRetries = maxRetries
    this.baseUrl = "https://api.fireworks.ai/inference/v1/chat/completions"
  }

  private async _makeRequest(
    messages: ChatMessage[],
    options: Partial<RequestOptions> = {},
  ): Promise<Response> {
    const defaultOptions: ModelParameters = {
      model: "accounts/fireworks/models/deepseek-r1",
      max_tokens: 20480,
      top_p: 1,
      top_k: 40,
      presence_penalty: 0,
      frequency_penalty: 0,
      temperature: 0.6,
      stream: false,
    }

    const requestOptions: RequestOptions = {
      ...defaultOptions,
      ...options,
      messages,
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      return await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestOptions),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // Non-streaming API call
  async complete(
    messages: ChatMessage[],
    options: Partial<RequestOptions> = {},
  ): Promise<CompletionResponse> {
    let retries = 0

    while (retries < this.maxRetries) {
      try {
        const response = await this._makeRequest(messages, {
          ...options,
          stream: false,
        })

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }

        const data: CompletionResponse = await response.json()
        return data
      } catch (error) {
        retries++
        if (retries === this.maxRetries) {
          throw error
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, retries) * 1000),
        )
      }
    }

    throw new Error("Max retries exceeded")
  }

  // Generator-based streaming API
  async *streamComplete(
    messages: ChatMessage[],
    options: Partial<RequestOptions> = {},
  ): AsyncGenerator<
    | { type: 'text'; text: string }
    | { type: 'tool_call'; name: string; arguments: string },
    void,
    unknown
  > {
    let retries = 0

    while (retries < this.maxRetries) {
      try {
        const response = await this._makeRequest(messages, {
          ...options,
          stream: true,
        })

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }

        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (true) {
          const { value, done } = await reader.read()

          if (done) {
            break
          }

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n\n")

          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i].trim()

            if (line.startsWith("data: ")) {
              const jsonData = line.slice(6)

              if (jsonData === "[DONE]") {
                return
              }

              try {
                const parsedData = JSON.parse(jsonData) as CompletionResponse
                const choice = parsedData.choices?.[0]
                const delta = choice?.delta
                const content = delta?.content
                const fn = delta?.function_call

                if (fn && (fn.name || fn.arguments)) {
                  yield {
                    type: 'tool_call',
                    name: fn.name || '',
                    arguments: fn.arguments || '{}',
                  }
                }

                if (content) {
                  yield { type: 'text', text: content }
                }
              } catch (error) {
                console.error("Error parsing JSON:", error)
              }
            }
          }

          buffer = lines[lines.length - 1]
        }

        return
      } catch (error) {
        retries++
        if (retries === this.maxRetries) {
          throw error
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, retries) * 1000),
        )
      }
    }
  }
}

export type {
  FireworksConfig,
  ChatMessage,
  MessageRole,
  ModelParameters,
  CompletionResponse,
  Choice,
  Usage,
}

export { Fireworks }
