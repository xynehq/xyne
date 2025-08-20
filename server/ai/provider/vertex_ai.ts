// VertexAIProvider.ts

import fs from "fs"
import path from "path"
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"
import { getLogger } from "@/logger"
import { type Message } from "@aws-sdk/client-bedrock-runtime"
import {
  AIProviders,
  type ConverseResponse,
  type ModelParams,
} from "@/ai/types"
import BaseProvider, { findImageByName } from "@/ai/provider/base"
import { Subsystem } from "@/types"
import config from "@/config"

const { MAX_IMAGE_SIZE_BYTES } = config

const Logger = getLogger(Subsystem.AI)

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
  client: AnthropicVertex

  constructor({ projectId, region }: { projectId: string; region: string }) {
    const client = new AnthropicVertex({ projectId, region })
    super(client, AIProviders.VertexAI)
    this.client = client
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const { modelId, systemPrompt, maxTokens, temperature } =
      this.getModelParams(params)
    const imageParts = params.imageFileNames?.length
      ? await buildVertexAIImageParts(params.imageFileNames)
      : []
    const transformedMessages = this.injectImages(messages, imageParts)

    const response = await this.client.beta.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: transformedMessages,
    })

    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
    const usage = response.usage || { input_tokens: 0, output_tokens: 0 }
    const cost = 0

    return { text, cost }
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const { modelId, systemPrompt, maxTokens, temperature } =
      this.getModelParams(params)
    const imageParts = params.imageFileNames?.length
      ? await buildVertexAIImageParts(params.imageFileNames)
      : []
    const transformedMessages = this.injectImages(messages, imageParts)

    const stream = await this.client.beta.messages.create({
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