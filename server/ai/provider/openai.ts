import { type Message } from "@aws-sdk/client-bedrock-runtime"
import OpenAI from "openai"
import { modelDetailsMap } from "@/ai/mappers"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import BaseProvider from "@/ai/provider/base"
import { calculateCost } from "@/utils/index"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import fs from "fs"
import path from "path"
import os from "os"

const Logger = getLogger(Subsystem.AI)

// Helper function to convert images to OpenAI format
const buildOpenAIImageParts = (imagePaths: string[]) => {
  const imageDir = path.resolve(
    os.homedir(),
    process.env.IMAGE_DIR || "Downloads/xyne_images_db",
  )
  return imagePaths
    .map((imgPath) => {
      // Check if the file already has an extension, if not add .png
      const fileName = path.extname(imgPath) ? imgPath : `${imgPath}.png`
      const absolutePath = path.join(imageDir, fileName)

      try {
        // Check if file exists before trying to read it
        if (!fs.existsSync(absolutePath)) {
          Logger.error(`Image file does not exist: ${absolutePath}`)
          throw new Error(`Image file not found: ${absolutePath}`)
        }

        const base64Data = fs.readFileSync(absolutePath, { encoding: "base64" })

        return {
          type: "image_url" as const,
          image_url: {
            url: `data:image/png;base64,${base64Data}`,
          },
        }
      } catch (error) {
        Logger.error(
          `Failed to read image file ${absolutePath}: ${error instanceof Error ? error.message : error}`,
        )
        throw error
      }
    })
    .filter(Boolean) // Remove any null/undefined entries
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
    const chatCompletion = await (
      this.client as OpenAI
    ).chat.completions.create({
      messages: [
        {
          role: "system",
          content: modelParams.systemPrompt!,
        },
        ...messages.map((v) => ({
          // @ts-ignore
          content: v.content[0].text!,
          role: v.role!,
        })),
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
        ? buildOpenAIImageParts(params.imageFileNames)
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
        // Add images to the last user message
        return {
          role: "user" as const,
          content: [
            { type: "text" as const, text: message.content![0].text! },
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
          content: modelParams.systemPrompt!,
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