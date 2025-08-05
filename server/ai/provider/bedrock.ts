import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type Message,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime"
import { modelDetailsMap } from "@/ai/mappers"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders, Models } from "@/ai/types"
import BaseProvider from "@/ai/provider/base"
import { calculateCost } from "@/utils/index"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import fs from "fs"
import path from "path"
import os from "os"
const Logger = getLogger(Subsystem.AI)
import config from "@/config"
const { StartThinkingToken, EndThinkingToken } = config
import { findImageByName } from "@/ai/provider/base"
import { createLabeledImageContent } from "../utils"

// Global rate limiter for Bedrock to prevent throttling across all instances
class BedrockRateLimiter {
  private static instance: BedrockRateLimiter
  private requestTimes: number[] = []
  private readonly maxRequestsPerMinute = 3 // Even more conservative limit
  private readonly windowMs = 60000 // 1 minute window
  private lastRequestTime = 0
  private readonly minIntervalMs = 10000 // Minimum 10 seconds between requests

  private constructor() {}

  static getInstance(): BedrockRateLimiter {
    if (!BedrockRateLimiter.instance) {
      BedrockRateLimiter.instance = new BedrockRateLimiter()
    }
    return BedrockRateLimiter.instance
  }

  async waitForSlot(): Promise<void> {
    const now = Date.now()

    // Enforce minimum interval between requests
    const timeSinceLastRequest = now - this.lastRequestTime
    if (timeSinceLastRequest < this.minIntervalMs) {
      const waitTime = this.minIntervalMs - timeSinceLastRequest
      Logger.debug(
        `Bedrock rate limiter: enforcing minimum interval, waiting ${waitTime}ms`,
      )
      await new Promise((resolve) => setTimeout(resolve, waitTime))
    }

    // Remove old requests outside the window
    this.requestTimes = this.requestTimes.filter(
      (time) => now - time < this.windowMs,
    )

    // If we're at the limit, wait until we can make another request
    if (this.requestTimes.length >= this.maxRequestsPerMinute) {
      const oldestRequest = this.requestTimes[0]
      const waitTime = this.windowMs - (now - oldestRequest) + 1000 // Add 1s buffer

      if (waitTime > 0) {
        Logger.debug(
          `Bedrock rate limiter: waiting ${waitTime}ms before next request`,
        )
        await new Promise((resolve) => setTimeout(resolve, waitTime))
        return this.waitForSlot() // Recursively check again
      }
    }

    // Record this request
    const requestTime = Date.now()
    this.requestTimes.push(requestTime)
    this.lastRequestTime = requestTime

    Logger.debug(
      `Bedrock rate limiter: request approved, ${this.requestTimes.length}/${this.maxRequestsPerMinute} requests in current window`,
    )
  }
}

const bedrockRateLimiter = BedrockRateLimiter.getInstance()

// Helper function to convert images to Bedrock format
const buildBedrockImageParts = async (
  imagePaths: string[],
): Promise<ContentBlock[]> => {
  const baseDir = path.resolve(
    process.env.IMAGE_DIR || "downloads/xyne_images_db",
  )

  const imagePromises = imagePaths.map(async (imgPath) => {
    //  format: docIndex_docId_imageNumber
    const match = imgPath.match(/^([0-9]+)_(.+)_([0-9]+)$/)
    if (!match) {
      Logger.error(
        `Invalid image path format: ${imgPath}. Expected format: docIndex_docId_imageNumber`,
      )
      throw new Error(`Invalid image path: ${imgPath}`)
    }

    const docIndex = match[1]
    const docId = match[2]
    const imageNumber = match[3]

    if (docId.includes("..") || docId.includes("/") || docId.includes("\\")) {
      Logger.error(`Invalid docId containing path traversal: ${docId}`)
      throw new Error(`Invalid docId: ${docId}`)
    }

    const imageDir = path.join(baseDir, docId)
    const absolutePath = findImageByName(imageDir, imageNumber)
    const extension = path.extname(absolutePath).toLowerCase()

    // Map file extensions to Bedrock format values
    const formatMap: Record<string, string> = {
      ".png": "png",
      ".jpg": "jpeg",
      ".jpeg": "jpeg",
      ".gif": "gif",
      ".webp": "webp",
    }

    const format = formatMap[extension]
    if (!format) {
      Logger.warn(
        `Unsupported image format: ${extension}. Skipping image: ${absolutePath}`,
      )
      return null
    }

    // Ensure the resolved path is within baseDir
    const resolvedPath = path.resolve(imageDir)
    if (!resolvedPath.startsWith(baseDir)) {
      Logger.error(`Path traversal attempt detected: ${imageDir}`)
      throw new Error(`Invalid path: ${imageDir}`)
    }

    try {
      // Check if file exists before trying to read it
      await fs.promises.access(absolutePath, fs.constants.F_OK)
      const imageBytes = await fs.promises.readFile(absolutePath)
      if (imageBytes.length > 4 * 1024 * 1024) {
        Logger.warn(
          `Image buffer too large after read (${imageBytes.length} bytes, ${(imageBytes.length / (1024 * 1024)).toFixed(2)}MB): ${absolutePath}. Skipping this image.`,
        )
        return null
      }

      return {
        image: {
          format: format,
          source: {
            bytes: imageBytes,
          },
        },
      } as ContentBlock
    } catch (error) {
      Logger.error(
        `Failed to read image file ${absolutePath}: ${error instanceof Error ? error.message : error}`,
      )
      throw error
    }
  })

  const results = await Promise.all(imagePromises)
  return results.filter((result): result is ContentBlock => result !== null) // Remove any null entries
}

export class BedrockProvider extends BaseProvider {
  constructor(client: any) {
    super(client, AIProviders.AwsBedrock)
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    // Build image parts if they exist
    const imageParts =
      params.imageFileNames && params.imageFileNames.length > 0
        ? await buildBedrockImageParts(params.imageFileNames)
        : []
    // Find the last user message index to add images only to that message
    const lastUserMessageIndex =
      messages
        .map((m, idx) => ({ message: m, index: idx }))
        .reverse()
        .find(({ message }) => message.role === "user")?.index ?? -1

    // Transform messages to include images only in the last user message
    const transformedMessages = messages.map((message, index) => {
      if (index === lastUserMessageIndex && imageParts.length > 0) {
        // Combine image context instruction with user's message text
        // Find the first text content block
        const textBlocks = (message.content || []).filter(
          (c) => typeof c === "object" && "text" in c,
        )
        const otherBlocks = (message.content || []).filter(
          (c) => !(typeof c === "object" && "text" in c),
        )
        const userText = textBlocks.map((tb) => tb.text).join("\n")

        const newContent = createLabeledImageContent(
          userText,
          otherBlocks,
          imageParts,
          params.imageFileNames!,
        )
        return {
          ...message,
          content: newContent,
        }
      }
      return message
    })

    const command = new ConverseCommand({
      modelId: modelParams.modelId,
      system: [
        {
          text:
            modelParams.systemPrompt! +
            "\n\n" +
            "Important: In case you don't have the context, you can use the images in the context to answer questions. When referring to specific images in your response, please use the image labels provided to help users understand which image you're referencing.",
        },
      ],
      messages: transformedMessages,
      inferenceConfig: {
        maxTokens: modelParams.maxTokens || 512,
        topP: modelParams.topP || 0.9,
        temperature: modelParams.temperature || 0,
      },
    })

    // Enhanced throttling exception handling with exponential backoff
    const maxRetries = 5 // Increased from 3 to 5
    let lastError: any

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Wait for rate limiter slot before making the request
        await bedrockRateLimiter.waitForSlot()

        const response = await (this.client as BedrockRuntimeClient).send(
          command,
        )
        if (!response) {
          throw new Error("Invalid bedrock response")
        }

        let fullResponse = response.output?.message?.content?.reduce(
          (prev: string, current) => {
            prev += current.text
            return prev
          },
          "",
        )
        if (!response.usage) {
          throw new Error("Could not get usage")
        }
        const { inputTokens, outputTokens } = response.usage
        return {
          text: fullResponse,
          cost: calculateCost(
            { inputTokens: inputTokens!, outputTokens: outputTokens! },
            modelDetailsMap[modelParams.modelId].cost.onDemand,
          ),
        }
      } catch (error: any) {
        lastError = error

        // Check if it's a throttling exception
        const isThrottling =
          error?.name === "ThrottlingException" ||
          error?.message?.includes("Too many requests") ||
          error?.message?.includes("throttling") ||
          error?.$metadata?.httpStatusCode === 429

        if (isThrottling && attempt < maxRetries) {
          // More aggressive exponential backoff: 5s, 10s, 20s, 40s, 80s
          const backoffMs = Math.pow(2, attempt + 1) * 2500 // Increased base time
          Logger.warn(
            `Bedrock throttling detected, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`,
          )
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }

        // If not throttling or max retries exceeded, throw the error
        Logger.error(
          error,
          `Bedrock converse failed after ${attempt + 1} attempts`,
        )
        throw error
      }
    }

    // This should never be reached, but TypeScript requires it
    throw lastError
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    const reasoningModel =
      modelParams.modelId === Models.Claude_Sonnet_4 ||
      modelParams.modelId === Models.Claude_3_7_Sonnet
    const isThinkingEnabled = params.reasoning

    const reasoningConfig =
      isThinkingEnabled && reasoningModel
        ? {
            thinking: {
              type: "enabled",
              budget_tokens: 1024,
            },
          }
        : undefined

    const temperature =
      isThinkingEnabled && reasoningModel ? 1 : modelParams.temperature || 0.6

    const inferenceConfig = isThinkingEnabled
      ? {
          maxTokens: modelParams.maxTokens || 2500,
          temperature: temperature,
        }
      : {
          maxTokens: modelParams.maxTokens || 2500,
          topP: modelParams.topP || 0.9,
          temperature: temperature,
        }

    // Build image parts if they exist
    const imageParts =
      params.imageFileNames && params.imageFileNames.length > 0
        ? await buildBedrockImageParts(params.imageFileNames)
        : []
    // Find the last user message index to add images only to that message
    const lastUserMessageIndex =
      messages
        .map((m, idx) => ({ message: m, index: idx }))
        .reverse()
        .find(({ message }) => message.role === "user")?.index ?? -1

    // Transform messages to include images only in the last user message
    const transformedMessages = messages.map((message, index) => {
      if (index === lastUserMessageIndex && imageParts.length > 0) {
        // Combine image context instruction with user's message text
        // Find the first text content block
        const textBlocks = (message.content || []).filter(
          (c) => typeof c === "object" && "text" in c,
        )
        const otherBlocks = (message.content || []).filter(
          (c) => !(typeof c === "object" && "text" in c),
        )
        const userText = textBlocks.map((tb) => tb.text).join("\n")

        const newContent = createLabeledImageContent(
          userText,
          otherBlocks,
          imageParts,
          params.imageFileNames!,
        )
        return {
          ...message,
          content: newContent,
        }
      }
      return message
    })

    const command = new ConverseStreamCommand({
      modelId: modelParams.modelId,
      additionalModelRequestFields: reasoningConfig,
      system: [
        {
          text:
            modelParams.systemPrompt! +
            "\n\n" +
            "Important: In case you don't have the context, you can use the images in the context to answer questions. When referring to specific images in your response, please use the image labels provided to help users understand which image you're referencing.",
        },
      ],
      messages: transformedMessages,
      inferenceConfig,
    })

    let modelId = modelParams.modelId!
    let costYielded = false
    let startedReasoning = false
    let reasoningComplete = false

    // Enhanced throttling exception handling with exponential backoff
    const maxRetries = 5 // Increased from 3 to 5
    let lastError: any

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Wait for rate limiter slot before making the request
        await bedrockRateLimiter.waitForSlot()

        const response = await this.client.send(command)
        // we are handling the reasoning and normal text in the same iteration
        // using two different iteration for reasoning and normal text we are lossing some data of normal text
        if (response.stream) {
          for await (const chunk of response.stream) {
            // Handle reasoning content
            const reasoning =
              chunk.contentBlockDelta?.delta?.reasoningContent?.text || ""
            if (reasoning && isThinkingEnabled && !reasoningComplete) {
              if (!startedReasoning) {
                yield { text: `${StartThinkingToken}${reasoning}` }
                startedReasoning = true
              } else {
                yield { text: reasoning }
              }
            }

            // Handle reasoning completion
            if (
              chunk.contentBlockStop &&
              startedReasoning &&
              !reasoningComplete
            ) {
              yield { text: EndThinkingToken }
              reasoningComplete = true
              continue
            }

            // Handle regular content
            const text = chunk.contentBlockDelta?.delta?.text || ""
            const metadata = chunk.metadata

            if (text) {
              yield {
                text,
                metadata,
                cost:
                  !costYielded && metadata?.usage
                    ? calculateCost(
                        {
                          inputTokens: metadata.usage.inputTokens!,
                          outputTokens: metadata.usage.outputTokens!,
                        },
                        modelDetailsMap[modelId].cost.onDemand,
                      )
                    : undefined,
              }
              if (metadata?.usage) costYielded = true
            } else if (metadata?.usage && !costYielded) {
              costYielded = true
              yield {
                text: "",
                metadata,
                cost: calculateCost(
                  {
                    inputTokens: metadata.usage.inputTokens!,
                    outputTokens: metadata.usage.outputTokens!,
                  },
                  modelDetailsMap[modelId].cost.onDemand,
                ),
              }
            }
          }
        }
        return // Success, exit the retry loop
      } catch (error: any) {
        lastError = error

        // Check if it's a throttling exception
        const isThrottling =
          error?.name === "ThrottlingException" ||
          error?.message?.includes("Too many requests") ||
          error?.message?.includes("throttling") ||
          error?.$metadata?.httpStatusCode === 429

        if (isThrottling && attempt < maxRetries) {
          // More aggressive exponential backoff: 5s, 10s, 20s, 40s, 80s
          const backoffMs = Math.pow(2, attempt + 1) * 2500 // Increased base time
          Logger.warn(
            `Bedrock throttling detected in stream, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`,
          )
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }

        // If not throttling or max retries exceeded, throw the error
        Logger.error(
          error,
          `Bedrock converseStream failed after ${attempt + 1} attempts`,
        )
        throw error
      }
    }
  }
}
