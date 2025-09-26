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
import BaseProvider, { regex } from "@/ai/provider/base"
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

// Helper function to convert images to Bedrock format
const buildBedrockImageParts = async (
  imagePaths: string[],
): Promise<ContentBlock[]> => {
  const baseDir = path.resolve(
    process.env.IMAGE_DIR || "downloads/xyne_images_db",
  )

  const imagePromises = imagePaths.map(async (imgPath) => {
    const match = imgPath.match(regex)
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
    // Build Bedrock tool configuration if tools provided
    // Bedrock Converse expects tools as { toolSpec: { name, description, inputSchema: { json } } }
    const toolConfig = params.tools && params.tools.length
      ? {
          tools: params.tools.map((t) => ({
            toolSpec: {
              name: t.name,
              description: t.description,
              inputSchema: {
                json: t.parameters || { type: "object", properties: {} },
              },
            },
          })),
        }
      : undefined

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
      ...(toolConfig ? { toolConfig } : {}),
    })
    const response = await (this.client as BedrockRuntimeClient).send(command)
    if (!response) {
      throw new Error("Invalid bedrock response")
    }

    const contentBlocks = response.output?.message?.content ?? []
    const fullResponse = contentBlocks
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join("")
    // Extract tool use calls if present
    const toolCalls = (response.output?.message?.content || [])
      .filter((c: any) => (c as any).toolUse)
      .map((c: any) => {
        const tu = (c as any).toolUse
        return {
          id: tu?.toolUseId || "",
          type: "function" as const,
          function: {
            name: tu?.name || "",
            arguments: tu?.input ? JSON.stringify(tu.input) : "{}",
          },
        }
      })
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
      ...(toolCalls && toolCalls.length ? { tool_calls: toolCalls } : {}),
    }
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

    // Build Bedrock tool configuration if tools provided
    // Bedrock Converse expects tools as { toolSpec: { name, description, inputSchema: { json } } }
    const toolConfig = params.tools && params.tools.length
      ? {
          tools: params.tools.map((t) => ({
            toolSpec: {
              name: t.name,
              description: t.description,
              inputSchema: {
                json: t.parameters || { type: "object", properties: {} },
              },
            },
          })),
        }
      : undefined

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
      ...(toolConfig ? { toolConfig } : {}),
    })

    let modelId = modelParams.modelId!
    let costYielded = false
    let startedReasoning = false
    let reasoningComplete = false

    try {
      const response = await this.client.send(command)
      // we are handling the reasoning and normal text in the same iteration
      // using two different iteration for reasoning and normal text we are lossing some data of normal text
      if (response.stream) {
        // Accumulate tool use inputs by toolUseId
        const toolUseBuffers: Record<string, { name: string; args: string }> = {}
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

          // Detect tool use start
          const toolUseStart: any = (chunk as any)?.contentBlockStart?.start?.toolUse
          if (toolUseStart?.name) {
            const id = toolUseStart.toolUseId || `${Date.now()}-${Math.random()}`
            toolUseBuffers[id] = { name: toolUseStart.name, args: "" }
          }
          // Accumulate tool use input JSON deltas (best-effort mapping of Bedrock stream)
          const toolUseDelta: any = (chunk as any)?.contentBlockDelta?.delta?.toolUse
          if (toolUseDelta?.inputText && Object.keys(toolUseBuffers).length) {
            // If SDK emits inputText chunks
            const lastId = Object.keys(toolUseBuffers).slice(-1)[0]
            toolUseBuffers[lastId].args += toolUseDelta.inputText
          }
          if (toolUseDelta?.input && Object.keys(toolUseBuffers).length) {
            const lastId = Object.keys(toolUseBuffers).slice(-1)[0]
            toolUseBuffers[lastId].args += JSON.stringify(toolUseDelta.input)
          }
          // On content block stop, flush tool call if present
          const toolUseStop: any = (chunk as any)?.contentBlockStop?.stop?.toolUse
          if (toolUseStop) {
            const id = toolUseStop.toolUseId
            const rec = id ? toolUseBuffers[id] : undefined
            if (rec) {
              const toolCalls = [
                {
                  id,
                  type: "function" as const,
                  function: {
                    name: rec.name,
                    arguments: rec.args || "{}",
                  },
                },
              ]
              yield { tool_calls: toolCalls }
              delete toolUseBuffers[id]
            }
          }

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
    } catch (error) {
      Logger.error(error, "Error in converseStream of Bedrock")
      throw error
    }
  }
}
