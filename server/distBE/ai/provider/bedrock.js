import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand, } from "@aws-sdk/client-bedrock-runtime";
import { modelDetailsMap } from "../../ai/mappers.js";
import { AIProviders } from "../../ai/types.js";
import BaseProvider from "../../ai/provider/base.js";
import { calculateCost } from "../../utils/index.js";
import { getLogger } from "../../logger/index.js";
import { Subsystem } from "../../types.js";
const Logger = getLogger(Subsystem.AI);
import config from "../../config.js";
const { StartThinkingToken, EndThinkingToken } = config;
export class BedrockProvider extends BaseProvider {
    constructor(client) {
        super(client, AIProviders.AwsBedrock);
    }
    async converse(messages, params) {
        const modelParams = this.getModelParams(params);
        const command = new ConverseCommand({
            modelId: modelParams.modelId,
            system: [
                {
                    text: modelParams.systemPrompt,
                },
            ],
            messages,
            inferenceConfig: {
                maxTokens: modelParams.maxTokens || 512,
                topP: modelParams.topP || 0.9,
                temperature: modelParams.temperature || 0,
            },
        });
        const response = await this.client.send(command);
        if (!response) {
            throw new Error("Invalid bedrock response");
        }
        let fullResponse = response.output?.message?.content?.reduce((prev, current) => {
            prev += current.text;
            return prev;
        }, "");
        if (!response.usage) {
            throw new Error("Could not get usage");
        }
        const { inputTokens, outputTokens } = response.usage;
        return {
            text: fullResponse,
            cost: calculateCost({ inputTokens: inputTokens, outputTokens: outputTokens }, modelDetailsMap[modelParams.modelId].cost.onDemand),
        };
    }
    async *converseStream(messages, params) {
        const modelParams = this.getModelParams(params);
        const command = new ConverseStreamCommand({
            modelId: modelParams.modelId,
            system: [
                {
                    text: modelParams.systemPrompt,
                },
            ],
            messages: messages,
            inferenceConfig: {
                // maxTokens: modelParams.maxTokens || 512,
                topP: modelParams.topP || 0.9,
                temperature: modelParams.temperature || 0.6,
            },
        });
        let modelId = modelParams.modelId;
        let costYielded = false;
        try {
            const response = await this.client.send(command);
            let startedReasoning = false;
            if (params.reasoning) {
                for await (const chunk of response.stream) {
                    if (chunk.contentBlockStop) {
                        yield {
                            text: EndThinkingToken,
                        };
                        break;
                    }
                    const reasoning = chunk.contentBlockDelta?.delta?.reasoningContent?.text;
                    if (!startedReasoning) {
                        yield {
                            text: `${StartThinkingToken}${reasoning}`,
                        };
                        startedReasoning = true;
                    }
                    else {
                        yield {
                            text: reasoning,
                        };
                    }
                }
            }
            if (response.stream) {
                for await (const chunk of response.stream) {
                    const text = chunk.contentBlockDelta?.delta?.text;
                    const metadata = chunk.metadata;
                    let cost;
                    if (text) {
                        yield {
                            text,
                            metadata,
                            cost: !costYielded && metadata?.usage
                                ? calculateCost({
                                    inputTokens: metadata.usage.inputTokens,
                                    outputTokens: metadata.usage.outputTokens,
                                }, modelDetailsMap[modelId].cost.onDemand)
                                : undefined,
                        };
                    }
                    // Handle cost separately if we haven't yielded it yet
                    else if (metadata?.usage && !costYielded) {
                        costYielded = true;
                        yield {
                            text: "",
                            metadata,
                            cost: calculateCost({
                                inputTokens: metadata.usage.inputTokens,
                                outputTokens: metadata.usage.outputTokens,
                            }, modelDetailsMap[modelId].cost.onDemand),
                        };
                    }
                }
            }
        }
        catch (error) {
            Logger.error(error, "Error in converseStream of Bedrock");
            throw error;
        }
    }
}
