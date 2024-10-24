import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime"
import config from "@/config"
const { AwsAccessKey, AwsSecretKey, bedrockSupport } = config

const Llama_3_2_1B = "us.meta.llama3-2-1b-instruct-v1:0" //"meta.llama3-2-1b-instruct-v1:0"
const Llama_3_2_3B = "us.meta.llama3-2-3b-instruct-v1:0"
const Llama_3_1_70B = "meta.llama3-1-70b-instruct-v1:0"

interface ModelParams {
  max_new_tokens?: number
  top_p?: number
  temperature?: number
}

let client: BedrockRuntimeClient
if (bedrockSupport) {
  client = new BedrockRuntimeClient({
    region: "us-west-2",
    credentials: {
      accessKeyId: AwsAccessKey,
      secretAccessKey: AwsSecretKey,
    },
  })
}
const modelId = Llama_3_2_3B

export const askQuestion = async (
  question: string,
  params: ModelParams = {},
  onChunk?: (text: string) => void,
) => {
  if (!bedrockSupport) {
    return
  }
  try {
    const command = new ConverseStreamCommand({
      modelId,
      system: [{ text: "You are a helpful assistant." }],
      messages: [
        {
          role: "user",
          content: [{ text: question }],
        },
      ],
      inferenceConfig: {
        maxTokens: params.max_new_tokens || 512,
        topP: params.top_p || 0.9,
        temperature: params.temperature || 0.6,
      },
    })

    const response = await client.send(command)
    let fullResponse = ""

    if (response.stream) {
      for await (const chunk of response.stream) {
        const text = chunk.contentBlockDelta?.delta?.text
        if (text) {
          fullResponse += text
          if (onChunk) onChunk(text)
        }
      }
    }

    return fullResponse
  } catch (error) {
    console.error("Error asking question:", error)
    throw error
  }
}
