import fs from "fs"
import path from "path"
import { getModelConfiguration } from "@/ai/modelConfig"
import type { ConverseResponse, LLMProvider, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import config from "@/config"
import { type Message } from "@aws-sdk/client-bedrock-runtime"

const { defaultFastModel } = config
abstract class Provider implements LLMProvider {
  client: any
  providerType: AIProviders

  constructor(client: any, providerType: AIProviders) {
    this.client = client
    this.providerType = providerType
  }

  getModelParams(params: ModelParams) {
    // Look up the provider-facing model name from the merged model catalog.
    // This resolves enum values like "vertex-claude-sonnet-4" to actual API model names like "claude-sonnet-4@20250514"
    const modelConfig = getModelConfiguration(
      params.modelId || defaultFastModel,
    )
    const actualModelId =
      modelConfig?.actualName || params.modelId || defaultFastModel
    return {
      maxTokens: params.max_new_tokens || 1024 * 8,
      topP: params.top_p || 0.9,
      temperature: params.temperature || 0.6,
      modelId: actualModelId || defaultFastModel,
      systemPrompt: params.systemPrompt || "You are a helpful assistant.",
      userCtx: params.userCtx,
      stream: params.stream,
      json: params.json || null,
      reasoning: params.reasoning || false,
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

const isPathInside = (basePath: string, targetPath: string): boolean => {
  const relativePath = path.relative(basePath, targetPath)
  return !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
}

export function findImageByName(directory: string, imageName: string) {
  if (
    path.isAbsolute(imageName) ||
    imageName.includes("..") ||
    imageName.includes("/") ||
    imageName.includes("\\")
  ) {
    throw new Error(`Invalid image name "${imageName}"`)
  }

  const resolvedDirectory = path.resolve(directory)
  const files = fs.readdirSync(resolvedDirectory)
  const match = files.find((file) => path.parse(file).name === imageName)
  if (!match) {
    throw new Error(`Image "${imageName}" not found`)
  }

  const resolvedPath = path.resolve(resolvedDirectory, match)
  if (!isPathInside(resolvedDirectory, resolvedPath)) {
    throw new Error(`Image "${imageName}" resolved outside image directory`)
  }

  const realDirectory = fs.realpathSync(resolvedDirectory)
  const realPath = fs.realpathSync(resolvedPath)
  if (!isPathInside(realDirectory, realPath)) {
    throw new Error(`Image "${imageName}" points outside image directory`)
  }

  return resolvedPath
}

export default Provider
