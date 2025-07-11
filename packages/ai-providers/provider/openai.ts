import { type Message } from "@aws-sdk/client-bedrock-runtime"
import OpenAI from "openai"
import { modelDetailsMap } from "../mappers"
import type { ConverseResponse, ModelParams } from "../types"
import { AIProviders } from "../types"
import BaseProvider from "./base"
import { calculateCost } from "../utils"
import { getLogger } from "../logger"
import { Subsystem } from "../server-types"
import fs from "fs"
import path from "path"
import { findImageByName } from "./base"

const Logger = getLogger(Subsystem.AI)

// Helper function to convert images to OpenAI format
const buildOpenAIImageParts = async (imagePaths: string[]) => {
  const baseDir = path.resolve(
    process.env.IMAGE_DIR || "downloads/xyne_images_db",
  )

  const imagePromises = imagePaths.map(async (imgPath) => {
    // Check if the file already has an extension, if not add .png
    const match = imgPath.match(/^(.+)_([0-9]+)$/)
    if (!match) {
      Logger.error(`Invalid image path: ${imgPath}`)
      throw new Error(`Invalid image path: ${imgPath}`)
    }

    // Validate that the docId doesn't contain path traversal characters
    const docId = match[1]
    if (docId.includes("..") || docId.includes("/") || docId.includes("\\")) {
      Logger.error(`Invalid docId containing path traversal: ${docId}`)
      throw new Error(`Invalid docId: ${docId}`)
    }

    const imageDir = path.join(baseDir, docId)
    const absolutePath = findImageByName(imageDir, match[2])
    const extension = path.extname(absolutePath).toLowerCase()

    // Map file extensions to MIME types for OpenAI
    const mimeTypeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
    }

    const mimeType = mimeTypeMap[extension]
    if (!mimeType) {
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

      // Check file size (4MB limit for OpenAI)
      if (imageBytes.length > 4 * 1024 * 1024) {
        Logger.warn(
          `Image buffer too large after read (${imageBytes.length} bytes, ${(imageBytes.length / (1024 * 1024)).toFixed(2)}MB): ${absolutePath}. Skipping this image.`,
        )
        return null
      }

      const base64Data = imageBytes.toString("base64")

      return {
        type: "image_url" as const,
        image_url: {
          url: `data:${mimeType};base64,${base64Data}`,
        },
      }
    } catch (error) {
      Logger.error(
        `Failed to read image file ${absolutePath}: ${error instanceof Error ? error.message : error}`,
      )
      throw error
    }
  })

  const results = await Promise.all(imagePromises)
  return results.filter(Boolean) // Remove any null/undefined entries
}

export class OpenAIProvider extends BaseProvider {
  constructor(client: OpenAI) {
    super(client, AIProviders.OpenAI)
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    // Build image parts if they exist
    const imageParts =
      params.imageFileNames && params.imageFileNames.length > 0
        ? await buildOpenAIImageParts(params.imageFileNames)
        : []

    // Find the last user message index to add images only to that message
    const lastUserMessageIndex =
      messages
        .map((m, idx) => ({ message: m, index: idx }))
        .reverse()
        .find(({ message }) => message.role === "user")?.index ?? -1

    // Transform messages to include images only in the last user message
    const transformedMessages: any[] = messages.map((message, index) => {
      const role = message.role === "assistant" ? "assistant" : "user"

      if (
        index === lastUserMessageIndex &&
        imageParts.length > 0 &&
        role === "user"
      ) {
        // Combine image context instruction with user's message text
        const userText = message.content![0].text!
        const combinedText =
          "You may receive image(s) as part of the conversation. If images are attached, treat them as essential context for the user's question.\n\n" +
          userText

        return {
          role: "user" as const,
          content: [
            { type: "text" as const, text: combinedText },
            ...imageParts,
          ],
        }
      }
      return {
        role,
        content: message.content![0].text!,
      }
    })
    const chatCompletion = await (
      this.client as OpenAI
    ).chat.completions.create({
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
      model: modelParams.modelId,
      stream: false,
      max_tokens: modelParams.maxTokens,
      temperature: modelParams.temperature,
      top_p: modelParams.topP,
      ...(modelParams.json ? { response_format: { type: "json_object" } } : {}),
    })
    const fullResponse = chatCompletion.choices[0].message?.content || ""
    const cost = calculateCost(
      {
        inputTokens: chatCompletion.usage?.prompt_tokens!,
        outputTokens: chatCompletion.usage?.completion_tokens!,
      },
      modelDetailsMap[modelParams.modelId].cost.onDemand,
    )
    return {
      text: fullResponse,
      cost,
    }
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    // Build image parts if they exist
    const imageParts =
      params.imageFileNames && params.imageFileNames.length > 0
        ? await buildOpenAIImageParts(params.imageFileNames)
        : []

    // Find the last user message index to add images only to that message
    const lastUserMessageIndex =
      messages
        .map((m, idx) => ({ message: m, index: idx }))
        .reverse()
        .find(({ message }) => message.role === "user")?.index ?? -1

    // Transform messages to include images only in the last user message
    const transformedMessages: any[] = messages.map((message, index) => {
      const role = message.role === "assistant" ? "assistant" : "user"

      if (
        index === lastUserMessageIndex &&
        imageParts.length > 0 &&
        role === "user"
      ) {
        // Combine image context instruction with user's message text
        const userText = message.content![0].text!
        const combinedText =
          "You may receive image(s) as part of the conversation. If images are attached, treat them as essential context for the user's question.\n\n" +
          userText

        return {
          role: "user" as const,
          content: [
            { type: "text" as const, text: combinedText },
            ...imageParts,
          ],
        }
      }
      return {
        role,
        content: message.content![0].text!,
      }
    })

    console.log("transformedMessages", transformedMessages)
    console.log("imageFileNames", params.imageFileNames)
    console.log("modelId", modelParams.modelId)

    const chatCompletion = await (
      this.client as OpenAI
    ).chat.completions.create({
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
      model: modelParams.modelId,
      stream: true,
      stream_options: { include_usage: true },
      temperature: modelParams.temperature,
      top_p: modelParams.topP,
    })

    let costYielded = false

    for await (const chunk of chatCompletion) {
      // Handle content chunks
      if (chunk.choices?.[0]?.delta?.content) {
        yield {
          text: chunk.choices[0].delta.content,
          metadata: chunk.choices[0].finish_reason ?? "",
          cost:
            !costYielded && chunk.usage
              ? calculateCost(
                  {
                    inputTokens: chunk.usage.prompt_tokens,
                    outputTokens: chunk.usage.completion_tokens,
                  },
                  modelDetailsMap[modelParams.modelId].cost.onDemand,
                )
              : undefined,
        }
      }
      // Handle completion token (finish_reason without content)
      else if (chunk.choices?.[0]?.finish_reason) {
        yield {
          text: "",
          metadata: chunk.choices[0].finish_reason,
        }
      }
      // Handle cost (if not yet yielded)
      else if (chunk.usage && !costYielded) {
        costYielded = true
        yield {
          text: "",
          metadata: "",
          cost: calculateCost(
            {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            },
            modelDetailsMap[modelParams.modelId].cost.onDemand,
          ),
        }
      }
    }
  }
}
