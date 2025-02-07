import { type Message } from "@aws-sdk/client-bedrock-runtime"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import BaseProvider from "@/ai/provider/base"
import type { Ollama } from "ollama"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
const Logger = getLogger(Subsystem.AI)

export class OllamaProvider extends BaseProvider {
  constructor(client: Ollama) {
    super(client, AIProviders.Ollama)
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    try {
      const response = await (this.client as Ollama).chat({
        model: modelParams.modelId,
        messages: [
          {
            role: "system",
            content: modelParams.systemPrompt,
          },
          ...messages.map((v) => ({
            content: v.content ? v.content[0].text! : "",
            role: v.role! as "user" | "assistant",
          })),
        ],
        options: {
          temperature: modelParams.temperature,
          top_p: modelParams.topP,
          num_predict: modelParams.maxTokens,
        },
      })

      const cost = 0 // Explicitly setting 0 as cost
      return {
        text: response.message.content,
        cost,
      }
    } catch (error) {
      throw new Error("Failed to get response from Ollama")
    }
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    try {
      const stream = await (this.client as Ollama).chat({
        model: modelParams.modelId,
        messages: [
          {
            role: "system",
            content: modelParams.systemPrompt!,
          },
          ...messages.map((v) => ({
            content: v.content ? v.content[0].text! : "",
            role: v.role! as "user" | "assistant",
          })),
        ],
        options: {
          temperature: modelParams.temperature,
          top_p: modelParams.topP,
          num_predict: modelParams.maxTokens,
        },
        stream: true,
      })

      for await (const chunk of stream) {
        yield {
          text: chunk.message.content,
          metadata: chunk.done ? "stop" : undefined,
          cost: 0, // Ollama is typically free to run locally
        }
      }
    } catch (error) {
      Logger.error(error, "Error in converseStream of Ollama")
      throw error
    }
  }
}
