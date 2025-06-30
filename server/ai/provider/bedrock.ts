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

// Helper function to convert images to Bedrock format
const buildBedrockImageParts = (imagePaths: string[]): ContentBlock[] => {
  const baseDir = path.resolve(
    process.env.IMAGE_DIR || "downloads/xyne_images_db",
  )
  return imagePaths
    .map((imgPath) => {
      // Check if the file already has an extension, if not add .png
      const match = imgPath.match(/^(.+)_([0-9]+)$/)
      if (!match) {
        Logger.error(`Invalid image path: ${imgPath}`)
        throw new Error(`Invalid image path: ${imgPath}`)
      }
      const imageDir = path.join(baseDir, match[1])
      const fileName = path.extname(match[2]) ? match[2] : `${match[2]}.png`
      const absolutePath = path.join(imageDir, fileName)

      try {
        // Check if file exists before trying to read it
        if (!fs.existsSync(absolutePath)) {
          Logger.error(`Image file does not exist: ${absolutePath}`)
          throw new Error(`Image file not found: ${absolutePath}`)
        }

        const imageBytes = fs.readFileSync(absolutePath)

        return {
          image: {
            format: "png" as const,
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
    .filter(Boolean) // Remove any null/undefined entries
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
    const command = new ConverseCommand({
      modelId: modelParams.modelId,
      system: [
        {
          text: modelParams.systemPrompt!,
        },
      ],
      messages,
      inferenceConfig: {
        maxTokens: modelParams.maxTokens || 512,
        topP: modelParams.topP || 0.9,
        temperature: modelParams.temperature || 0,
      },
    })
    const response = await (this.client as BedrockRuntimeClient).send(command)
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
        ? buildBedrockImageParts(params.imageFileNames)
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
        // Add images to the last user message
        return {
          ...message,
          content: [...message.content!, ...imageParts],
        }
      }
      return message
    })

    const command = new ConverseStreamCommand({
      modelId: modelParams.modelId,
      additionalModelRequestFields: reasoningConfig,
      system: [{ text: modelParams.systemPrompt! }],
      messages: transformedMessages,
      inferenceConfig,
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
    } catch (error) {
      Logger.error(error, "Error in converseStream of Bedrock")
      throw error
    }
  }
}
