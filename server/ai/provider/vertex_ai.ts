// VertexAIProvider.ts

import fs from "fs"
import path from "path"
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"
import { VertexAI, type Tool } from "@google-cloud/vertexai"
import { getLogger } from "@/logger"
import { getErrorMessage } from "@/utils"
import { type Message } from "@aws-sdk/client-bedrock-runtime"
import {
  AIProviders,
  Models,
  type ConverseResponse,
  type ModelParams,
  type WebSearchSource,
} from "@/ai/types"
import BaseProvider, { findImageByName, regex } from "@/ai/provider/base"
import { Subsystem } from "@/types"
import config from "@/config"
import { createLabeledImageContent } from "../utils"
import { calculateCost } from "@/utils/index"
import { modelDetailsMap } from "../mappers"


const { MAX_IMAGE_SIZE_BYTES } = config

const Logger = getLogger(Subsystem.AI)

function stringifyToolResultContent(parts: any[] | undefined): string {
  if (!parts) return ""
  const out: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== "object") continue
    if ("text" in part && typeof part.text === "string") {
      out.push(part.text)
    } else if ("json" in part && part.json !== undefined) {
      try {
        out.push(JSON.stringify(part.json))
      } catch {
        out.push(String(part.json))
      }
    }
  }
  return out.join("\n")
}

function extractTextFromContentBlocks(
  blocks: Message["content"] | undefined,
): string {
  if (!blocks) return ""
  const lines: string[] = []
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue
    }
    if ("text" in block && typeof block.text === "string") {
      lines.push(block.text)
    } else if ("toolResult" in block && block.toolResult) {
      const status = block.toolResult.status ?? "executed"
      const summary = stringifyToolResultContent(block.toolResult.content)
      const toolUseId = block.toolResult.toolUseId || "tool"
      lines.push(
        `Tool result (${toolUseId}, status=${status}): ${summary}`.trim(),
      )
    }
  }
  const joined = lines.join("\n")
  return ensureNonEmptyText(joined)
}

function stringifyUnknown(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeAnthropicMessages(messages: Message[]): Message[] {
  return messages.map((message) => {
    const normalizedContent = (message.content ?? []).map((part: any) => {
      if (part && typeof part === "object") {
        if ("type" in part) {
          return part
        }
        if ("text" in part) {
          return { type: "text", text: ensureNonEmptyText(part.text ?? "") }
        }
      } else if (typeof part === "string") {
        return { type: "text", text: ensureNonEmptyText(part) }
      }
      return { type: "text", text: ensureNonEmptyText(stringifyUnknown(part)) }
    })
    return {
      ...message,
      content: normalizedContent.length
        ? (normalizedContent as any)
        : [{ type: "text", text: "[no content]" }],
    }
  })
}

function ensureNonEmptyText(text: string): string {
  return text && text.trim().length > 0 ? text : "[no content]"
}

export enum VertexProvider {
  ANTHROPIC = "anthropic",
  GOOGLE = "google",
}

const buildVertexAIImageParts = async (imagePaths: string[]) => {
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
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
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
      await fs.promises.access(absolutePath, fs.constants.F_OK)
      const imgBuffer = await fs.promises.readFile(absolutePath)
      if (imgBuffer.length > MAX_IMAGE_SIZE_BYTES) return null
      const base64 = imgBuffer.toString("base64")
      return {
        type: "image",
        source: { type: "base64", media_type: format, data: base64 },
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
        timeout: parseInt(process.env.VERTEX_AI_TIMEOUT || "240000"), // Default 4 minutes timeout
        maxRetries: 3,
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
    const normalizedMessages = normalizeAnthropicMessages(
      transformedMessages as Message[],
    )

    try {
      Logger.info(`Starting VertexAI Anthropic request with model: ${modelId}`)
      const client = this.client as AnthropicVertex
      const response = await client.beta.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: normalizedMessages as any,
        tools:
          params.tools && params.tools.length
            ? params.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters || {
                  type: "object",
                  properties: {},
                },
              }))
            : undefined,
      })

      const text = response.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("")
      const toolCalls = response.content
        .filter((c: any) => c.type === "tool_use")
        .map((c: any) => ({
          id: c.id || "",
          type: "function" as const,
          function: {
            name: c.name || "",
            arguments: c.input ? JSON.stringify(c.input) : "{}",
          },
        }))
      const usage = response.usage || { input_tokens: 0, output_tokens: 0 }
      const cost =
        (usage.input_tokens > 0 || usage.output_tokens > 0) && modelId
          ? calculateCost(
              {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
              },
              modelDetailsMap[modelId].cost.onDemand,
            )
          : 0

      return {
        text,
        cost,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      }
    } catch (error) {
      Logger.error(`VertexAI Anthropic request failed:`, error)
      if (error instanceof Error && error.message?.includes("timeout")) {
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
    const normalizedMessages = normalizeAnthropicMessages(
      transformedMessages as Message[],
    )

    const client = this.client as AnthropicVertex
    const stream = await client.beta.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: normalizedMessages as any,
      stream: true,
      tools:
        params.tools && params.tools.length
          ? params.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters || { type: "object", properties: {} },
            }))
          : undefined,
    })

    let totalInputTokens = 0
    let totalOutputTokens = 0
    let accumulatedText = ""
    let costYielded = false

    // Track current tool_use block
    let currentTool: { id: string; name: string; args: string } | null = null
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
        chunk?.type === "content_block_start" &&
        (chunk as any).content_block?.type === "tool_use"
      ) {
        const tb: any = (chunk as any).content_block
        currentTool = { id: tb?.id || "", name: tb?.name || "", args: "" }
      } else if (
        chunk?.type === "content_block_delta" &&
        chunk.delta?.type === "text_delta"
      ) {
        yield { text: chunk.delta.text }
        accumulatedText += chunk.delta.text
      } else if (
        chunk?.type === "content_block_delta" &&
        (chunk as any).delta?.type === "input_json_delta" &&
        currentTool
      ) {
        const d: any = (chunk as any).delta
        if (typeof d.partial_json === "string") {
          currentTool.args += d.partial_json
        }
      } else if (chunk?.type === "content_block_stop" && currentTool) {
        // Flush tool call
        const toolCalls = [
          {
            id: currentTool.id,
            type: "function" as const,
            function: {
              name: currentTool.name,
              arguments: currentTool.args || "{}",
            },
          },
        ]
        yield { tool_calls: toolCalls }
        currentTool = null
      } else if (chunk?.type === "message_stop" && !costYielded) {
        const usage = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        }

        const cost =
          (usage.inputTokens > 0 || usage.outputTokens > 0) && modelId
            ? calculateCost(
                {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                },
                modelDetailsMap[modelId].cost.onDemand,
              )
            : 0

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
        parts: [{ text: extractTextFromContentBlocks(v.content) }],
      }))

      const tools: any[] = []

      if (params.webSearch) {
        tools.push({
          googleSearch: {},
        })
      }

      const client = this.client as VertexAI
      const model = client.getGenerativeModel({
        model: modelId,
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
        const text = extractTextFromContentBlocks(allBlocks)
        messageParts = [{ text }]
      }

      const response = await chat.sendMessage(messageParts)

      // Extract text from response
      const candidates = response.response.candidates || []
      const textParts = candidates[0]?.content?.parts || []
      const text = textParts
        .filter((part: any) => part.text)
        .map((part: any) => part.text)
        .join("")
      const usageMetadata = response.response.usageMetadata || {}
      const inputTokens = usageMetadata.promptTokenCount || 0
      const outputTokens = usageMetadata.candidatesTokenCount || 0

      const cost =
        (inputTokens > 0 || outputTokens > 0) && modelId
          ? calculateCost(
              {
                inputTokens,
                outputTokens,
              },
              modelDetailsMap[modelId].cost.onDemand,
            )
          : 0

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
    let aggregatedText = ""
    const aggregatedSources: WebSearchSource[] = []
    const aggregatedGroundingSupports: any[] = []

    try {
      const client = this.client as VertexAI

      const imageParts = params.imageFileNames?.length
        ? await buildVertexAIImageParts(params.imageFileNames)
        : []

      const history = messages.map((v) => ({
        role: v.role === "assistant" ? "model" : "user",
        parts: [{ text: extractTextFromContentBlocks(v.content) }],
      }))

      const tools: any[] = []
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

      let messageParts: any
      if (lastMessage?.role === "user" && imageParts.length > 0) {
        const textBlocks = allBlocks.filter((c) => "text" in c)
        const otherBlocks = allBlocks.filter((c) => !("text" in c))
        const latestText = textBlocks.map((tb: any) => tb.text).join("\n")

        messageParts = createLabeledImageContent(
          latestText,
          otherBlocks,
          imageParts,
          params.imageFileNames || [],
        )
      } else {
        const text = extractTextFromContentBlocks(allBlocks)
        messageParts = [{ text }]
      }

      const result = await chat.sendMessageStream(messageParts)

      for await (const chunk of result.stream) {
        let chunkText = ""
        const groundingMetadata = chunk.candidates?.[0]?.groundingMetadata
        if (groundingMetadata?.groundingChunks) {
          const chunkSources = groundingMetadata.groundingChunks
            .filter((chunk: any) => chunk.web)
            .map((chunk: any) => ({
              uri: chunk.web.uri,
              title: chunk.web.title,
              searchQuery: groundingMetadata.webSearchQueries?.[0] || undefined,
            }))

          chunkSources.forEach((source: WebSearchSource) => {
            if (
              !aggregatedSources.some((existing) => existing.uri === source.uri)
            ) {
              aggregatedSources.push(source)
            }
          })
        }

        if (groundingMetadata?.groundingSupports) {
          const chunkSupports = groundingMetadata.groundingSupports
            .filter((support: any) => support.segment)
            .map((support: any) => ({
              segment: {
                startIndex: support.segment.startIndex || 0,
                endIndex: support.segment.endIndex || 0,
                text: support.segment.text || "",
              },
              groundingChunkIndices: support.groundingChunkIndices || [],
            }))

          aggregatedGroundingSupports.push(...chunkSupports)
        }

        if (chunk.candidates?.[0]?.content?.parts) {
          const textParts = chunk.candidates[0].content.parts
            .filter((part: any) => part.text)
            .map((part: any) => part.text)
          chunkText += textParts.join("")
        }
        let totalInputTokens = 0
        let totalOutputTokens = 0
        const usageMetadata = chunk.usageMetadata
        if (usageMetadata) {
          totalInputTokens = usageMetadata.promptTokenCount || 0
          totalOutputTokens = usageMetadata.candidatesTokenCount || 0
        }

        if (chunkText) {
          const cost =
            (totalInputTokens > 0 || totalOutputTokens > 0) && modelParams.modelId
              ? calculateCost(
                  {
                    inputTokens: totalInputTokens,
                    outputTokens: totalOutputTokens,
                  },
                  modelDetailsMap[modelParams.modelId].cost.onDemand,
                )
              : 0

          aggregatedText += chunkText
          yield {
            text: chunkText,
            cost,
            sources:
              aggregatedSources.length > 0 ? aggregatedSources : undefined,
            groundingSupports:
              aggregatedGroundingSupports.length > 0
                ? aggregatedGroundingSupports
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
        const userText = msg.content?.[0]?.text ?? ""
        const newContent = [
          {
            type: "text",
            text:
              "You may receive image(s) as part of the conversation. If images are attached, treat them as essential context for the user's question." +
              "\n\n" +
              userText,
          },
          ...imageParts,
        ].map((block) => {
          if (
            block &&
            typeof block === "object" &&
            "text" in block &&
            !("type" in block)
          ) {
            return { type: "text", text: (block as any).text }
          }
          return block
        })

        return {
          role: msg.role,
          content: newContent,
        }
      }
      return msg
    })
  }
}
