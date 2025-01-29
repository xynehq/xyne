import { type Message } from "@aws-sdk/client-bedrock-runtime"
import OpenAI from "openai"
import { modelDetailsMap } from "@/ai/mappers"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import BaseProvider from "@/ai/provider/base"
import { calculateCost } from "@/utils/index"

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
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: modelParams.maxTokens,
      temperature: modelParams.temperature,
      top_p: modelParams.topP,
    })
    let cost: number | undefined
    for await (const chunk of chatCompletion) {
      if (chunk.usage) {
        cost = calculateCost(
          {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          },
          modelDetailsMap[modelParams.modelId].cost.onDemand,
        )
      }
      if (chunk.choices && chunk.choices.length) {
        yield {
          text: chunk.choices[0].delta.content!,
          metadata: chunk.choices[0].finish_reason,
          cost,
        }
      } else {
        yield {
          text: "",
          metadata: "",
          cost,
        }
      }
    }
  }
}
