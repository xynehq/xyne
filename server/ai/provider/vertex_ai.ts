// VertexAIProvider.ts

import fs from "fs"
import path from "path"
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"
import { VertexAI, type Tool } from "@google-cloud/vertexai"
import { getLogger } from "@/logger"
import { type Message } from "@aws-sdk/client-bedrock-runtime"
import {
  AIProviders,
  type ConverseResponse,
  type ModelParams,
  type WebSearchSource,
} from "@/ai/types"
import BaseProvider, { findImageByName } from "@/ai/provider/base"
import { Subsystem } from "@/types"
import config from "@/config"
import { createLabeledImageContent } from "../utils"

const { MAX_IMAGE_SIZE_BYTES } = config

const Logger = getLogger(Subsystem.AI)

export enum VertexProvider {
  ANTHROPIC = "anthropic",
  GOOGLE = "google",
}

const buildVertexAIImageParts = async (imagePaths: string[]) => {
  const baseDir = path.resolve(
    process.env.IMAGE_DIR || "downloads/xyne_images_db",
  )

  const imagePromises = imagePaths.map(async (imgPath) => {
    const match = imgPath.match(/^(.+)_([0-9]+)$/)
    if (!match) throw new Error(`Invalid image path: ${imgPath}`)
    const docId = match[1]
    const imageDir = path.join(baseDir, docId)
    const absolutePath = findImageByName(imageDir, match[2])
    const ext = path.extname(absolutePath).toLowerCase()
    const mimeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
    }
    const mimeType = mimeMap[ext]
    if (!mimeType) return null

    try {
      await fs.promises.access(absolutePath, fs.constants.F_OK)
      const imgBuffer = await fs.promises.readFile(absolutePath)
      if (imgBuffer.length > MAX_IMAGE_SIZE_BYTES) return null
      const base64 = imgBuffer.toString("base64")
      return {
        type: "image",
        source: { type: "base64", media_type: mimeType, data: base64 },
      }
    } catch (err) {
      Logger.error(`Failed to read image: ${absolutePath}`)
      return null
    }
  })
  const results = await Promise.all(imagePromises)
  return results.filter(Boolean)
}
export class VertexAiProvider extends BaseProvider {
  client: AnthropicVertex | VertexAI
  provider: VertexProvider

  constructor({
    projectId,
    region,
    provider = VertexProvider.ANTHROPIC,
  }: {
    projectId: string
    region: string
    provider?: VertexProvider
  }) {
    let client: AnthropicVertex | VertexAI

    if (provider === VertexProvider.GOOGLE) {
      client = new VertexAI({ project: projectId, location: region })
    } else {
      client = new AnthropicVertex({ 
        projectId, 
        region,
        timeout: 4 * 60 * 1000, // 4 minutes timeout
        maxRetries: 3
      })
    }

    super(client, AIProviders.VertexAI)
    this.client = client
    this.provider = provider
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    if (this.provider === VertexProvider.GOOGLE) {
      return this.converseGoogle(messages, params)
    } else {
      return this.converseAnthropic(messages, params)
    }
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    if (this.provider === VertexProvider.GOOGLE) {
      yield* this.converseStreamGoogle(messages, params)
    } else {
      yield* this.converseStreamAnthropic(messages, params)
    }
  }

  private async converseAnthropic(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const { modelId, systemPrompt, maxTokens, temperature } =
      this.getModelParams(params)
    const imageParts = params.imageFileNames?.length
      ? await buildVertexAIImageParts(params.imageFileNames)
      : []
    const transformedMessages = this.injectImages(messages, imageParts)

    try {
      Logger.info(`Starting VertexAI Anthropic request with model: ${modelId}`)
      const client = this.client as AnthropicVertex
      const response = await client.beta.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: transformedMessages,
      })
      Logger.info(`VertexAI Anthropic request completed successfully`)

      const text = response.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("")
      const usage = response.usage || { input_tokens: 0, output_tokens: 0 }
      const cost = 0

      return { text, cost }
    } catch (error) {
      Logger.error(`VertexAI Anthropic request failed:`, error)
      if (error instanceof Error && error.message?.includes('timeout')) {
        throw new Error(`VertexAI request timed out after 4 minutes`)
      }
      throw error
    }
  }

  private async *converseStreamAnthropic(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const { modelId, systemPrompt, maxTokens, temperature } =
      this.getModelParams(params)
    const imageParts = params.imageFileNames?.length
      ? await buildVertexAIImageParts(params.imageFileNames)
      : []
    const transformedMessages = this.injectImages(messages, imageParts)

    const client = this.client as AnthropicVertex
    const stream = await client.beta.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: transformedMessages,
      stream: true,
    })

    let totalInputTokens = 0
    let totalOutputTokens = 0
    let accumulatedText = ""
    let costYielded = false

    for await (const chunk of stream) {
      if (chunk?.type === "message_start") {
        const usage = chunk.message.usage
        totalInputTokens = usage?.input_tokens || 0
        totalOutputTokens = usage?.output_tokens || 0
      } else if (
        chunk?.type === "content_block_start" &&
        chunk.content_block.type === "text"
      ) {
        yield { text: chunk.content_block.text }
        accumulatedText += chunk.content_block.text
      } else if (
        chunk?.type === "content_block_delta" &&
        chunk.delta?.type === "text_delta"
      ) {
        yield { text: chunk.delta.text }
        accumulatedText += chunk.delta.text
      } else if (chunk?.type === "message_stop" && !costYielded) {
        const usage = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        }
        const cost = 0 //TODO :  explitly set cost to 0 for now
        yield {
          text: "",
          cost,
          metadata: {
            model: modelId,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            responseTime: Date.now(),
          },
        }
        costYielded = true
      }
    }
  }

  private async converseGoogle(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const { modelId, systemPrompt, maxTokens, temperature } =
      this.getModelParams(params)

    try {
      const imageParts = params.imageFileNames?.length
        ? await buildVertexAIImageParts(params.imageFileNames)
        : []

      const history = messages.map((v) => ({
        role: v.role === "assistant" ? "model" : "user",
        parts: [{ text: v.content?.[0]?.text || "" }],
      }))

      const tools: any[] = []

      if (params.webSearch) {
        tools.push({
          googleSearch: {},
        })
      }

      const client = this.client as VertexAI
      const model = client.getGenerativeModel({
        model: params.modelId,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: temperature,
        },
        tools: tools.length > 0 ? tools : undefined,
        systemInstruction: {
          role: "system",
          parts: [
            {
              text:
                systemPrompt +
                "\n\n" +
                "Important: In case you don't have the context, you can use the images in the context to answer questions." +
                (params.webSearch
                  ? "\n\nYou have access to web search for up-to-date information when needed."
                  : ""),
            },
          ],
        },
      })

      const chat = model.startChat({ history })

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
        messageParts = allBlocks.map((block) => ({ text: block.text }))
      }

      const response = await chat.sendMessage(messageParts)

      // Extract text from response
      const candidates = response.response.candidates || []
      const textParts = candidates[0]?.content?.parts || []
      const text = textParts
        .filter((part: any) => part.text)
        .map((part: any) => part.text)
        .join("")

      const cost = 0

      let sources: WebSearchSource[] = []
      const groundingMetadata =
        response.response.candidates?.[0]?.groundingMetadata
      if (groundingMetadata?.groundingChunks) {
        sources = groundingMetadata.groundingChunks
          .filter((chunk: any) => chunk.web) // Only include web sources
          .map((chunk: any) => ({
            uri: chunk.web.uri,
            title: chunk.web.title,
            searchQuery: groundingMetadata.webSearchQueries?.[0] || undefined,
          }))
      }

      return { text, cost, sources }
    } catch (error) {
      Logger.error("Vertex AI Converse Error:", error)
      throw new Error(`Failed to get response from Vertex AI: ${error}`)
    }
  }

  private async *converseStreamGoogle(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    try {
      const client = this.client as VertexAI

      const imageParts = params.imageFileNames?.length
        ? await buildVertexAIImageParts(params.imageFileNames)
        : []

      const history = messages.map((v) => ({
        role: v.role === "assistant" ? "model" : "user",
        parts: [{ text: v.content?.[0]?.text || "" }],
      }))

      const tools: any[] = []

      // web search grounding
      if (params.webSearch) {
        tools.push({
          googleSearch: {},
        })
      }

      const model = client.getGenerativeModel({
        model: modelParams.modelId,
        generationConfig: {
          maxOutputTokens: modelParams.maxTokens,
          temperature: modelParams.temperature,
        },
        tools: tools.length > 0 ? tools : undefined,
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
      })

      const chat = model.startChat({ history })

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
        messageParts = allBlocks.map((block) => ({ text: block.text }))
      }

      const result = await chat.sendMessageStream(messageParts)

      let accumulatedSources: any[] = []
      let accumulatedGroundingSupports: any[] = []

      for await (const chunk of result.stream) {
        let chunkText = ""
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
          chunkSources.forEach((source: any) => {
            if (
              !accumulatedSources.some(
                (existing) => existing.uri === source.uri,
              )
            ) {
              accumulatedSources.push(source)
            }
          })
        }

        // Extract grounding supports with proper type checking
        if (groundingMetadata?.groundingSupports) {
          const chunkGroundingSupports = groundingMetadata.groundingSupports
            .filter((support: any) => support.segment) // Only include supports with segments
            .map((support: any) => ({
              segment: {
                startIndex: support.segment.startIndex || 0,
                endIndex: support.segment.endIndex || 0,
                text: support.segment.text || "",
              },
              groundingChunkIndices: support.groundingChunkIndices || [],
            }))

          accumulatedGroundingSupports.push(...chunkGroundingSupports)
        }

        if (chunk.candidates?.[0]?.content?.parts) {
          const textParts = chunk.candidates[0].content.parts
            .filter((part: any) => part.text)
            .map((part: any) => part.text)
          chunkText += textParts.join("")
        }

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
      throw new Error(`Failed to get response from Vertex AI: ${error}`)
    }
  }

  private injectImages(messages: any[], imageParts: any[]): any[] {
    const lastUserIndex = [...messages]
      .reverse()
      .findIndex((m) => m.role === "user")
    const actualIndex =
      lastUserIndex >= 0 ? messages.length - 1 - lastUserIndex : -1

    return messages.map((msg, i) => {
      if (i === actualIndex && imageParts.length) {
        const userText = msg.content?.[0]?.text
        return {
          role: msg.role,
          content: [
            {
              type: "text",
              text: `You may receive image(s)as part of the conversation. If images are attached, treat them as essential context for the user's question.\n\n"
              ${userText}`,
            },
            ...imageParts,
          ],
        }
      }
      return {
        role: msg.role,
        content: [{ type: "text", text: msg.content[0]?.text }],
      }
    })
  }
}
