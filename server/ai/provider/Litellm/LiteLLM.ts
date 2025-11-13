import { type Message } from "@aws-sdk/client-bedrock-runtime"
import BaseProvider from "@/ai/provider/base"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import { calculateCost } from "@/utils/index"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { modelDetailsMap } from "@/ai/mappers"
import OpenAI from "openai"

const Logger = getLogger(Subsystem.AI)

interface LiteLLMClientConfig {
  apiKey: string
  baseURL: string
}

export class LiteLLM {
  private client: OpenAI

  constructor(clientConfig: LiteLLMClientConfig) {
    this.client = new OpenAI({
      apiKey: clientConfig.apiKey,
      baseURL: clientConfig.baseURL,
      dangerouslyAllowBrowser: true
    })
  }

  getClient(): OpenAI {
    return this.client
  }
}

export class LiteLLMProvider extends BaseProvider {
  constructor(client: LiteLLM) {
    super(client, AIProviders.LiteLLM)
  }


  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    const client = (this.client as LiteLLM).getClient()

    try {
      // Transform messages to OpenAI-compatible format
      const transformedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messages.map((message) => {
        const role = message.role === "assistant" ? "assistant" : "user"
        return {
          role,
          content: message.content?.[0]?.text || "",
        }
      })

      const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: "system",
          content: modelParams.systemPrompt || ""
        },
        ...transformedMessages,
      ]

      const tools = params.tools && params.tools.length
        ? params.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters || { type: "object", properties: {} },
            },
          }))
        : undefined

      const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: modelParams.modelId,
        messages: openaiMessages,
        max_tokens: modelParams.maxTokens,
        temperature: modelParams.temperature,
        top_p: modelParams.topP,
        tools,
        tool_choice: tools ? (params.tool_choice ?? "auto") : undefined,
        response_format: modelParams.json ? { type: "json_object" } : undefined,
      }
      
      const response = await client.chat.completions.create(requestParams)

      // Extract the first choice
      const firstChoice = response.choices[0]
      const messageContent = firstChoice.message.content || ""
      const toolCalls = firstChoice.message.tool_calls

      // Extract usage information with safe defaults
      const inputTokens = response.usage?.prompt_tokens ?? 0
      const outputTokens = response.usage?.completion_tokens ?? 0
      const totalTokens = response.usage?.total_tokens ?? 0

      // Get cost configuration with correct fallback shape
      const costConfig = modelDetailsMap[modelParams.modelId]?.cost?.onDemand ?? {
        pricePerThousandInputTokens: 0,
        pricePerThousandOutputTokens: 0,
      }

      return {
        text: messageContent,
        cost: calculateCost(
          {
            inputTokens,
            outputTokens,
          },
          costConfig,
        ),
        metadata: {
          usage: {
            inputTokens,
            outputTokens,
            totalTokens,
          },
        },
        ...(toolCalls && toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                  name: tc.type === "function" ? tc.function.name : "",
                  arguments: tc.type === "function" ? tc.function.arguments : "",
                },
              })),
            }
          : {}),
      }

    } catch (error) {
      Logger.error("LiteLLM Converse Error:", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        errorType: error?.constructor?.name,
        modelId: modelParams.modelId,
      })
      throw new Error(`Failed to get response from LiteLLM: ${error}`)
    }
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    const client = (this.client as LiteLLM).getClient()

    try {
      // Transform messages to OpenAI-compatible format
      const transformedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messages.map((message) => {
        const role = message.role === "assistant" ? "assistant" : "user"
        return {
          role,
          content: message.content?.[0]?.text || "",
        }
      })

      const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: "system",
          content: modelParams.systemPrompt || ""
        },
        ...transformedMessages,
      ]

      const tools = params.tools && params.tools.length
        ? params.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters || { type: "object", properties: {} },
            },
          }))
        : undefined

      const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model: modelParams.modelId,
        messages: openaiMessages,
        max_tokens: modelParams.maxTokens,
        temperature: modelParams.temperature,
        top_p: modelParams.topP,
        tools,
        tool_choice: tools ? (params.tool_choice ?? "auto") : undefined,
        response_format: modelParams.json ? { type: "json_object" } : undefined,
        stream: true,
      }

      let accumulatedCost = 0
      let toolCalls: any[] = []
      let hasYieldedToolCalls = false

      const stream = await client.chat.completions.create(requestParams)

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0]
        if (!choice) continue

        const delta = choice.delta
        const finishReason = choice.finish_reason

        // Handle text content
        if (delta?.content) {
          yield {
            text: delta.content,
            cost: 0, // Cost will be yielded at the end
          }
        }

        // Handle tool calls
        if (delta?.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index ?? 0
            if (!toolCalls[index]) {
              toolCalls[index] = {
                id: toolCall.id || "",
                type: "function" as const,
                function: {
                  name: "",
                  arguments: "",
                },
              }
            }
            if (toolCall.function?.name) {
              toolCalls[index].function.name = toolCall.function.name
            }
            if (toolCall.function?.arguments) {
              toolCalls[index].function.arguments +=
                toolCall.function.arguments
            }
          }
        }

        // Handle usage/cost information (usually in the last chunk)
        if ((chunk as any).usage) {
          const usage = (chunk as any).usage
          const costConfig = modelDetailsMap[modelParams.modelId]?.cost?.onDemand ?? {
            pricePerThousandInputTokens: 0,
            pricePerThousandOutputTokens: 0,
          }
          accumulatedCost = calculateCost(
            {
              inputTokens: usage.prompt_tokens || 0,
              outputTokens: usage.completion_tokens || 0,
            },
            costConfig,
          )
        }

        // Check if this is the final chunk
        if (finishReason) {
          // Yield tool calls if we have any and haven't yielded them yet
          if (toolCalls.length > 0 && !hasYieldedToolCalls) {
            hasYieldedToolCalls = true
            yield {
              text: "",
              tool_calls: toolCalls,
            }
          }
        }
      }

      // Yield final cost if we have it
      if (accumulatedCost > 0) {
        yield {
          text: "",
          cost: accumulatedCost,
        }
      }
    } catch (error) {
      Logger.error("LiteLLM Streaming Error:", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        errorType: error?.constructor?.name,
        modelId: modelParams.modelId,
      })
      throw new Error(`Failed to get response from LiteLLM: ${error}`)
    }
  }
}
