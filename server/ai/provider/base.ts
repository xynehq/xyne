import { type Message } from "@aws-sdk/client-bedrock-runtime"
import type { ConverseResponse, LLMProvider, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import { MODEL_CONFIGURATIONS } from "@/ai/modelConfig"
import config from "@/config"
import path from "path"
import fs from "fs"

const { defaultFastModel } = config
abstract class Provider implements LLMProvider {
  client: any
  providerType: AIProviders

  constructor(client: any, providerType: AIProviders) {
    this.client = client
    this.providerType = providerType
  }

  getModelParams(params: ModelParams) {
    // Look up the actual model name from MODEL_CONFIGURATIONS
    // This resolves enum values like "vertex-claude-sonnet-4" to actual API model names like "claude-sonnet-4@20250514"
    const modelConfig = MODEL_CONFIGURATIONS[params.modelId || defaultFastModel]
    const actualModelId = modelConfig?.actualName || params.modelId || defaultFastModel
    return {
      maxTokens: params.max_new_tokens || 1024 * 8,
      topP: params.top_p || 0.9,
      temperature: params.temperature || 0.6,
      modelId: actualModelId || defaultFastModel,
      systemPrompt: params.systemPrompt || "You are a helpful assistant.",
      userCtx: params.userCtx,
      stream: params.stream,
      json: params.json || null,
    }
  }

  abstract converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse>

  abstract converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse>
}

//  format: docIndex_docId_imageNumber
export const regex = /^([0-9]+)_(.+)_([0-9]+)$/

export function findImageByName(directory: string, imageName: string) {
  const files = fs.readdirSync(directory)
  const match = files.find((file) => path.parse(file).name === imageName)
  if (!match) {
    throw new Error(`Image "${imageName}" not found`)
  }
  return path.join(directory, match)
}

export default Provider
