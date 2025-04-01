import {} from "@aws-sdk/client-bedrock-runtime";
// import { AIProviders } from "../../ai/types";
import config from "../../config.js";
const { defaultFastModel } = config;
class Provider {
    client;
    providerType;
    constructor(client, providerType) {
        this.client = client;
        this.providerType = providerType;
    }
    getModelParams(params) {
        return {
            maxTokens: params.max_new_tokens || 512,
            topP: params.top_p || 0.9,
            temperature: params.temperature || 0.6,
            modelId: params.modelId || defaultFastModel,
            systemPrompt: params.systemPrompt || "You are a helpful assistant.",
            userCtx: params.userCtx,
            stream: params.stream,
            json: params.json || null,
        };
    }
}
export default Provider;
