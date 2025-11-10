import { type Message } from "@aws-sdk/client-bedrock-runtime"
import BaseProvider from "@/ai/provider/base"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import { calculateCost } from "@/utils/index"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { modelDetailsMap } from "@/ai/mappers"
import {
  parseLiteLLMResponse,
  parseLiteLLMStreamChunk,
  parseLiteLLMError,
  type LiteLLMResponse,
  type LiteLLMStreamChunk,
} from "@/ai/provider/Litellm/litellm-schemas"

const Logger = getLogger(Subsystem.AI)

interface LiteLLMClientConfig {
  apiKey: string
  baseURL: string
}

export class LiteLLM {
  private apiKey: string
  private baseURL: string

  constructor(clientConfig: LiteLLMClientConfig) {
    this.apiKey = clientConfig.apiKey
    this.baseURL = clientConfig.baseURL
  }

  getApiKey(): string {
    return this.apiKey
  }

  getBaseURL(): string {
    return this.baseURL
  }
}

export class LiteLLMProvider extends BaseProvider {
  constructor(client: LiteLLM) {
    super(client, AIProviders.LiteLLM)
  }

  private async handleAPIError(response: Response): Promise<never> {
    let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
    
    try {
      const errorData = await response.json() as unknown;
      const parsedError = parseLiteLLMError(errorData);
      errorMessage = parsedError.error.message;
    } catch {
      // Use default error message if parsing fails
    }

    if (response.status === 401) {
      throw new Error(
        `LiteLLM API error: LiteLLM - ${errorMessage}`
      );
    }

    if (response.status === 429) {
      throw new Error(
        `LiteLLM API error: LiteLLM - ${errorMessage}`
      );
    }

    throw new Error(
      `LiteLLM API error: LiteLLM - ${errorMessage}`,
      { cause: response.status >= 500 }
    );
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    const client = this.client as LiteLLM

    try {
      // Transform messages to OpenAI-compatible format
      const transformedMessages: any[] = messages.map((message) => {
        const role = message.role === "assistant" ? "assistant" : "user"
        return {
          role,
          content: message.content?.[0]?.text || "",
        }
      })

      const apiKey = client.getApiKey()
      const baseURL = client.getBaseURL()

      const payload = {
        model: modelParams.modelId,
        messages: [
          {
            role: "system",
            content:
              modelParams.systemPrompt! +
              "\n\n" +
              "Important: In case you don't have the context, you can use the images in the context to answer questions.",
          },
          ...transformedMessages,
        ],
        max_tokens: modelParams.maxTokens,
        temperature: modelParams.temperature,
        top_p: modelParams.topP,
        ...(modelParams.json
          ? { response_format: { type: "json_object" } }
          : {}),
        // Tool calling support
        ...(params.tools && params.tools.length
          ? {
              tools: params.tools.map((t) => ({
                type: "function" as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters:
                    t.parameters || { type: "object", properties: {} },
                },
              })),
              tool_choice: params.tool_choice ?? "auto",
            }
          : {}),
      }

      // Make direct HTTP call to LiteLLM proxy
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        await this.handleAPIError(response);
      }

      const responseText = await response.text()

      let data: LiteLLMResponse
      try {
        const parsed = JSON.parse(responseText) as unknown
        data = parseLiteLLMResponse(parsed)
      } catch (parseError) {
        Logger.error("Failed to parse LiteLLM response as JSON", {
          error: parseError,
          responseText: responseText.substring(0, 1000),
        })
        throw new Error(
          `Invalid JSON response from LiteLLM: ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
        )
      }

      return {
        text: data.choices[0].message.content || "",
        cost: calculateCost(
          {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
          },
          modelDetailsMap[modelParams.modelId]?.cost?.onDemand || {
            input: 0,
            output: 0,
          },
        ),
        ...(data.choices?.[0]?.message?.tool_calls?.length
          ? {
              tool_calls: (data.choices[0].message.tool_calls || []).map(
                (tc: any) => ({
                  id: tc.id || "",
                  type: "function" as const,
                  function: {
                    name: tc.function?.name || "",
                    arguments:
                      typeof tc.function?.arguments === "string"
                        ? tc.function.arguments
                        : JSON.stringify(tc.function?.arguments || {}),
                  },
                }),
              ),
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
    const client = this.client as LiteLLM

    try {
      // Transform messages to OpenAI-compatible format
      const transformedMessages: any[] = messages.map((message) => {
        const role = message.role === "assistant" ? "assistant" : "user"
        return {
          role,
          content: message.content?.[0]?.text || "",
        }
      })

      const apiKey = client.getApiKey()
      const baseURL = client.getBaseURL()

      const payload = {
        model: modelParams.modelId,
        messages: [
          {
            role: "system",
            content:
              modelParams.systemPrompt! +
              "\n\n" +
              "Important: In case you don't have the context, you can use the images in the context to answer questions.",
          },
          ...transformedMessages,
        ],
        max_tokens: modelParams.maxTokens,
        temperature: modelParams.temperature,
        top_p: modelParams.topP,
        stream: true,
        ...(modelParams.json
          ? { response_format: { type: "json_object" } }
          : {}),
        // Tool calling support
        ...(params.tools && params.tools.length
          ? {
              tools: params.tools.map((t) => ({
                type: "function" as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters:
                    t.parameters || { type: "object", properties: {} },
                },
              })),
              tool_choice: params.tool_choice ?? "auto",
            }
          : {}),
      }

      let accumulatedText = ""
      let accumulatedCost = 0
      let toolCalls: any[] = []
      let hasYieldedToolCalls = false

      // Make direct HTTP call to LiteLLM proxy with streaming
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        await this.handleAPIError(response);
      }

      if (!response.body) {
        throw new Error("No response body for streaming request")
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            break
          }

          const chunk = decoder.decode(value, { stream: true })
          const lines = chunk.split("\n").filter((line) => line.trim() !== "")

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6)

              if (data === "[DONE]") {
                // Stream is complete
                continue
              }

              try {
                const parsedJson = JSON.parse(data) as unknown
                const parsed: LiteLLMStreamChunk = parseLiteLLMStreamChunk(parsedJson)

                const choice = parsed.choices?.[0]
                if (!choice) continue

                const delta = choice.delta
                const finishReason = choice.finish_reason

                // Handle text content
                if (delta?.content) {
                  accumulatedText += delta.content
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
                if (parsed.usage) {
                  accumulatedCost = calculateCost(
                    {
                      inputTokens: parsed.usage.prompt_tokens || 0,
                      outputTokens: parsed.usage.completion_tokens || 0,
                    },
                    modelDetailsMap[modelParams.modelId]?.cost?.onDemand || {
                      input: 0,
                      output: 0,
                    },
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
              } catch (parseError) {
                Logger.warn("Failed to parse streaming chunk", {
                  chunkData: data.substring(0, 200),
                  error:
                    parseError instanceof Error
                      ? parseError.message
                      : String(parseError),
                })
              }
            }
          }
        }
      } finally {
        reader.releaseLock()
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
