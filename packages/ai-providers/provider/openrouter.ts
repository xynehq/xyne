// Remove unused import
import axios from "axios"
import OpenAI from "openai"
import BaseProvider from "./base"
import { AIProviders, ModelParams, ConverseResponse } from "../types"

export class OpenRouterProvider extends BaseProvider {
  client: OpenAI
  private apiKey: string
  private providerSorting?: string
  private lastGenerationId?: string

  constructor(config: {
    apiKey: string
    providerSorting?: string
  }) {
    super(null, AIProviders.OpenRouter)

    this.apiKey = config.apiKey
    this.providerSorting = config.providerSorting

    this.client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: this.apiKey,
      defaultHeaders: {
        "HTTP-Referer": "https://xyne.ai", // For including app on openrouter.ai rankings
        "X-Title": "Xyne Code", // Shows in rankings on openrouter.ai
      },
    })
  }

  async converse(
    messages: any[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    try {
      const openAIMessages = this.convertToOpenAIMessages(
        messages,
        modelParams.systemPrompt,
      )

      const response = await this.client.chat.completions.create({
        model: modelParams.modelId,
        messages: openAIMessages,
        max_tokens: modelParams.maxTokens || 4096,
        temperature: modelParams.temperature || 0.7,
        top_p: modelParams.topP || 0.9,
        stream: false,
        ...(this.providerSorting && {
          provider: { order: [this.providerSorting] },
        }),
      })

      this.lastGenerationId = response.id

      const text = response.choices[0]?.message?.content || ""
      const usage = response.usage

      // Get cost from response or calculate fallback
      let cost = 0
      if (usage && "cost" in usage && typeof usage.cost === "number") {
        cost = usage.cost
      } else {
        cost = this.calculateCost(
          usage?.prompt_tokens || 0,
          usage?.completion_tokens || 0,
          modelParams.modelId,
        )
      }

      return {
        text,
        cost,
        metadata: {
          model: modelParams.modelId,
          inputTokens: usage?.prompt_tokens || 0,
          outputTokens: usage?.completion_tokens || 0,
          responseTime: Date.now(),
        },
        isComplete: true,
      }
    } catch (error: any) {
      console.error("OpenRouter error:", error)

      // Handle OpenRouter-specific errors
      if (error.error) {
        const openRouterError = error.error
        throw new Error(
          `OpenRouter API Error ${openRouterError.code}: ${openRouterError.message}`,
        )
      }

      throw error
    }
  }

  async *converseStream(
    messages: any[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    this.lastGenerationId = undefined

    try {
      const openAIMessages = this.convertToOpenAIMessages(
        messages,
        modelParams.systemPrompt,
      )

      const stream = await this.client.chat.completions.create({
        model: modelParams.modelId,
        messages: openAIMessages,
        max_tokens: modelParams.maxTokens || 4096,
        temperature: modelParams.temperature || 0.7,
        top_p: modelParams.topP || 0.9,
        stream: true,
        ...(this.providerSorting && {
          provider: { order: [this.providerSorting] },
        }),
      })

      let didOutputUsage = false
      let fullText = ""

      for await (const chunk of stream) {
        // OpenRouter returns an error object instead of throwing
        if ("error" in chunk) {
          const error = chunk.error as any
          console.error(
            `OpenRouter API Error: ${error?.code} - ${error?.message}`,
          )
          const metadataStr = error.metadata
            ? `\nMetadata: ${JSON.stringify(error.metadata, null, 2)}`
            : ""
          throw new Error(
            `OpenRouter API Error ${error.code}: ${error.message}${metadataStr}`,
          )
        }

        if (!this.lastGenerationId && chunk.id) {
          this.lastGenerationId = chunk.id
        }

        const delta = chunk.choices[0]?.delta
        if (delta?.content) {
          yield {
            text: delta.content,
          }
          fullText += delta.content
        }

        // Handle reasoning tokens if present
        if ("reasoning" in delta && delta.reasoning) {
          yield {
            text: "",
            metadata: {
              reasoning: delta.reasoning,
            },
          }
        }

        // Handle usage information
        if (!didOutputUsage && chunk.usage) {
          const usage = chunk.usage
          let cost = 0

          if ("cost" in usage && typeof usage.cost === "number") {
            cost = usage.cost
          } else {
            cost = this.calculateCost(
              usage.prompt_tokens || 0,
              usage.completion_tokens || 0,
              modelParams.modelId,
            )
          }

          yield {
            text: "",
            cost,
            metadata: {
              model: modelParams.modelId,
              inputTokens: usage.prompt_tokens || 0,
              outputTokens: usage.completion_tokens || 0,
              cacheReadTokens: usage.prompt_tokens_details?.cached_tokens || 0,
              responseTime: Date.now(),
            },
            isComplete: true,
          }
          didOutputUsage = true
        }
      }

      // Fallback to generation endpoint if usage chunk not returned
      if (!didOutputUsage) {
        const apiStreamUsage = await this.getApiStreamUsage(modelParams.modelId)
        if (apiStreamUsage) {
          yield apiStreamUsage
        }
      }
    } catch (error: any) {
      console.error("OpenRouter streaming error:", error)
      throw error
    }
  }

  private async getApiStreamUsage(
    modelId: string,
  ): Promise<ConverseResponse | undefined> {
    if (this.lastGenerationId) {
      // Wait a bit for generation endpoint to be ready
      await new Promise((resolve) => setTimeout(resolve, 500))

      try {
        const response = await axios.get(
          `https://openrouter.ai/api/v1/generation?id=${this.lastGenerationId}`,
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
            },
            timeout: 15000,
          },
        )

        const generation = response.data?.data
        if (generation) {
          return {
            text: "",
            cost: generation.total_cost || 0,
            metadata: {
              model: modelId,
              inputTokens: generation.native_tokens_prompt || 0,
              outputTokens: generation.native_tokens_completion || 0,
              cacheReadTokens: generation.native_tokens_cached || 0,
              responseTime: Date.now(),
            },
            isComplete: true,
          }
        }
      } catch (error) {
        console.error("Error fetching OpenRouter generation details:", error)
      }
    }
    return undefined
  }

  private convertToOpenAIMessages(
    messages: any[],
    systemPrompt?: string,
  ): any[] {
    const openAIMessages: any[] = []

    // Add system message if provided
    if (systemPrompt) {
      openAIMessages.push({
        role: "system",
        content: systemPrompt,
      })
    }

    // Convert messages to OpenAI format
    for (const message of messages) {
      if (message.role === "system") {
        // Skip system messages if we already added one
        if (!systemPrompt) {
          openAIMessages.push({
            role: "system",
            content:
              typeof message.content === "string"
                ? message.content
                : message.content.map((block: any) => block.text).join(""),
          })
        }
        continue
      }

      const content =
        typeof message.content === "string"
          ? message.content
          : message.content.map((block: any) => {
              if (block.text) {
                return { type: "text", text: block.text }
              }
              if (block.image) {
                return {
                  type: "image_url",
                  image_url: {
                    url: `data:image/${block.image.format};base64,${block.image.source.bytes}`,
                  },
                }
              }
              return block
            })

      openAIMessages.push({
        role: message.role,
        content,
      })
    }

    return openAIMessages
  }

  private calculateCost(
    inputTokens: number,
    outputTokens: number,
    modelId: string,
  ): number {
    // Fallback cost calculation for OpenRouter models
    // These are approximate rates - actual costs vary by provider
    const costs: Record<string, { input: number; output: number }> = {
      // Anthropic models
      "anthropic/claude-3.5-sonnet": { input: 0.003, output: 0.015 },
      "anthropic/claude-3.5-haiku": { input: 0.001, output: 0.005 },
      "anthropic/claude-3-opus": { input: 0.015, output: 0.075 },
      // OpenAI models
      "openai/gpt-4o": { input: 0.005, output: 0.015 },
      "openai/gpt-4o-mini": { input: 0.00015, output: 0.0006 },
      "openai/o1-preview": { input: 0.015, output: 0.06 },
      "openai/o1-mini": { input: 0.003, output: 0.012 },
      // Google models
      "google/gemini-2.0-flash-exp": { input: 0.000075, output: 0.0003 },
      "google/gemini-pro-1.5": { input: 0.00125, output: 0.005 },
      // Meta models
      "meta-llama/llama-3.1-405b-instruct": { input: 0.005, output: 0.015 },
      "meta-llama/llama-3.1-70b-instruct": { input: 0.0009, output: 0.0009 },
      // Other models
      "qwen/qwen-2.5-72b-instruct": { input: 0.0009, output: 0.0009 },
      "deepseek/deepseek-chat": { input: 0.00027, output: 0.0011 },
    }

    const modelCosts = costs[modelId] || { input: 0.002, output: 0.008 } // Default pricing
    return (
      (inputTokens * modelCosts.input + outputTokens * modelCosts.output) / 1000
    )
  }
}
