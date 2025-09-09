import {
  GoogleGenAI,
  type Content,
  type GenerateContentConfig,
  type ThinkingConfig,
} from "@google/genai"
import BaseProvider, { regex } from "@/ai/provider/base"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import {
  type ModelParams,
  type ConverseResponse,
  AIProviders,
  type WebSearchSource,
  type GroundingSupport,
} from "../types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import path from "path"
import fs from "fs"
import { findImageByName } from "@/ai/provider/base"
import { createLabeledImageContent } from "../utils"

const Logger = getLogger(Subsystem.AI)

async function buildGeminiImageParts(
  imagePaths: string[],
): Promise<{ inlineData: { mimeType: string; data: string } }[]> {
  const baseDir = path.resolve(
    process.env.IMAGE_DIR || "downloads/xyne_images_db",
  )

  const imagePromises = imagePaths.map(async (imgPath) => {
    // Check if the file already has an extension, if not add .png
    const match = imgPath.match(regex)
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

      const imageParts = params.imageFileNames?.length
        ? await buildGeminiImageParts(params.imageFileNames)
        : []

      const history = messages.map((v) => ({
        role: v.role === "assistant" ? "model" : "user",
        parts: [{ text: v.content?.[0]?.text || "" }],
      }))

      const tools = []
      if (params.webSearch) {
        tools.push({
          googleSearch: {},
        })
      }

      const chat = ai.chats.create({
        model: modelParams.modelId,
        history,
        config: {
          maxOutputTokens: modelParams.maxTokens,
          temperature: modelParams.temperature,
          // Add tools configuration for web search
          tools: tools.length > 0 ? tools : undefined,
          thinkingConfig: {
            includeThoughts: params.reasoning,
            thinkingBudget: params.reasoning ? -1 : 0,
          } satisfies ThinkingConfig,
          systemInstruction: {
            role: "system",
            parts: [
              {
                text:
                  modelParams.systemPrompt +
                  "\n\n" +
                  "Important: In case you don't have the context, you can use the images in the context to answer questions." +
                  (params.webSearch
                    ? "\n\nYou have access to web search for up-to-date information when needed."
                    : ""),
              },
            ],
          },
          // Tool calling support: function declarations
          ...(params.tools && params.tools.length
            ? {
                tools: [
                  {
                    functionDeclarations: params.tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      parameters: t.parameters || { type: 'object', properties: {} },
                    })),
                  },
                ],
              }
            : {}),
        } as any,
      })

      const lastMessage = messages[messages.length - 1]
      const allBlocks = lastMessage?.content || []

      let messageParts
      if (lastMessage?.role == "user" && imageParts.length > 0) {
        // only build labeled image content when we actually have images
        const textBlocks = allBlocks.filter((c) => "text" in c)
        const otherBlocks = allBlocks.filter((c) => !("text" in c))
        const latestText = textBlocks.map((tb) => tb.text).join("\n")

        messageParts = createLabeledImageContent(
          latestText,
          otherBlocks,
          imageParts,
          params.imageFileNames || [],
        )
      } else {
        // otherwise just pass along the raw blocks
        messageParts = allBlocks
      }

      const response = await chat.sendMessage({ message: messageParts })

      const text = response.text
      const cost = 0

      let sources: WebSearchSource[] = []
      let groundingSupports: GroundingSupport[] = []
      const groundingMetadata = response.candidates?.[0]?.groundingMetadata
      if (groundingMetadata?.groundingChunks) {
        sources = groundingMetadata.groundingChunks
          .filter((chunk: any) => chunk.web) // Only include web sources
          .map((chunk: any) => ({
            uri: chunk.web.uri,
            title: chunk.web.title,
            searchQuery: groundingMetadata.webSearchQueries?.[0] || undefined,
          }))
      }

      // Extract grounding supports
      if (groundingMetadata?.groundingSupports) {
        groundingSupports = groundingMetadata.groundingSupports.map(
          (support: any) => ({
            segment: {
              startIndex: support.segment.startIndex,
              endIndex: support.segment.endIndex,
              text: support.segment.text,
            },
            groundingChunkIndices: support.groundingChunkIndices || [],
          }),
        )
      }

      return { text, cost, sources, groundingSupports }
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

      const imageParts = params.imageFileNames?.length
        ? await buildGeminiImageParts(params.imageFileNames)
        : []

      const history = messages.map((v) => ({
        role: v.role === "assistant" ? "model" : "user",
        parts: [{ text: v.content?.[0]?.text || "" }],
      }))

      const tools = []
      if (params.webSearch) {
        tools.push({
          googleSearch: {},
        })
      }

      const chat = ai.chats.create({
        model: modelParams.modelId,
        history,
        config: {
          maxOutputTokens: modelParams.maxTokens,
          temperature: modelParams.temperature,
          tools: tools.length > 0 ? tools : undefined,
          thinkingConfig: {
            includeThoughts: params.reasoning,
            thinkingBudget: params.reasoning ? -1 : 0,
          } satisfies ThinkingConfig,
          systemInstruction: {
            role: "system",
            parts: [
              {
                text:
                  modelParams.systemPrompt +
                  "\n\n" +
                  "Important: In case you don't have the context, you can use the images in the context to answer questions." +
                  (params.webSearch
                    ? "\n\nYou have access to web search for up-to-date information when needed."
                    : ""),
              },
            ],
          },
          ...(params.tools && params.tools.length
            ? {
                tools: [
                  {
                    functionDeclarations: params.tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      parameters: t.parameters || { type: 'object', properties: {} },
                    })),
                  },
                ],
              }
            : {}),
        } as any,
      })

      const lastMessage = messages[messages.length - 1]
      const allBlocks = lastMessage?.content || []

      let messageParts
      if (lastMessage?.role == "user" && imageParts.length > 0) {
        // only build labeled image content when we actually have images
        const textBlocks = allBlocks.filter((c) => "text" in c)
        const otherBlocks = allBlocks.filter((c) => !("text" in c))
        const latestText = textBlocks.map((tb) => tb.text).join("\n")

        messageParts = createLabeledImageContent(
          latestText,
          otherBlocks,
          imageParts,
          params.imageFileNames || [],
        )
      } else {
        // otherwise just pass along the raw blocks
        messageParts = allBlocks
      }

      const stream = await chat.sendMessageStream({ message: messageParts })

      let isThinkingStarted = false
      let wasThinkingInPreviousChunk = false
      let accumulatedSources: any[] = []
      let accumulatedGroundingSupports: GroundingSupport[] = []

      // Accumulate function call (best-effort)
      let pendingFn: { name: string; args: string } | null = null
      for await (const chunk of stream) {
        let chunkText = ""
        // Extract sources from grounding metadata if available
        const groundingMetadata = chunk.candidates?.[0]?.groundingMetadata
        if (groundingMetadata?.groundingChunks) {
          const chunkSources = groundingMetadata.groundingChunks
            .filter((chunk: any) => chunk.web) // Only include web sources
            .map((chunk: any) => ({
              uri: chunk.web.uri,
              title: chunk.web.title,
              searchQuery: groundingMetadata.webSearchQueries?.[0] || undefined,
            }))

          // Merge sources (avoid duplicates based on URI)
          chunkSources.forEach((source) => {
            if (
              !accumulatedSources.some(
                (existing) => existing.uri === source.uri,
              )
            ) {
              accumulatedSources.push(source)
            }
          })
        }

        // Extract grounding supports
        if (groundingMetadata?.groundingSupports) {
          const chunkGroundingSupports =
            groundingMetadata.groundingSupports.map((support: any) => ({
              segment: {
                startIndex: support.segment.startIndex,
                endIndex: support.segment.endIndex,
                text: support.segment.text,
              },
              groundingChunkIndices: support.groundingChunkIndices || [],
            }))

          accumulatedGroundingSupports.push(...chunkGroundingSupports)
        }

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

        // Detect function call in this chunk
        const fnPart = chunk.candidates?.[0]?.content?.parts?.find(
          (p: any) => p.functionCall,
        )
        if (fnPart?.functionCall) {
          const fc = fnPart.functionCall
          pendingFn = { name: fc.name || '', args: fc.args ? JSON.stringify(fc.args) : '{}' }
          yield {
            tool_calls: [
              {
                id: '',
                type: 'function' as const,
                function: { name: pendingFn.name, arguments: pendingFn.args },
              },
            ],
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
            sources:
              accumulatedSources.length > 0 ? accumulatedSources : undefined,
            groundingSupports:
              accumulatedGroundingSupports.length > 0
                ? accumulatedGroundingSupports
                : undefined,
          }
        }
      }
    } catch (error) {
      Logger.error("Streaming Error:", error)
      throw new Error(`Failed to get response from GenAI: ${error}`)
    }
  }
}
