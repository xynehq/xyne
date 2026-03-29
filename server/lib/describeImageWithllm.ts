import OpenAI from "openai"
import { getLogger } from "@/logger"
import config from "@/config"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "describeImageUtil",
})

function createLiteLLMOpenAIClient(apiKey: string, baseURL: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL,
    dangerouslyAllowBrowser: true,
  })
}

const defaultVisionPrompt =
  "If the image contains a meaningful object, diagram, or visual content worth describing, provide only a concise and detailed description. Otherwise, if the image appears to be a logo, icon, background, watermark, or contains no significant content, respond exactly with: Image is not worth describing."

const extToMime: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpe": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
}

function mimeFromFileName(imageName: string): string {
  const lower = imageName.trim().toLowerCase()
  const dot = lower.lastIndexOf(".")
  if (dot === -1) return "image/png"
  const ext = lower.slice(dot)
  const mime = extToMime[ext]
  return mime || "image/png"
}

export function buildOpenAiImageDescribePayload(
  image: Buffer,
  modelId: string,
  imageName: string,
  prompt?: string,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const mime = mimeFromFileName(imageName)
  const base64 = image.toString("base64")
  const text = prompt ?? defaultVisionPrompt

  return {
    model: modelId,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text },
          {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${base64}` },
          },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 512,
    stream: false,
  }
}

export const describeImageWithllm = async (
  image: Buffer,
  imageName: string,
  prompt?: string,
): Promise<string> => {
  const baseURL = config.LiteLLMBaseUrl
  const modelId = config.defaultFastModel
  const apiKey = config.LiteLLMApiKey
  if (!baseURL || !modelId || !apiKey) {
    throw new Error("LiteLLM API endpoint, model ID, or API key is not set")
  }

  try {
    const client = createLiteLLMOpenAIClient(apiKey, baseURL)
    const params = buildOpenAiImageDescribePayload(image, modelId, imageName, prompt)

    Logger.debug("Sending image description via OpenAI client (LiteLLM baseURL)")
    const response = await client.chat.completions.create(params)

    const content = response.choices[0]?.message?.content
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("No message content in chat completions response")
    }

    const result = content.trim()
    Logger.debug(`LLM API response: ${result.substring(0, 100)}...`)
    return result
  } catch (err) {
    Logger.error(err, "Error calling LLM API for image description")
    return "No description returned."
  }
}
