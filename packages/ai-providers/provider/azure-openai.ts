import { AzureOpenAI } from "openai"
import BaseProvider from "./base"
import { AIProviders, ConverseResponse, ModelParams } from "../types"
import { getLogger } from "../logger"
import { Subsystem } from "../server-types"

const logger = getLogger(Subsystem.AI)

export default class AzureOpenAIProvider extends BaseProvider {
  public client: AzureOpenAI
  private deploymentName: string

  constructor(config: any, modelId: string) {
    const azureClient = new AzureOpenAI({
      endpoint: config.azureEndpoint,
      apiKey: config.apiKey,
      apiVersion: config.azureApiVersion || "2024-02-15-preview",
    })

    super(azureClient, AIProviders.AzureOpenAI)

    if (!config.apiKey) {
      throw new Error("Azure OpenAI API key is required")
    }

    if (!config.azureEndpoint) {
      throw new Error("Azure OpenAI endpoint is required")
    }

    if (!config.azureDeploymentName) {
      throw new Error("Azure OpenAI deployment name is required")
    }

    this.deploymentName = config.azureDeploymentName
    this.client = azureClient

    logger.info(
      `🔷 Azure OpenAI provider initialized with deployment: ${this.deploymentName}`,
    )
  }

  private convertMessages(messages: any[]): any[] {
    return messages.map((msg) => {
      if (Array.isArray(msg.content)) {
        // Handle content blocks (text and images)
        const content: any[] = []

        msg.content.forEach((block: any) => {
          if (block.text) {
            content.push({ type: "text", text: block.text })
          } else if (block.image) {
            // Convert image format to Azure OpenAI format
            const mimeType = `image/${block.image.format}`
            let base64Data: string
            if (typeof block.image.source.bytes === "string") {
              // Already base64 encoded
              base64Data = block.image.source.bytes
            } else if (block.image.source.bytes instanceof Uint8Array) {
              // Convert Uint8Array to base64 safely for large images
              const uint8Array = block.image.source.bytes
              let binaryString = ""
              const chunkSize = 32768 // Process in chunks to avoid stack overflow
              for (let i = 0; i < uint8Array.length; i += chunkSize) {
                const chunk = uint8Array.slice(i, i + chunkSize)
                binaryString += String.fromCharCode.apply(
                  null,
                  Array.from(chunk),
                )
              }
              base64Data = btoa(binaryString)
            } else {
              // Fallback: convert to string and encode
              base64Data = btoa(String(block.image.source.bytes))
            }

            content.push({
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Data}`,
              },
            })
          }
        })

        return {
          role: msg.role,
          content:
            content.length === 1 && content[0].type === "text"
              ? content[0].text
              : content,
        }
      } else {
        return {
          role: msg.role,
          content: msg.content,
        }
      }
    })
  }

  async converse(
    messages: any[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    const openAiMessages = [
      { role: "system", content: modelParams.systemPrompt },
      ...this.convertMessages(messages),
    ]

    try {
      const response = await this.client.chat.completions.create({
        model: this.deploymentName, // Use deployment name instead of model name
        messages: openAiMessages,
        temperature: modelParams.temperature,
        max_tokens: modelParams.maxTokens,
        top_p: modelParams.topP,
      })

      const choice = response.choices[0]
      const content = choice?.message?.content || ""

      return {
        text: content,
        metadata: {
          finishReason: choice?.finish_reason || "stop",
          usage: {
            inputTokens: response.usage?.prompt_tokens || 0,
            outputTokens: response.usage?.completion_tokens || 0,
          },
        },
      }
    } catch (error) {
      logger.error(error, "❌ Azure OpenAI API error")
      throw error
    }
  }

  async *converseStream(
    messages: any[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    const openAiMessages = [
      { role: "system", content: modelParams.systemPrompt },
      ...this.convertMessages(messages),
    ]

    try {
      const stream = await this.client.chat.completions.create({
        model: this.deploymentName, // Use deployment name
        messages: openAiMessages,
        temperature: modelParams.temperature,
        max_tokens: modelParams.maxTokens,
        top_p: modelParams.topP,
        stream: true,
        stream_options: { include_usage: true },
      })

      let inputTokens = 0
      let outputTokens = 0

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta

        if (delta?.content) {
          yield {
            text: delta.content,
            metadata: {
              finishReason: chunk.choices[0]?.finish_reason,
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          }
        }

        // Handle usage information
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || 0
          outputTokens = chunk.usage.completion_tokens || 0
        }
      }

      // Final yield with usage stats
      yield {
        text: "",
        metadata: {
          finishReason: "stop",
          usage: { inputTokens, outputTokens },
        },
      }

      logger.info(
        `✅ Azure OpenAI stream completed. Tokens: ${inputTokens}→${outputTokens}`,
      )
    } catch (error) {
      logger.error(error, "❌ Azure OpenAI streaming error")
      throw error
    }
  }
}
