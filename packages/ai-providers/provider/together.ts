import { type Message } from "@aws-sdk/client-bedrock-runtime"
import type { ConverseResponse, ModelParams } from "../types"
import { AIProviders } from "../types"
import BaseProvider from "./base"
import { getLogger } from "../logger"
import { Subsystem } from "../server-types"
const Logger = getLogger(Subsystem.AI)
import Together from "together-ai"

export class TogetherProvider extends BaseProvider {
  constructor(client: Together) {
    super(client, AIProviders.Together)
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    try {
      const response = await (this.client as Together).chat.completions.create({
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
        temperature: modelParams.temperature,
        top_p: modelParams.topP,
        max_tokens: modelParams.maxTokens,
        stream: false,
      })

      const cost = 0 // Explicitly setting 0 as cost
      return {
        text: response.choices[0].message?.content || "",
        cost,
      }
    } catch (error) {
      throw new Error("Failed to get response from Together")
    }
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    try {
      const stream = await (this.client as Together).chat.completions.create({
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
        temperature: modelParams.temperature,
        top_p: modelParams.topP,
        // max_tokens: modelParams.maxTokens,
        stream: true,
      })

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content
        const finishReason = chunk.choices[0]?.finish_reason

        if (text || finishReason) {
          yield {
            text: text || "",
            metadata: finishReason,
            // Only send cost with first meaningful chunk
            cost: 0,
          }
        }
      }
    } catch (error) {
      Logger.error(error, "Error in converseStream of Together")
      throw error
    }
  }
}
