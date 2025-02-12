import { GenerativeModel, GoogleGenerativeAI, type Content } from "@google/generative-ai";
import BaseProvider from '@/ai/provider/base'
import type { Message } from "@aws-sdk/client-bedrock-runtime";
import { type ModelParams, type ConverseResponse, AIProviders } from "../types";

 export class GeminiAIProvider extends BaseProvider {

      constructor(client: GoogleGenerativeAI) {
        super(client, AIProviders.GoogleAI)
      }
      
     async converse(messages: Message[], params: ModelParams): Promise<ConverseResponse> {

      const modelParams = this.getModelParams(params)
      try{
        const geminiModel = await (this.client as GoogleGenerativeAI).getGenerativeModel(
          {
            model: modelParams.modelId
          });
          const response =  await geminiModel.generateContent({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: messages[0].content ? messages[0].content[0].text! : "",
                  }
                ],
              }
          ],
          generationConfig: {
            maxOutputTokens: modelParams.maxTokens,
            temperature: modelParams.temperature,
          }
          })
          console.log(response.response.text())
          const cost = 0 
          return {
            text: response.response.text() || "",
            cost:  cost
          };
      }catch(err) {
        throw new Error("Failed to get response from Together")
      }
       
     }
     converseStream(messages: Message[], params: ModelParams): AsyncIterableIterator<ConverseResponse> {
         throw new Error("Method not implemented.");
     }
  
}
