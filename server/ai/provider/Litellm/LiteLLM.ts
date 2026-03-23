import { type Message } from "@aws-sdk/client-bedrock-runtime"
import BaseProvider, { findImageByName, regex } from "@/ai/provider/base"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import { calculateCost } from "@/utils/index"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { modelDetailsMap } from "@/ai/mappers"
import OpenAI from "openai"
import { getCostConfigForModel } from "@/ai/fetchModels"
import config from "@/config"
import fs from "fs"
import path from "path"

const Logger = getLogger(Subsystem.AI)
const { StartThinkingToken, EndThinkingToken } = config

const imageFormatToMimeType: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

const getMessageText = (message: Message): string =>
  (message.content ?? [])
    .filter((block: any) => typeof block?.text === "string")
    .map((block: any) => block.text)
    .join("\n")

function extractReasoningText(rawReasoning: any): string {
  if (typeof rawReasoning === "string") {
    return rawReasoning
  }
  if (Array.isArray(rawReasoning)) {
    return rawReasoning
      .map((part: any) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("")
  }
  if (rawReasoning && typeof rawReasoning === "object") {
    return (rawReasoning as any).text || ""
  }
  return ""
}

const buildLiteLLMImageParts = async (
  imagePaths: string[],
): Promise<OpenAI.Chat.Completions.ChatCompletionContentPartImage[]> => {
  const baseDir = path.resolve(process.env.IMAGE_DIR || "downloads/xyne_images_db")

  const imagePromises = imagePaths.map(async (imgPath) => {
    const match = imgPath.match(regex)
    if (!match) {
      Logger.warn(
        `Invalid image path format: ${imgPath}. Expected format: docIndex_docId_imageNumber`,
      )
      return null
    }

    const docId = match[2]
    const imageNumber = match[3]

    if (docId.includes("..") || docId.includes("/") || docId.includes("\\")) {
      Logger.warn(`Invalid docId containing path traversal: ${docId}`)
      return null
    }

    const imageDir = path.join(baseDir, docId)
    const absolutePath = findImageByName(imageDir, imageNumber)
    const extension = path.extname(absolutePath).toLowerCase()
    const mimeType = imageFormatToMimeType[extension.replace(".", "")]
    if (!mimeType) {
      Logger.warn(
        `Unsupported image format: ${extension}. Skipping image: ${absolutePath}`,
      )
      return null
    }

    const resolvedPath = path.resolve(imageDir)
    if (!resolvedPath.startsWith(baseDir)) {
      Logger.warn(`Path traversal attempt detected: ${imageDir}`)
      return null
    }

    try {
      await fs.promises.access(absolutePath, fs.constants.F_OK)
      const imageBytes = await fs.promises.readFile(absolutePath)

      if (imageBytes.length > 4 * 1024 * 1024) {
        Logger.warn(
          `Image buffer too large after read (${imageBytes.length} bytes, ${(imageBytes.length / (1024 * 1024)).toFixed(2)}MB): ${absolutePath}. Skipping this image.`,
        )
        return null
      }

      return {
        type: "image_url" as const,
        image_url: {
          url: `data:${mimeType};base64,${imageBytes.toString("base64")}`,
        },
      }
    } catch (error) {
      Logger.warn(
        `Failed to read image file ${absolutePath}: ${error instanceof Error ? error.message : error}`,
      )
      return null
    }
  })

  const results = await Promise.all(imagePromises)
  return results.filter(
    (
      part,
    ): part is OpenAI.Chat.Completions.ChatCompletionContentPartImage =>
      part !== null,
  )
}

const transformLiteLLMMessages = async (
  messages: Message[],
  imageFileNames?: string[],
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> => {
  const imageParts =
    imageFileNames && imageFileNames.length > 0
      ? await buildLiteLLMImageParts(imageFileNames)
      : []

  const lastUserMessageIndex =
    messages
      .map((m, idx) => ({ message: m, index: idx }))
      .reverse()
      .find(({ message }) => message.role === "user")?.index ?? -1

  return messages.map((message, index) => {
    const role = message.role === "assistant" ? "assistant" : "user"
    const text = getMessageText(message)

    if (role === "user" && index === lastUserMessageIndex && imageParts.length > 0) {
      const labeledParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
        {
          type: "text",
          text:
            "You may receive image(s) as part of the conversation. If images are attached, treat them as essential context for the user's question. When referring to images in your response, please use the labels provided [docIndex_imageNumber] (e.g., [0_12], [7_2], etc.).\n\n" +
            text,
        },
      ]

      imageParts.forEach((part, i) => {
        const imageFileName = imageFileNames?.[i] || ""
        const match = imageFileName.match(regex)
        if (match) {
          labeledParts.push({
            type: "text",
            text: `\n--- imageNumber: ${match[3]}, docIndex: ${match[1]} ---`,
          })
        }
        labeledParts.push(part)
      })

      return {
        role: "user",
        content: labeledParts,
      }
    }

    return {
      role,
      content: text,
    }
  })
}

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
    Logger.info({
      modelId: modelParams.modelId,
      thinking: params.reasoning ?? false,
    }, "LiteLLM Converse called with model:")
    const client = (this.client as LiteLLM).getClient()

    try {
      // Transform messages to OpenAI-compatible format
      const transformedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        await transformLiteLLMMessages(messages, params.imageFileNames)

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

      const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & { extra_body?: Record<string, unknown> } = {
        model: modelParams.modelId,
        messages: openaiMessages,
        max_tokens: modelParams.maxTokens,
        temperature: modelParams.temperature,
        tools,
        tool_choice: tools ? (params.tool_choice ?? "auto") : undefined,
        response_format: modelParams.json ? { type: "json_object" } : undefined,
        extra_body: {
          chat_template_kwargs: {
            enable_thinking: params.reasoning ?? false,
          },
        },
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

      // Fetch cost configuration from API with fallback to default config (uses cached data)
      const costConfig = await getCostConfigForModel(modelParams.modelId)

      const calculatedCost = calculateCost(
        {
          inputTokens,
          outputTokens,
        },
        costConfig,
      )

      return {
        text: messageContent,
        cost: calculatedCost,
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
    Logger.info({
      modelId: modelParams.modelId,
      thinking: params.reasoning ?? false,
    }, "LiteLLM ConverseStream called with model:")
    const client = (this.client as LiteLLM).getClient()

    try {
      // Transform messages to OpenAI-compatible format
      const transformedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        await transformLiteLLMMessages(messages, params.imageFileNames)

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

      const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & { extra_body?: Record<string, unknown> } = {
        model: modelParams.modelId,
        messages: openaiMessages,
        max_tokens: modelParams.maxTokens,
        temperature: modelParams.temperature,
        tools,
        tool_choice: tools ? (params.tool_choice ?? "auto") : undefined,
        response_format: modelParams.json ? { type: "json_object" } : undefined,
        stream: true,
        stream_options: {
          include_usage: true,
        },
        extra_body: {
          chat_template_kwargs: {
            enable_thinking: params.reasoning ?? false,
          },
        },
      }

      let accumulatedCost = 0
      let toolCalls: any[] = []
      let hasYieldedToolCalls = false
      let startedReasoning = false
      let reasoningComplete = false

      const stream = await client.chat.completions.create(requestParams)

      // Fetch cost configuration once before processing stream (uses cached data)
      const costConfig = await getCostConfigForModel(modelParams.modelId)

      for await (const chunk of stream) {
        // Check for usage information first (may come in a chunk without choices)
        const usage = (chunk as any).usage
        if (usage) {
          const inputTokens = usage.prompt_tokens || 0
          const outputTokens = usage.completion_tokens || 0

          accumulatedCost = calculateCost(
            {
              inputTokens,
              outputTokens,
            },
            costConfig,
          )
          
          // Continue to process the chunk even if it has usage
        }

        const choice = chunk.choices?.[0]
        if (!choice) {
          // Chunk without choices might be a usage-only chunk, which we already handled above
          continue
        }

        const delta = choice.delta
        const finishReason = choice.finish_reason

        // Handle reasoning content from OpenAI-compatible providers (LiteLLM backends vary).
        if (params.reasoning && !reasoningComplete) {
          const rawReasoning =
            (delta as any)?.reasoning_content ??
            (delta as any)?.reasoning ??
            (delta as any)?.reasoning_text
          const reasoningText = extractReasoningText(rawReasoning)
          if (reasoningText) {
            if (!startedReasoning) {
              yield { text: `${StartThinkingToken}${reasoningText}` }
              startedReasoning = true
            } else {
              yield { text: reasoningText }
            }
          }
        }

        // Handle text content.
        // Some LiteLLM backends may start emitting answer content before finish_reason.
        // Close thinking as soon as first content token arrives so downstream parser can consume JSON.
        if (delta?.content) {
          if (params.reasoning && !reasoningComplete) {
            yield { text: EndThinkingToken }
            reasoningComplete = true
          }
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

        // Check if this is the final chunk
        if (finishReason) {
          // Close reasoning segment if it was started.
          if (startedReasoning && !reasoningComplete) {
            yield { text: EndThinkingToken }
            reasoningComplete = true
          }
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

      // Check if stream object has usage info after iteration (fallback)
      // Also check for LiteLLM's response_cost in _hidden_params
      const streamUsage = (stream as any).usage || (stream as any).response?.usage
      const responseCost = (stream as any)._hidden_params?.response_cost || (stream as any).response_cost

      // If LiteLLM provides response_cost directly, use it
      if (responseCost && typeof responseCost === 'number' && accumulatedCost === 0) {
        accumulatedCost = responseCost
      } else if (streamUsage && accumulatedCost === 0) {
        const inputTokens = streamUsage.prompt_tokens || streamUsage.input_tokens || 0
        const outputTokens = streamUsage.completion_tokens || streamUsage.output_tokens || 0

        accumulatedCost = calculateCost(
          {
            inputTokens,
            outputTokens,
          },
          costConfig,
        )
      }

      // Yield final cost if we have it
      if (accumulatedCost > 0) {
        yield {
          text: "",
          cost: accumulatedCost,
        }
      } else {
        Logger.warn({
          message: "LiteLLM Stream: No cost calculated - usage info not found in stream or stream object",
          modelId: modelParams.modelId,
          accumulatedCost,
          streamObjectKeys: streamUsage ? Object.keys(streamUsage) : "N/A",
        })
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
