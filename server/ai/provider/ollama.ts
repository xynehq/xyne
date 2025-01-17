import { type Message } from "@aws-sdk/client-bedrock-runtime"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import BaseProvider from "@/ai/provider/base"
import type { Ollama } from "ollama"

export class OllamaProvider extends BaseProvider {
  constructor(client: Ollama) {
    super(client, AIProviders.Ollama)
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    // Placeholder for Ollama implementation
    throw new Error("Ollama provider is not implemented yet.")
  }
  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    // Placeholder for Ollama implementation
    throw new Error("Ollama provider is not implemented yet.")
  }
}
