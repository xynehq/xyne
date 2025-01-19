import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime"
import { modelDetailsMap } from "@/ai/mappers"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import BaseProvider from "@/ai/provider/base"
import { calculateCost } from "@/utils/index"

export class BedrockProvider extends BaseProvider {
  constructor(client: any) {
    super(client, AIProviders.AwsBedrock)
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    const command = new ConverseCommand({
      modelId: modelParams.modelId,
      system: [
        {
          text: modelParams.systemPrompt!,
        },
      ],
      messages,
      inferenceConfig: {
        maxTokens: modelParams.maxTokens || 512,
        topP: modelParams.topP || 0.9,
        temperature: modelParams.temperature || 0,
      },
    })
    const response = await (this.client as BedrockRuntimeClient).send(command)
    if (!response) {
      throw new Error("Invalid bedrock response")
    }

    let fullResponse = response.output?.message?.content?.reduce(
      (prev: string, current) => {
        prev += current.text
        return prev
      },
      "",
    )
    if (!response.usage) {
      throw new Error("Could not get usage")
    }
    const { inputTokens, outputTokens } = response.usage
    return {
      text: fullResponse,
      cost: calculateCost(
        { inputTokens: inputTokens!, outputTokens: outputTokens! },
        modelDetailsMap[modelParams.modelId].cost.onDemand,
      ),
    }
  }
  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    const command = new ConverseStreamCommand({
      modelId: modelParams.modelId,
      system: [
        {
          text: modelParams.systemPrompt!,
        },
      ],
      messages: messages,
      inferenceConfig: {
        maxTokens: modelParams.maxTokens || 512,
        topP: modelParams.topP || 0.9,
        temperature: modelParams.temperature || 0.6,
      },
    })

    let modelId = modelParams.modelId!
    try {
      const response = await this.client.send(command)

      if (response.stream) {
        for await (const chunk of response.stream) {
          const text = chunk.contentBlockDelta?.delta?.text
          const metadata = chunk.metadata
          let cost: number | undefined

          if (metadata?.usage) {
            const { inputTokens, outputTokens } = metadata.usage
            cost = calculateCost(
              { inputTokens: inputTokens!, outputTokens: outputTokens! },
              modelDetailsMap[modelId].cost.onDemand,
            )
          }
          yield {
            text,
            metadata,
            cost,
          }
        }
      }
    } catch (error) {
      console.error("Error in converseBedrock:", error)
      throw error
    }
  }
}
