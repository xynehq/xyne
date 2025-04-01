import { GoogleGenerativeAI } from "@google/generative-ai";
import BaseProvider from "../../ai/provider/base.js";
import { AIProviders } from "../types.js";
import { getLogger } from "../../logger/index.js";
import { Subsystem } from "../../types.js";
const Logger = getLogger(Subsystem.AI);
export class GeminiAIProvider extends BaseProvider {
    constructor(client) {
        super(client, AIProviders.GoogleAI);
    }
    async converse(messages, params) {
        const modelParams = this.getModelParams(params);
        try {
            const geminiModel = await this.client.getGenerativeModel({
                model: modelParams.modelId,
            });
            const response = await geminiModel
                .startChat({
                history: messages.map((v) => {
                    const role = v.role; // Ensure role is typed correctly
                    const part = v.content ? v.content[0].text : ""; // Ensure safe access with a default fallback
                    return {
                        role,
                        parts: [{ text: part }], // Wrap text in an array of objects, assuming Part has a text field
                    };
                }),
                systemInstruction: {
                    role: "system",
                    parts: [{ text: modelParams.systemPrompt }],
                },
                generationConfig: {
                    maxOutputTokens: modelParams.maxTokens,
                    temperature: modelParams.temperature,
                    responseMimeType: "application/json",
                },
            })
                .sendMessage(messages[0].content ? messages[0].content[0].text : "");
            const cost = 0;
            return {
                text: response.response.text() || "",
                cost: cost,
            };
        }
        catch (err) {
            Logger.error("Converse Error : ", err);
            throw new Error(`Failed to get response from Gemini ${err}`);
        }
    }
    async *converseStream(messages, params) {
        const modelParams = this.getModelParams(params);
        try {
            const geminiModel = await this.client.getGenerativeModel({
                model: modelParams.modelId,
            });
            const chatComponent = geminiModel.startChat({
                history: messages.map((v) => ({
                    role: v.role === "assistant" ? "model" : v.role,
                    parts: [{ text: v.content ? v.content[0].text : "" }],
                })),
                systemInstruction: {
                    role: "system",
                    parts: [{ text: modelParams.systemPrompt }], // Wrap text in an array
                },
                generationConfig: {
                    maxOutputTokens: modelParams.maxTokens,
                    temperature: modelParams.temperature,
                    responseMimeType: "application/json",
                },
            });
            const latestMessage = messages[messages.length - 1]?.content?.[0]?.text || "";
            const streamResponse = await chatComponent.sendMessageStream(latestMessage);
            for await (const chunk of streamResponse.stream) {
                const text = chunk.text();
                if (text) {
                    yield {
                        text: text,
                        cost: 0,
                    };
                }
            }
        }
        catch (error) {
            Logger.error("Streaming Error : ", error);
            throw new Error(`Failed to get response from Gemini: ${error}`);
        }
    }
}
