import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime"
import { modelDetailsMap } from "@/ai/mappers"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders, Models } from "@/ai/types"
import BaseProvider from "@/ai/provider/base"
import { calculateCost } from "@/utils/index"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
const Logger = getLogger(Subsystem.AI)
import config from "@/config"
const { StartThinkingToken, EndThinkingToken } = config
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

    // Configure reasoning parameters only if reasoning is enabled AND using Claude 3.7
    const reasoningModel = modelParams.modelId === Models.Claude_Sonnet_4 || modelParams.modelId === Models.Claude_3_7_Sonnet
    const isThinkingEnabled = params.reasoning

    const reasoningConfig =
      isThinkingEnabled && reasoningModel
        ? {
            thinking: {
              type: "enabled",
              budget_tokens: 1024,
            },
          }
        : undefined

    // When using thinking mode with Claude 3.7 Sonnet, temperature must be 1 and top_p must be unset
    const temperature =
      isThinkingEnabled && reasoningModel ? 1 : modelParams.temperature || 0.6

    // Create the inferenceConfig based on whether thinking is enabled
    const inferenceConfig = isThinkingEnabled
      ? {
          maxTokens: modelParams.maxTokens || 2500,
          temperature: temperature,
        }
      : {
          maxTokens: modelParams.maxTokens || 2500,
          topP: modelParams.topP || 0.9,
          temperature: temperature,
        }

    const command = new ConverseStreamCommand({
      modelId: modelParams.modelId,
      additionalModelRequestFields: reasoningConfig,
      system: [
        {
          text: modelParams.systemPrompt!,
        },
      ],
      messages: messages,
      inferenceConfig,
    })

    let modelId = modelParams.modelId!
    let costYielded = false
    try {
      const response = await this.client.send(command)

      // Process reasoning/thinking content if enabled for Claude 3.7
      let startedReasoning = false
      if (isThinkingEnabled && response.stream) {
        for await (const chunk of response.stream) {
          if (chunk.contentBlockStop) {
            yield {
              text: EndThinkingToken,
            }
            break
          }

          const reasoning =
            chunk.contentBlockDelta?.delta?.reasoningContent?.text || ""
          if (reasoning) {
            if (!startedReasoning) {
              yield {
                text: `${StartThinkingToken}${reasoning}`,
              }
              startedReasoning = true
            } else {
              yield {
                text: reasoning,
              }
            }
          }
        }
      }

      // Process regular content stream
      if (response.stream) {
        for await (const chunk of response.stream) {
          const text = chunk.contentBlockDelta?.delta?.text || ""
          const metadata = chunk.metadata

          if (text) {
            yield {
              text,
              metadata,
              cost:
                !costYielded && metadata?.usage
                  ? calculateCost(
                      {
                        inputTokens: metadata.usage.inputTokens!,
                        outputTokens: metadata.usage.outputTokens!,
                      },
                      modelDetailsMap[modelId].cost.onDemand,
                    )
                  : undefined,
            }
          }
          // Handle cost separately if we haven't yielded it yet
          else if (metadata?.usage && !costYielded) {
            costYielded = true
            yield {
              text: "",
              metadata,
              cost: calculateCost(
                {
                  inputTokens: metadata.usage.inputTokens!,
                  outputTokens: metadata.usage.outputTokens!,
                },
                modelDetailsMap[modelId].cost.onDemand,
              ),
            }
          }
        }
      }
    } catch (error) {
      Logger.error(error, "Error in converseStream of Bedrock")
      throw error
    }
  }
}
