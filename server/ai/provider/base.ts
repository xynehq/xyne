import { type Message } from "@aws-sdk/client-bedrock-runtime"
import type { ConverseResponse, LLMProvider, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import config from "@/config"

const { defaultFastModel } = config
abstract class Provider implements LLMProvider {
  client: any
  providerType: AIProviders

  constructor(client: any, providerType: AIProviders) {
    this.client = client
    this.providerType = providerType
  }

  getModelParams(params: ModelParams) {
    return {
      maxTokens: params.max_new_tokens || (1024*5),
      topP: params.top_p || 0.9,
      temperature: params.temperature || 0.6,
      modelId: params.modelId || defaultFastModel,
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

export default Provider
