import {
  GoogleGenAI,
  type Content,
  type GenerateContentConfig,
  type ThinkingConfig,
} from "@google/genai"
import BaseProvider from "@/ai/provider/base"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import { type ModelParams, type ConverseResponse, AIProviders } from "../types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import path from "path"
import fs from "fs"
import { findImageByName } from "@/ai/provider/base"

const Logger = getLogger(Subsystem.AI)

async function buildGeminiImageParts(
  imagePaths: string[],
): Promise<{ inlineData: { mimeType: string; data: string } }[]> {
  const baseDir = path.resolve(
    process.env.IMAGE_DIR || "downloads/xyne_images_db",
  )

  const imagePromises = imagePaths.map(async (imgPath) => {
    // Check if the file already has an extension, if not add .png
    const match = imgPath.match(/^([0-9]+)_(.+)_([0-9]+)$/)
    if (!match) {
      Logger.error(`Invalid image path: ${imgPath}`)
      throw new Error(`Invalid image path: ${imgPath}`)
    }

    // Validate that the docId doesn't contain path traversal characters
    const docId = match[2]
    const imageNumber = match[3]
    if (docId.includes("..") || docId.includes("/") || docId.includes("\\")) {
      Logger.error(`Invalid docId containing path traversal: ${docId}`)
      throw new Error(`Invalid docId: ${docId}`)
    }

    const imageDir = path.join(baseDir, docId)
    const absolutePath = findImageByName(imageDir, imageNumber)
    const extension = path.extname(absolutePath).toLowerCase()

    // Map file extensions to MIME types for Gemini
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

      // Check file size (4MB limit for Gemini)
      if (imageBytes.length > 4 * 1024 * 1024) {
        Logger.warn(
          `Image buffer too large after read (${imageBytes.length} bytes, ${(imageBytes.length / (1024 * 1024)).toFixed(2)}MB): ${absolutePath}. Skipping this image.`,
        )
        return null
      }

      const base64Data = imageBytes.toString("base64")

      return {
        inlineData: {
          mimeType: mimeType,
          data: base64Data,
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
  return results.filter(
    (result): result is { inlineData: { mimeType: string; data: string } } =>
      result !== null,
  ) // Remove any null entries
}

export class GeminiAIProvider extends BaseProvider {
  constructor(client: GoogleGenAI) {
    super(client, AIProviders.GoogleAI)
  }
  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    try {
      const ai = this.client as GoogleGenAI

      // 1. Build any image parts (no change)
      const imageParts = params.imageFileNames?.length
        ? await buildGeminiImageParts(params.imageFileNames)
        : []

      // 2. Rehydrate your prior turns into the SDK's Content[] shape
      const history = messages.map((v) => ({
        role: v.role === "assistant" ? "model" : ("user" as const),
        parts: [{ text: v.content?.[0]?.text || "" }],
      }))

      // 3. Create a chat session, enabling thinking and seeding system + history :contentReference[oaicite:0]{index=0}
      const chat = ai.chats.create({
        model: modelParams.modelId,
        history,
        config: {
          maxOutputTokens: modelParams.maxTokens,
          temperature: modelParams.temperature,
          responseMimeType: "application/json",
          thinkingConfig: {
            includeThoughts: params.reasoning,
            thinkingBudget: params.reasoning ? -1 : 0, // dynamic chain-of-thought enabled :contentReference[oaicite:1]{index=1}
          } satisfies ThinkingConfig,
          systemInstruction: {
            role: "system",
            parts: [
              {
                text:
                  modelParams.systemPrompt +
                  "\n\n" +
                  "Important: In case you don't have the context, you can use the images in the context to answer questions.",
              },
            ],
          },
        } satisfies GenerateContentConfig,
      })

      // 4. Package your latest user turn + images
      const latestText = messages[messages.length - 1]?.content?.[0]?.text || ""
      const messageParts = [
        {
          text:
            "You may receive image(s) as part of the conversation. If images are attached, treat them as essential context for the user's question.\n\n" +
            latestText,
        },
        ...imageParts,
      ]

      // 5. Send a single, non-streaming request
      const response = await chat.sendMessage({ message: messageParts })

      // 6. Extract the generated text and token usage
      const text = response.text
      const cost = 0

      return { text, cost }
    } catch (error) {
      Logger.error("Converse Error:", error)
      throw new Error(`Failed to get response from GenAI: ${error}`)
    }
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    try {
      const ai = this.client as GoogleGenAI

      // 1. Prepare any image parts (unchanged)
      const imageParts = params.imageFileNames?.length
        ? await buildGeminiImageParts(params.imageFileNames)
        : []

      // 2. Map your prior turns into the SDK's Content[] shape
      const history = messages.map((v) => ({
        role: v.role === "assistant" ? "model" : ("user" as const),
        parts: [{ text: v.content?.[0]?.text || "" }],
      }))

      // 3. Create a chat session, with default config + system instruction + thinking enabled
      const chat = ai.chats.create({
        model: modelParams.modelId,
        history,
        config: {
          maxOutputTokens: modelParams.maxTokens,
          temperature: modelParams.temperature,
          responseMimeType: "application/json",
          thinkingConfig: {
            includeThoughts: params.reasoning,
            thinkingBudget: params.reasoning ? -1 : 0, // enable automatic chain-of-thought reasoning
          } satisfies ThinkingConfig,
          systemInstruction: {
            role: "system",
            parts: [
              {
                text:
                  modelParams.systemPrompt +
                  "\n\n" +
                  "Important: In case you don't have the context, you can use the images in the context to answer questions.",
              },
            ],
          },
        } satisfies GenerateContentConfig,
      })

      // 4. Pull in the latest user message + any image parts
      const latestText = messages[messages.length - 1]?.content?.[0]?.text || ""
      const parts = [
        {
          text:
            "You may receive image(s) as part of the conversation. If images are attached, treat them as essential context for the user's question.\n\n" +
            latestText,
        },
        ...imageParts,
      ]

      // 5. Stream back chunks from Gemini
      const stream = await chat.sendMessageStream({ message: parts })

      let isThinkingStarted = false
      let wasThinkingInPreviousChunk = false

      for await (const chunk of stream) {
        let chunkText = ""

        // Check if this chunk contains thinking content
        const thinkingPart = chunk.candidates?.[0]?.content?.parts?.find(
          (part) => part.thought === true,
        )

        if (thinkingPart?.text) {
          // Start thinking tag only for the first thinking chunk
          if (!isThinkingStarted) {
            chunkText += "<think>"
            isThinkingStarted = true
          }

          chunkText += thinkingPart.text
          wasThinkingInPreviousChunk = true
        } else {
          // Close thinking tag if we were thinking in the previous chunk but not now
          if (wasThinkingInPreviousChunk) {
            chunkText += "</think>"
            wasThinkingInPreviousChunk = false
          }
        }

        if (chunk.text) {
          chunkText += chunk.text
        }

        // Only yield if there's actual content
        if (chunkText) {
          yield {
            text: chunkText,
            cost: 0,
          }
        }
      }
    } catch (error) {
      Logger.error("Streaming Error:", error)
      throw new Error(`Failed to get response from GenAI: ${error}`)
    }
  }
}
