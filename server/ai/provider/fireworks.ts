import { type Message } from "@aws-sdk/client-bedrock-runtime"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import BaseProvider from "@/ai/provider/base"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
const Logger = getLogger(Subsystem.AI)

import type { ChatMessage, Fireworks, MessageRole } from "./fireworksClient"

export class FireworksProvider extends BaseProvider {
  constructor(client: Fireworks) {
    super(client, AIProviders.Fireworks)
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    try {
      const response = await (this.client as Fireworks).complete(
        [
          {
            role: "system",
            content: modelParams.systemPrompt,
          },
          ...messages.map((v) => ({
            content: v.content ? v.content[0].text! : "",
            role: v.role! as "user" | "assistant",
          })),
        ],
        {
          model: modelParams.modelId,
          temperature: modelParams.temperature,
          top_p: modelParams.topP,
          max_tokens: modelParams.maxTokens,
          stream: false,
        },
      )

      const cost = 0 // Explicitly setting 0 as cost
      return {
        text: response.choices[0].message?.content || "",
        cost,
      }
    } catch (error) {
      throw new Error("Failed to get response from Fireworks")
    }
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    try {
      const messagesList: ChatMessage[] = [
        {
          role: "system" as MessageRole,
          content: modelParams.systemPrompt!,
        },
        ...messages.map((v) => ({
          content: v.content ? v.content[0].text! : "",
          role: (v.role || "user") as MessageRole,
        })),
      ]

      for await (const chunk of (this.client as Fireworks).streamComplete(
        messagesList,
        {
          model: modelParams.modelId,
          temperature: modelParams.temperature,
          top_p: modelParams.topP,
          max_tokens: modelParams.maxTokens,
        },
      )) {
        yield {
          text: chunk,
          cost: 0,
        }
      }
    } catch (error) {
      Logger.error(error, "Error in converseStream of Together")
      throw error
    }
  }
}
