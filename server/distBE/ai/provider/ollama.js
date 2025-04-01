import {} from "@aws-sdk/client-bedrock-runtime";
import { AIProviders } from "../../ai/types.js";
import BaseProvider from "../../ai/provider/base.js";
import { getLogger } from "../../logger/index.js";
import { Subsystem } from "../../types.js";
const Logger = getLogger(Subsystem.AI);
export class OllamaProvider extends BaseProvider {
    constructor(client) {
        super(client, AIProviders.Ollama);
    }
    async converse(messages, params) {
        const modelParams = this.getModelParams(params);
        try {
            const response = await this.client.chat({
                model: modelParams.modelId,
                messages: [
                    {
                        role: "system",
                        content: modelParams.systemPrompt,
                    },
                    ...messages.map((v) => ({
                        content: v.content ? v.content[0].text : "",
                        role: v.role,
                    })),
                ],
                options: {
                    temperature: modelParams.temperature,
                    top_p: modelParams.topP,
                    num_predict: modelParams.maxTokens,
                },
            });
            const cost = 0; // Explicitly setting 0 as cost
            return {
                text: response.message.content,
                cost,
            };
        }
        catch (error) {
            throw new Error("Failed to get response from Ollama");
        }
    }
    async *converseStream(messages, params) {
        const modelParams = this.getModelParams(params);
        try {
            const stream = await this.client.chat({
                model: modelParams.modelId,
                messages: [
                    {
                        role: "system",
                        content: modelParams.systemPrompt,
                    },
                    ...messages.map((v) => ({
                        content: v.content ? v.content[0].text : "",
                        role: v.role,
                    })),
                ],
                options: {
                    temperature: modelParams.temperature,
                    top_p: modelParams.topP,
                    num_predict: modelParams.maxTokens,
                },
                stream: true,
            });
            for await (const chunk of stream) {
                yield {
                    text: chunk.message.content,
                    metadata: chunk.done ? "stop" : undefined,
                    cost: 0, // Ollama is typically free to run locally
                };
            }
        }
        catch (error) {
            Logger.error(error, "Error in converseStream of Ollama");
            throw error;
        }
    }
}
