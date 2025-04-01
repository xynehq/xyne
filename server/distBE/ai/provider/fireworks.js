import {} from "@aws-sdk/client-bedrock-runtime";
import { AIProviders } from "../../ai/types.js";
import BaseProvider from "../../ai/provider/base.js";
import { getLogger } from "../../logger/index.js";
import { Subsystem } from "../../types.js";
const Logger = getLogger(Subsystem.AI);
export class FireworksProvider extends BaseProvider {
    constructor(client) {
        super(client, AIProviders.Fireworks);
    }
    async converse(messages, params) {
        const modelParams = this.getModelParams(params);
        try {
            const response = await this.client.complete([
                {
                    role: "system",
                    content: modelParams.systemPrompt,
                },
                ...messages.map((v) => ({
                    content: v.content ? v.content[0].text : "",
                    role: v.role,
                })),
            ], {
                model: modelParams.modelId,
                temperature: modelParams.temperature,
                top_p: modelParams.topP,
                max_tokens: modelParams.maxTokens,
                stream: false,
            });
            const cost = 0; // Explicitly setting 0 as cost
            return {
                text: response.choices[0].message?.content || "",
                cost,
            };
        }
        catch (error) {
            throw new Error("Failed to get response from Fireworks");
        }
    }
    async *converseStream(messages, params) {
        const modelParams = this.getModelParams(params);
        try {
            const messagesList = [
                {
                    role: "system",
                    content: modelParams.systemPrompt,
                },
                ...messages.map((v) => ({
                    content: v.content ? v.content[0].text : "",
                    role: (v.role || "user"),
                })),
            ];
            for await (const chunk of this.client.streamComplete(messagesList, {
                model: modelParams.modelId,
                temperature: modelParams.temperature,
                top_p: modelParams.topP,
                // max_tokens: modelParams.maxTokens,
            })) {
                yield {
                    text: chunk,
                    cost: 0,
                };
            }
        }
        catch (error) {
            Logger.error(error, "Error in converseStream of Together");
            throw error;
        }
    }
}
