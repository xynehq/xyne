import { Anthropic } from "@anthropic-ai/sdk"
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"
import { GoogleGenerativeAI } from "@google/generative-ai"
import BaseProvider from "./base"
import { AIProviders, ModelParams, ConverseResponse } from "../types"
import { GeminiAIProvider } from "./gemini"

export class VertexAIProvider extends BaseProvider {
  private clientAnthropic: AnthropicVertex
  private geminiProvider: GeminiAIProvider | null = null
  private projectId: string
  private region: string

  constructor(config: {
    projectId: string
    region: string
    apiKey?: string // For Gemini models via Google AI
  }) {
    super(null, AIProviders.VertexAI)

    this.projectId = config.projectId
    this.region = config.region

    // Initialize Anthropic client for Claude models
    // This uses Application Default Credentials (ADC) from gcloud auth
    this.clientAnthropic = new AnthropicVertex({
      projectId: this.projectId,
      region: this.region,
    })

    // Initialize Gemini provider for Gemini models only if API key is provided
    if (config.apiKey) {
      const googleAI = new GoogleGenerativeAI(config.apiKey)
      this.geminiProvider = new GeminiAIProvider(googleAI)
    }
  }

  async converse(
    messages: any[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    const modelId = modelParams.modelId

    // For Gemini models, delegate to Gemini provider
    if (this.isGeminiModel(modelId)) {
      if (!this.geminiProvider) {
        throw new Error(
          "Gemini models require Google AI API key to be configured",
        )
      }
      return this.geminiProvider.converse(messages, params)
    }

    // Claude implementation
    try {
      const systemPrompt =
        modelParams.systemPrompt || "You are a helpful AI assistant."

      // Convert messages to Anthropic format
      const anthropicMessages = this.convertToAnthropicMessages(messages)

      // Try to use the specified model, with fallback for unavailable models
      let modelToUse = modelId

      const response = await this.clientAnthropic.beta.messages.create({
        model: modelToUse,
        max_tokens: modelParams.maxTokens || 8192,
        temperature: modelParams.temperature || 0,
        system: systemPrompt,
        messages: anthropicMessages,
      })

      const text = response.content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("")

      const cost = this.calculateCost(
        response.usage?.input_tokens || 0,
        response.usage?.output_tokens || 0,
        modelId,
      )

      return {
        text,
        cost,
        metadata: {
          model: modelId,
          inputTokens: response.usage?.input_tokens || 0,
          outputTokens: response.usage?.output_tokens || 0,
          responseTime: Date.now(),
        },
        isComplete: true,
      }
    } catch (error: any) {
      console.error("Vertex AI error:", error)

      // If the specific model version is not found, provide a helpful error message
      if (
        error.message &&
        error.message.includes("404") &&
        error.message.includes("not found")
      ) {
        throw new Error(
          `Model ${modelId} is not available in region ${this.region}. Please try a different region like us-central1, or use a different model version.`,
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
    const modelId = modelParams.modelId

    // For Gemini models, delegate to Gemini provider
    if (this.isGeminiModel(modelId)) {
      if (!this.geminiProvider) {
        throw new Error(
          "Gemini models require Google AI API key to be configured",
        )
      }
      yield* this.geminiProvider.converseStream(messages, params)
      return
    }

    // Claude implementation
    try {
      const systemPrompt =
        modelParams.systemPrompt || "You are a helpful AI assistant."

      // Convert messages to Anthropic format
      const anthropicMessages = this.convertToAnthropicMessages(messages)

      // Try to use the specified model, with fallback for unavailable models
      let modelToUse = modelId

      // Determine if reasoning should be enabled
      const reasoningOn =
        modelId.includes("claude-sonnet-4") ||
        modelId.includes("claude-3-5-sonnet-v2") ||
        modelId.includes("claude-3-opus")

      const stream = await this.clientAnthropic.beta.messages.create({
        model: modelToUse,
        max_tokens: modelParams.maxTokens || 8192,
        temperature: reasoningOn ? undefined : modelParams.temperature || 0,
        system: [
          {
            text: systemPrompt,
            type: "text",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: this.addCacheControl(anthropicMessages),
        stream: true,
      })

      let totalInputTokens = 0
      let totalOutputTokens = 0
      let fullText = ""

      for await (const chunk of stream) {
        switch (chunk?.type) {
          case "message_start":
            const usage = chunk.message.usage
            totalInputTokens = usage.input_tokens || 0
            totalOutputTokens = usage.output_tokens || 0
            yield {
              text: "",
              cost: 0,
              metadata: {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
              },
            }
            break

          case "message_delta":
            totalOutputTokens += chunk.usage?.output_tokens || 0
            break

          case "content_block_start":
            switch (chunk.content_block.type) {
              case "thinking":
                // Handle reasoning content
                yield {
                  text: "",
                  metadata: {
                    reasoning: chunk.content_block.thinking || "",
                  },
                }
                break
              case "text":
                if (chunk.index > 0) {
                  yield { text: "\n" }
                  fullText += "\n"
                }
                const startText = chunk.content_block.text
                yield { text: startText }
                fullText += startText
                break
            }
            break

          case "content_block_delta":
            switch (chunk.delta.type) {
              case "thinking_delta":
                yield {
                  text: "",
                  metadata: {
                    reasoning: chunk.delta.thinking,
                  },
                }
                break
              case "text_delta":
                yield { text: chunk.delta.text }
                fullText += chunk.delta.text
                break
            }
            break

          case "message_stop":
            const finalCost = this.calculateCost(
              totalInputTokens,
              totalOutputTokens,
              modelId,
            )
            yield {
              text: "",
              cost: finalCost,
              metadata: {
                model: modelId,
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                responseTime: Date.now(),
              },
              isComplete: true,
            }
            break
        }
      }
    } catch (error: any) {
      console.error("Vertex AI streaming error:", error)

      // If the specific model version is not found, provide a helpful error message
      if (
        error.message &&
        error.message.includes("404") &&
        error.message.includes("not found")
      ) {
        throw new Error(
          `Model ${modelId} is not available in region ${this.region}. Please try a different region like us-central1, or use a different model version.`,
        )
      }

      throw error
    }
  }

  private isGeminiModel(modelId: string): boolean {
    return modelId.includes("gemini")
  }

  private convertToAnthropicMessages(
    messages: any[],
  ): Anthropic.Messages.MessageParam[] {
    return messages.map((message) => ({
      role: message.role === "system" ? "user" : message.role,
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((block: any) => {
              if (block.text) {
                return { type: "text", text: block.text }
              }
              if (block.image) {
                return {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: `image/${block.image.format}`,
                    data: block.image.source.bytes,
                  },
                }
              }
              return block
            }),
    }))
  }

  private addCacheControl(
    messages: Anthropic.Messages.MessageParam[],
  ): Anthropic.Messages.MessageParam[] {
    // Find indices of user messages for cache control
    const userMsgIndices = messages.reduce(
      (acc, msg, index) => (msg.role === "user" ? [...acc, index] : acc),
      [] as number[],
    )
    const lastUserMsgIndex = userMsgIndices[userMsgIndices.length - 1] ?? -1
    const secondLastMsgUserIndex =
      userMsgIndices[userMsgIndices.length - 2] ?? -1

    return messages.map((message, index) => {
      if (index === lastUserMsgIndex || index === secondLastMsgUserIndex) {
        return {
          ...message,
          content:
            typeof message.content === "string"
              ? [
                  {
                    type: "text",
                    text: message.content,
                    cache_control: { type: "ephemeral" },
                  },
                ]
              : message.content.map((content: any, contentIndex: number) =>
                  contentIndex === message.content.length - 1
                    ? {
                        ...content,
                        cache_control: { type: "ephemeral" },
                      }
                    : content,
                ),
        }
      }
      return {
        ...message,
        content:
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content,
      }
    })
  }

  private calculateCost(
    inputTokens: number,
    outputTokens: number,
    modelId: string,
  ): number {
    // Cost calculation based on Vertex AI pricing
    // These are approximate rates - should be updated with actual Vertex pricing
    const costs: Record<string, { input: number; output: number }> = {
      "claude-sonnet-4@20250514": { input: 0.003, output: 0.015 },
      "claude-3-5-sonnet-v2@20241022": { input: 0.003, output: 0.015 },
      "claude-3-5-sonnet@20240620": { input: 0.003, output: 0.015 },
      "claude-3-5-haiku@20241022": { input: 0.00025, output: 0.00125 },
      "claude-3-opus@20240229": { input: 0.015, output: 0.075 },
      "claude-3-haiku@20240307": { input: 0.00025, output: 0.00125 },
      // Gemini models (fallback pricing)
      "gemini-2.0-flash-exp": { input: 0.000075, output: 0.0003 },
      "gemini-1.5-pro-002": { input: 0.00125, output: 0.005 },
      "gemini-1.5-flash-002": { input: 0.000075, output: 0.0003 },
    }

    const modelCosts = costs[modelId] || { input: 0.003, output: 0.015 } // Default to Sonnet pricing
    return (
      (inputTokens * modelCosts.input + outputTokens * modelCosts.output) / 1000
    )
  }
}
