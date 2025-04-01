import {} from "@aws-sdk/client-bedrock-runtime";
import { AIProviders } from "../../ai/types.js";
import BaseProvider from "../../ai/provider/base.js";
import { getLogger } from "../../logger/index.js";
import { Subsystem } from "../../types.js";
const Logger = getLogger(Subsystem.AI);
import Together from "together-ai";
export class TogetherProvider extends BaseProvider {
    constructor(client) {
        super(client, AIProviders.Together);
    }
    async converse(messages, params) {
        const modelParams = this.getModelParams(params);
        try {
            const response = await this.client.chat.completions.create({
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
            throw new Error("Failed to get response from Together");
        }
    }
    async *converseStream(messages, params) {
        const modelParams = this.getModelParams(params);
        try {
            const stream = await this.client.chat.completions.create({
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
                temperature: modelParams.temperature,
                top_p: modelParams.topP,
                // max_tokens: modelParams.maxTokens,
                stream: true,
            });
            for await (const chunk of stream) {
                const text = chunk.choices[0]?.delta?.content;
                const finishReason = chunk.choices[0]?.finish_reason;
                if (text || finishReason) {
                    yield {
                        text: text || "",
                        metadata: finishReason,
                        // Only send cost with first meaningful chunk
                        cost: 0,
                    };
                }
            }
        }
        catch (error) {
            Logger.error(error, "Error in converseStream of Together");
            throw error;
        }
    }
}
