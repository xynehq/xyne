import llama3Tokenizer from "llama3-tokenizer-js"
import ollama from "ollama"
import {
  BedrockRuntimeClient,
  ConversationRole,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
  SystemContentBlock,
  type ConverseStreamMetadataEvent,
  type Message,
  type TokenUsage,
} from "@aws-sdk/client-bedrock-runtime"
import config from "@/config"
import { z } from "zod"
const { AwsAccessKey, AwsSecretKey, bedrockSupport, OpenAIKey } = config
import OpenAI from "openai"
import { getLogger } from "@/logger"
import { MessageRole, Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { parse } from "partial-json"
import { Apps, entitySchema } from "@/search/types"

const Logger = getLogger(Subsystem.AI)

export enum Models {
  Llama_3_2_1B = "us.meta.llama3-2-1b-instruct-v1:0",
  Llama_3_2_3B = "us.meta.llama3-2-3b-instruct-v1:0",
  Llama_3_1_70B = "meta.llama3-1-70b-instruct-v1:0",
  Llama_3_1_8B = "meta.llama3-1-8b-instruct-v1:0",
  Llama_3_1_405B = "meta.llama3-1-405b-instruct-v1:0",
  // Bedrock_Claude = "",
  Gpt_4o = "gpt-4o",
  // Gpt_4o_mini = "gpt-4o-mini",
  Gpt_4o_mini = "meta-llama/Llama-3-8b-chat-hf",
  Gpt_4 = "gpt-4",

  CohereCmdRPlus = "cohere.command-r-plus-v1:0",
  CohereCmdR = "cohere.command-r-v1:0",
  Claude_3_5_SonnetV2 = "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
  Claude_3_5_Haiku = "anthropic.claude-3-5-haiku-20241022-v1:0",
}

type Cost = {
  pricePerThousandInputTokens: number
  pricePerThousandOutputTokens: number
}

export const modelDetailsMap: Record<
  string,
  { name: string; cost: { onDemand: Cost; batch?: Cost } }
> = {
  [Models.Llama_3_2_1B]: {
    name: "Llama 3.2 Instruct (1B)",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.0001,
        pricePerThousandOutputTokens: 0.0001,
      },
      batch: {
        pricePerThousandInputTokens: 0.00005,
        pricePerThousandOutputTokens: 0.00005,
      },
    },
  },
  [Models.Llama_3_2_3B]: {
    name: "Llama 3.2 Instruct (3B)",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00015,
        pricePerThousandOutputTokens: 0.00015,
      },
      batch: {
        pricePerThousandInputTokens: 0.000075,
        pricePerThousandOutputTokens: 0.000075,
      },
    },
  },
  [Models.Llama_3_1_8B]: {
    name: "Llama 3.1 Instruct (8B)",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00022,
        pricePerThousandOutputTokens: 0.00022,
      },
      batch: {
        pricePerThousandInputTokens: 0.00011,
        pricePerThousandOutputTokens: 0.00011,
      },
    },
  },
  [Models.Llama_3_1_70B]: {
    name: "Llama 3.1 Instruct (70B)",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00099,
        pricePerThousandOutputTokens: 0.00099,
      },
      batch: {
        pricePerThousandInputTokens: 0.0005,
        pricePerThousandOutputTokens: 0.0005,
      },
    },
  },
  [Models.Llama_3_1_405B]: {
    name: "Llama 3.1 Instruct (405B)",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00532,
        pricePerThousandOutputTokens: 0.016,
      },
      batch: {
        pricePerThousandInputTokens: 0.00266,
        pricePerThousandOutputTokens: 0.008,
      },
    },
  },
  [Models.Gpt_4o]: {
    name: "GPT-4o",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.0025,
        pricePerThousandOutputTokens: 0.01,
      },
      batch: {
        pricePerThousandInputTokens: 0.00125,
        pricePerThousandOutputTokens: 0.005,
      },
    },
  },
  [Models.Gpt_4o_mini]: {
    name: "GPT-4o Mini",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00015,
        pricePerThousandOutputTokens: 0.0006,
      },
      batch: {
        pricePerThousandInputTokens: 0.000075,
        pricePerThousandOutputTokens: 0.0003,
      },
    },
  },

  [Models.Gpt_4]: {
    name: "GPT-4",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.03,
        pricePerThousandOutputTokens: 0.06,
      },
      batch: {
        pricePerThousandInputTokens: 0.015,
        pricePerThousandOutputTokens: 0.03,
      },
    },
  },
  [Models.CohereCmdRPlus]: {
    name: "Command R+",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.0025,
        pricePerThousandOutputTokens: 0.01,
      },
    },
  },
  [Models.CohereCmdR]: {
    name: "Command R",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00015,
        pricePerThousandOutputTokens: 0.0006,
      },
    },
  },
  [Models.Claude_3_5_SonnetV2]: {
    name: "Claude 3.5 Sonnet v2",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.003,
        pricePerThousandOutputTokens: 0.015,
      },
      batch: {
        pricePerThousandInputTokens: 0.0015,
        pricePerThousandOutputTokens: 0.0075,
      },
    },
  },
  [Models.Claude_3_5_Haiku]: {
    name: "Claude 3.5 Haiku",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.001,
        pricePerThousandOutputTokens: 0.005,
      },
      batch: {
        pricePerThousandInputTokens: 0.0005,
        pricePerThousandOutputTokens: 0.0025,
      },
    },
  },
}

export const calculateCost = (
  { inputTokens, outputTokens }: { inputTokens: number; outputTokens: number },
  cost: Cost,
): number => {
  const inputCost = (inputTokens / 1000) * cost.pricePerThousandInputTokens
  const outputCost = (outputTokens / 1000) * cost.pricePerThousandOutputTokens
  return inputCost + outputCost
}

const askQuestionSelfCleanupPrompt = (
  query: string,
  context: string,
): string => `
User query: ${query}
The user is asking about themselves. Focus on providing information that is personally relevant and ignore promotional content unless it directly pertains to the user's query.
Context:
${context}
`

const Oregon = "us-west-2"
const NVirginia = "us-east-1"
const FastModel = Models.Llama_3_1_70B
interface ModelParams {
  max_new_tokens?: number
  top_p?: number
  temperature?: number
  modelId: Models
  systemPrompt?: string
  prompt?: string
  userCtx?: string
  stream: boolean
  json?: boolean
  messages?: Message[]
}

enum AIProviders {
  OpenAI = "openai",
  AwsBedrock = "bedrock",
  Ollama = "ollama",
}

export interface ConverseResponse {
  text?: string
  metadata?: any
  cost?: number
}

interface LLMProvider {
  converseStream(
    messages: Message[],
    params?: ModelParams,
  ): AsyncIterableIterator<ConverseResponse>
  converseStream(
    messages: Message[],
    params?: ModelParams,
  ): AsyncIterableIterator<ConverseResponse>
  converse(messages: Message[], params?: ModelParams): Promise<ConverseResponse>
}

class Provider implements LLMProvider {
  private client: any
  private providerType: AIProviders
  constructor(client: any, providerType: AIProviders) {
    this.client = client
    this.providerType = providerType
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = {
      maxTokens: params.max_new_tokens || 512,
      topP: params.top_p || 0.9,
      temperature: params.temperature || 0.6,
      modelId: params.modelId || FastModel,
      systemPrompt: params.systemPrompt || "You are a helpful assistant.",
      userCtx: params.userCtx,
      stream: false,
    }

    // Call the appropriate method based on provider type
    switch (this.providerType) {
      case AIProviders.OpenAI:
        return this.converseOpenAI(messages, modelParams)
      case AIProviders.AwsBedrock:
        return this.converseBedrock(messages, modelParams)
      case AIProviders.Ollama:
        return this.converseOllama(messages, modelParams)
      default:
        throw new Error(`Unsupported provider type: ${this.providerType}`)
    }
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = {
      maxTokens: params.max_new_tokens || 512,
      topP: params.top_p || 0.9,
      temperature: params.temperature || 0.6,
      modelId: params.modelId || FastModel,
      systemPrompt: params.systemPrompt || "You are a helpful assistant.",
      userCtx: params.userCtx,
      stream: params.stream,
    }

    // Call the appropriate method based on provider type
    switch (this.providerType) {
      case AIProviders.OpenAI:
        yield* this.converseOpenAIStream(messages, modelParams)
        break
      case AIProviders.AwsBedrock:
        yield* this.converseBedrockStream(messages, modelParams)
        break
      case AIProviders.Ollama:
        yield* this.converseOllamaStream(messages, modelParams)
        break
      default:
        throw new Error(`Unsupported provider type: ${this.providerType}`)
    }
  }

  private async *converseBedrockStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const command = new ConverseStreamCommand({
      modelId: params.modelId,
      system: [
        {
          text: params.systemPrompt!,
        },
      ],
      messages: messages,
      inferenceConfig: {
        maxTokens: params.max_new_tokens || 512,
        topP: params.top_p || 0.9,
        temperature: params.temperature || 0.6,
      },
    })

    let modelId = params.modelId!
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

  private async *converseOllamaStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    // Placeholder for Ollama implementation
    throw new Error("Ollama provider is not implemented yet.")
  }
  private async *converseOpenAIStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    // Placeholder for Ollama implementation
    const chatCompletion = await (
      this.client as OpenAI
    ).chat.completions.create({
      messages: [
        {
          role: "system",
          content: params.systemPrompt!,
        },
        ...messages.map((v) => ({
          // @ts-ignore
          content: v.content[0].text!,
          role: v.role!,
        })),
      ],
      model: params.modelId,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: params.max_new_tokens,
      temperature: params.temperature,
      top_p: params.top_p,
    })
    let cost: number | undefined
    for await (const chunk of chatCompletion) {
      if (chunk.usage) {
        cost = calculateCost(
          {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          },
          modelDetailsMap[params.modelId].cost.onDemand,
        )
      }
      if (chunk.choices && chunk.choices.length) {
        yield {
          text: chunk.choices[0].delta.content!,
          metadata: chunk.choices[0].finish_reason,
          cost,
        }
      } else {
        yield {
          text: "",
          metadata: "",
          cost,
        }
      }
    }
  }
  private async converseOllama(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    // Placeholder for Ollama implementation
    throw new Error("Ollama provider is not implemented yet.")
  }
  private async converseOpenAI(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const chatCompletion = await (
      this.client as OpenAI
    ).chat.completions.create({
      messages: [
        {
          role: "system",
          content: params.systemPrompt!,
        },
        ...messages.map((v) => ({
          // @ts-ignore
          content: v.content[0].text!,
          role: v.role!,
        })),
      ],
      model: params.modelId,
      stream: false,
      max_tokens: params.max_new_tokens,
      temperature: params.temperature,
      top_p: params.top_p,
      ...(params.json ? { response_format: { type: "json_object" } } : {}),
    })
    const fullResponse = chatCompletion.choices[0].message?.content || ""
    const cost = calculateCost(
      {
        inputTokens: chatCompletion.usage?.prompt_tokens!,
        outputTokens: chatCompletion.usage?.completion_tokens!,
      },
      modelDetailsMap[params.modelId].cost.onDemand,
    )
    return {
      text: fullResponse,
      cost,
    }
  }

  private async converseBedrock(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const command = new ConverseCommand({
      modelId: params.modelId,
      system: [
        {
          text: params.systemPrompt!,
        },
      ],
      messages,
      inferenceConfig: {
        maxTokens: params.max_new_tokens || 512,
        topP: params.top_p || 0.9,
        temperature: params.temperature || 0,
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
        modelDetailsMap[params.modelId].cost.onDemand,
      ),
    }
  }
}

const BigModel = Models.Llama_3_1_70B
const askQuestionSystemPrompt =
  "You are a knowledgeable assistant that provides accurate and up-to-date answers based on the given context."

const askQuestionUserPrompt = (
  query: string,
  context: string,
  userCtx?: string,
): string => `${userCtx ? "Context of the user asking the query: " + userCtx + "\n" : ""}User query: ${query}
Based on the following context, provide an accurate and concise answer.
Ignore any promotional content or irrelevant data.
Context:
${context}`

type TokenCount = number
// this will be a few tokens less than the output of bedrock
// the gap should be around 50 tokens
export const askQuestionInputTokenCount = (
  query: string,
  context: string,
): TokenCount => {
  return llama3Tokenizer.encode(
    "user" + askQuestionSystemPrompt + askQuestionUserPrompt(query, context),
  ).length
}

const BedrockClient = new BedrockRuntimeClient({
  region: Oregon,
  credentials: {
    accessKeyId: AwsAccessKey,
    secretAccessKey: AwsSecretKey,
  },
})

const bedrockProvider = new Provider(BedrockClient, AIProviders.AwsBedrock)

const openAIClient = new OpenAI({
  apiKey: OpenAIKey,
  baseURL: "https://api.together.xyz/v1",
})

const openaiProvider = new Provider(openAIClient, AIProviders.OpenAI)

// @ts-ignore
const ProviderMap: Record<AIProviders, LLMProvider> = {
  [AIProviders.AwsBedrock]: bedrockProvider,
  [AIProviders.OpenAI]: openaiProvider,

  // [AIProviders.Ollama]: openaiProvider,
}

const ModelToProviderMap: Record<Models, AIProviders> = {
  [Models.Llama_3_1_405B]: AIProviders.AwsBedrock,
  [Models.Llama_3_1_70B]: AIProviders.AwsBedrock,
  [Models.Llama_3_2_3B]: AIProviders.AwsBedrock,
  [Models.Llama_3_2_1B]: AIProviders.AwsBedrock,
  [Models.Llama_3_1_8B]: AIProviders.AwsBedrock,
  [Models.Gpt_4o]: AIProviders.OpenAI,
  [Models.Gpt_4o_mini]: AIProviders.OpenAI,
  [Models.Gpt_4]: AIProviders.OpenAI,
  [Models.CohereCmdRPlus]: AIProviders.AwsBedrock,
  [Models.CohereCmdR]: AIProviders.AwsBedrock,
  [Models.Claude_3_5_SonnetV2]: AIProviders.AwsBedrock,
  [Models.Claude_3_5_Haiku]: AIProviders.AwsBedrock,
}

const getProviderByModel = (modelId: Models): LLMProvider => {
  const providerType = ModelToProviderMap[modelId]
  if (!providerType) {
    throw new Error("Invalid provider type")
  }
  const provider = ProviderMap[providerType]
  if (!provider) {
    throw new Error("Invalid provider type")
  }
  return provider
}

export const askQuestion = (
  query: string,
  context: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  try {
    if (!params.modelId) {
      params.modelId = BigModel
    }

    if (!params.systemPrompt) {
      params.systemPrompt = askQuestionSystemPrompt
    }
    return getProviderByModel(params.modelId).converseStream(
      [
        {
          role: "user",
          content: [
            {
              text: askQuestionUserPrompt(query, context, params.userCtx),
            },
          ],
        },
      ],
      params,
    )
  } catch (error) {
    console.error("Error asking question:", error)
    throw error
  }
}

export const AnalyzeUserQuerySystemPrompt = `You are an assistant tasked with analyzing metadata about context chunks to identify which chunks are relevant to the user's query. Based only on the provided metadata, determine whether each chunk is likely to contribute meaningfully to answering the query.
Return a JSON structure with:
- **canBeAnswered**: Boolean indicating if the query can be sufficiently answered using the relevant chunks.
- **contextualChunks**: A numeric array of indexes representing only the chunks containing valuable information or context to answer the query (e.g., [1, 2, 3]).

Each chunk's metadata includes details such as:
- **App**: The application source of the data.
- **Entity**: Type or category of the document (e.g., File, User, Email).
- **Title, Subject, To, From, Owner**: Key fields summarizing the content or origin of the chunk.
- **Permissions**: Visibility or sharing settings.
- **Relevance score**: Initial relevance rating provided by the system.

Note: If the entity is **Mail**, the metadata will also include **Labels**. Use this field to help determine the relevance of the email.

Prioritize selecting only the chunks that contain relevant information for answering the user's query. Do not include any chunks that are repetitive, irrelevant, or that do not contribute meaningfully to the response.

Use these metadata fields to determine relevance. Avoid selecting chunks that appear unrelated, repetitive, or without valuable context.

Return only the JSON structure with the specified fields in a valid and parsable format, without any explanations or additional text.`

const QueryContextRank = z.object({
  canBeAnswered: z.boolean(),
  contextualChunks: z.array(z.number()),
})

export type QueryContextRank = z.infer<typeof QueryContextRank>

export const analyzeQuery = async (
  userQuery: string,
  context: string,
  params: ModelParams,
): Promise<[QueryContextRank, number]> => {
  try {
    const systemPrompt = AnalyzeUserQuerySystemPrompt
    if (!params.systemPrompt) {
      params.systemPrompt = systemPrompt
    }

    if (!params.modelId) {
      params.modelId = FastModel
    }

    const { text: fullResponse, cost } = await getProviderByModel(
      params.modelId,
    ).converse(
      [
        {
          role: "user",
          content: [
            {
              text: `User Query: "${userQuery}"\n\nRetrieved Contexts:\n${context}`,
            },
          ],
        },
      ],
      params,
    )

    if (!fullResponse) {
      throw new Error("Invalid response")
    }

    const structuredResponse = jsonParseLLMOutput(fullResponse)

    return [QueryContextRank.parse(structuredResponse), cost!]
  } catch (error) {
    console.error("Error analyzing query:", error)
    throw error
  }
}

export const metadataAnalysisSystemPrompt = `You are an assistant tasked with analyzing metadata about context chunks to identify which chunks are most relevant to the user's query.

Your task:
- Review the metadata provided for each chunk.
- Decide if the user’s query can be answered with the available information.
- If there is recent information on the topic, include it just in case it could add useful context.

Return a JSON structure with:
  - **canBeAnswered**: Boolean indicating if the query can likely be answered.
  - **contextualChunks**: A list of numeric indexes for chunks that seem useful, relevant, or recent (e.g., [0, 1, 3]).

Metadata includes details like:
- **App**: The data source.
- **Entity**: Type of document (e.g., File, User, Email).
- **Title, Subject, To, From, Owner**: Key fields describing the chunk.
- **Permissions**: Sharing settings.
- **Relevance score**: An initial relevance rating.
- **Timestamp**: Indicates when the chunk was created or last updated.

When reviewing, use these guidelines:
- Include chunks that appear helpful or relevant, even if they only partially address the query.
- If there’s recent information on the topic, include it as it may provide additional useful context.
- If the **Entity** is **Email**, consider the **Labels** field to gauge its relevance.

Aim to include chunks that could provide meaningful context or information. Return only the JSON structure with the specified fields in a valid and parsable format, without additional text or explanation.`

export const analyzeQueryMetadata = async (
  userQuery: string,
  context: string,
  params: ModelParams,
): Promise<[QueryContextRank | null, number]> => {
  try {
    let systemPrompt = metadataAnalysisSystemPrompt
    if (!params.systemPrompt) {
      params.systemPrompt = systemPrompt
    }

    let prompt = `User Query: "${userQuery}"\n\nRetrieved metadata Contexts:\n${context}`
    if (!params.prompt) {
      params.prompt = prompt
    }

    const { text, cost } = await getProviderByModel(params.modelId).converse(
      [
        {
          role: "user",
          content: [
            {
              text: askQuestionUserPrompt(userQuery, context, params.userCtx),
            },
          ],
        },
      ],
      params,
    )
    if (!text) {
      throw new Error("Invalid text")
    }
    const structuredResponse = jsonParseLLMOutput(text)

    return [QueryContextRank.parse(structuredResponse), cost!]
  } catch (error) {
    console.error("Error analyzing query:", error)
    throw error
  }
}

export enum QueryCategory {
  Self = "Self",
  InternalPerson = "InternalPerson",
  ExternalPerson = "ExternalPerson",
  Other = "Other",
}

const QueryAnalysisSchema = z.object({
  category: z.nativeEnum(QueryCategory),
  mentionedNames: z.array(z.string()),
  mentionedEmails: z.array(z.string()),
})

export const jsonParseLLMOutput = (text: string): any => {
  let jsonVal
  try {
    text = text.trim()
    // first it has to exist
    if (text.indexOf("{") !== -1) {
      if (text.indexOf("{") !== 0) {
        text = text.substring(text.indexOf("{"))
      }
    }
    if (text.lastIndexOf("}") !== -1) {
      if (text.lastIndexOf("}") !== text.length - 1) {
        text = text.substring(0, text.lastIndexOf("}") + 1)
      }
    }
    if (!text.trim()) {
      return ""
    }
    jsonVal = parse(text.trim())
  } catch (e) {
    try {
      text = text
        .replace(/```(json)?/g, "")
        .replace(/```/g, "")
        .replace(/\/\/.*$/gm, "")
        .trim()
      if (!text) {
        return ""
      }
      jsonVal = parse(text)
    } catch (parseError) {
      Logger.error(
        `The ai response that triggered the json parse error ${text.trim()}`,
      )
      throw parseError
    }
  }
  return jsonVal
}

type QueryAnalysisResult = z.infer<typeof QueryAnalysisSchema>

const peopleQueryAnalysisSystemPrompt = `
You are an assistant that analyzes user queries to categorize them and extract any names or emails mentioned.

**Important:** Only consider the user query provided below. Do not use any additional context or information about the user.

Return a JSON object with the following structure:
{
  "category": "Self" | "InternalPerson" | "ExternalPerson" | "Other",
  "mentionedNames": [list of names mentioned in the user query],
  "mentionedEmails": [list of emails mentioned in the user query]
}

Do not include any additional text or explanations. Only return the JSON object.

Notes:
- If the user is asking about themselves, set "category" to "Self".
- If the user mentions another employee or internal person, set "category" to "InternalPerson".
- If the user mentions someone outside the company, set "category" to "ExternalPerson".
- If no person is mentioned or the query is about other topics, set "category" to "Other".
- Extract any names or emails mentioned in the user query, and include them in the respective lists.`

export const analyzeQueryForNamesAndEmails = async (
  userQuery: string,
  params: ModelParams,
): Promise<{ result: QueryAnalysisResult; cost: number }> => {
  if (!params.modelId) {
    params.modelId = FastModel
  }
  if (!params.systemPrompt) {
    params.systemPrompt = peopleQueryAnalysisSystemPrompt
  }
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          text: userQuery,
        },
      ],
    },
  ]

  let { text, cost } = await getProviderByModel(params.modelId).converse(
    messages,
    params,
  )

  if (text) {
    const jsonVal = jsonParseLLMOutput(text)
    return {
      result: QueryAnalysisSchema.parse(jsonVal),
      cost: cost!,
    }
  } else {
    throw new Error("Could not get json response")
  }
}

export const userChat = (
  context: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  try {
    if (!params.modelId) {
      params.modelId = BigModel
    }

    if (!params.systemPrompt) {
      params.systemPrompt = userChatSystem(context)
    }

    if (!params.messages) {
      throw new Error("Cannot chat with empty messages")
    }
    return getProviderByModel(params.modelId).converseStream(
      params.messages!,
      params,
    )
  } catch (error) {
    throw error
  }
}
const userChatSystemPrompt =
  "You are a knowledgeable assistant that provides accurate and up-to-date answers based on the given context."

const userChatSystem = (
  userCtx: string,
): string => `${userChatSystemPrompt}\n${userCtx ? "Context of the user you are chatting with: " + userCtx + "\n" : ""}
Provide an accurate and concise answer.`

const generateTitleSystemPrompt = `
You are an assistant tasked with generating a concise and relevant title for a chat based on the user's query.

Please provide a suitable title that accurately reflects the essence of the query in JSON format as follows:
{
  "title": "Your generated title here"
}
`
export const generateTitleUsingQuery = async (
  query: string,
  params: ModelParams,
): Promise<{ title: string; cost: number }> => {
  try {
    if (!params.modelId) {
      params.modelId = BigModel
    }

    if (!params.systemPrompt) {
      params.systemPrompt = generateTitleSystemPrompt
    }

    params.json = true

    const { text, cost } = await getProviderByModel(params.modelId).converse(
      [
        {
          role: "user",
          content: [
            {
              text: query,
            },
          ],
        },
      ],
      params,
    )
    if (text) {
      const jsonVal = jsonParseLLMOutput(text)
      return {
        title: jsonVal.title,
        cost: cost!,
      }
    } else {
      throw new Error("Could not get json response")
    }
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(
      `Error asking question: ${errMessage} ${(error as Error).stack}`,
    )
    throw error
  }
}

const chatWithCitationsSystemPrompt = (userCtx?: string) => `
You are an assistant that answers questions based on the provided context. Your answer should be in Markdown format with selective inline numeric citations like [0], [1], etc.
${userCtx ? "\nContext about the user asking questions:\n" + userCtx : ""}

Provide the answer in the following JSON format:
{
  "answer": "Your markdown formatted answer with inline citations. For example: The sky is blue [0] and water is transparent.",
  "citations": [0]  // Array of context indices actually used in the answer
}

Rules for citations:
- Only cite sources that directly support key facts or claims
- Use citations sparingly - only when they add clear value
- Citations should appear immediately after the specific claim they support
- Use square brackets with 0-based numbers: [0], [1], etc.
- Numbers must exactly match the index in the citations array
- All indexing must be 0-based
- Omit citations for general knowledge or derived conclusions

Do not include any additional text outside of the JSON structure.
`

export const askQuestionWithCitations = (
  query: string,
  userContext: string,
  context: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  try {
    params.systemPrompt = chatWithCitationsSystemPrompt(userContext)
    params.json = true // Ensure that the provider returns JSON
    const baseMessage: Message = {
      role: MessageRole.User as const,
      content: [
        {
          text: `User query: ${query}
Based on the following context, provide an answer in JSON format with citations.
Context:
${context}`,
        },
      ],
    }

    const messages: Message[] = params.messages
      ? [...params.messages, baseMessage]
      : [baseMessage]

    return getProviderByModel(params.modelId).converseStream(messages, params)
  } catch (error) {
    throw error
  }
}

export const initialResultsOrRewriteSchema = z.object({
  answer: z.string().optional(),
  citations: z.array(z.number()),
  rewrittenQueries: z.array(z.string()).optional(),
})

export type ResultsOrRewrite = z.infer<typeof initialResultsOrRewriteSchema>

export const analyzeInitialResultsOrRewrite = (
  userQuery: string,
  context: string,
  userCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  const systemPrompt = `You are an assistant tasked with evaluating search results from a database of documents, users, and emails, and answering questions based on the provided context.

**Context of user asking the query:**
${userCtx}

**Instructions:**
1. **Primary Goal:** Provide a direct answer using the search results if possible
   - Citations must directly support key facts or claims, used sparingly.
   - If there is recent information on the topic, include it just in case it could add useful context.
   - Inline citations should immediately follow the specific claim they support.
   - Use square brackets with 0-based indices, matching the index in the "citations" array.
   - Do not include citations for general knowledge or derived conclusions.
   - For answer based on system prompt you do not need citation
   - Only add citation for text, don't add it to already linked text
   - Do not answer if you do not have valid context and goo for better query rewrites
2. **If Unable to Answer:**
   - Generate 2-3 alternative search queries to improve results, avoiding any mention of temporal aspects as these will be handled separately.
   - Rewrite the query removing the temporal nature of the user's query.
   - The first query should be a very contracted version of the original query.
   - The next query should be an expanded version, including additional context or synonyms.
   - Identify any temporal expressions in the user's query (e.g., "2 months ago," "since last week").
   - Compute a date range based on these expressions:
     - **Start Date:** Calculate based on the temporal expression relative to the current date.
     - **End Date:**
       - **If the temporal expression specifies an exact period** (e.g., "2 months ago," "last quarter"): Set the end date to the current date (2024-11-10).
       - **If the temporal expression implies an open-ended period** (e.g., "since last month," "from January 2024"): Set the end date to null.
   - Use ISO 8601 format (YYYY-MM-DD) for dates.
3. **Mutual Exclusivity:** Only one of "answer" or "rewritten_queries" should be present.
   - If an answer is provided, set "rewritten_queries" to null.
   - If an answer is not provided, set "answer" to null and provide "rewritten_queries" along with the "date_range".

**Return Format:**
{
    "answer": "Your Markdown formatted answer with inline citations. For example: The sky is blue [0] and water is transparent.",
    "citations": number[],  // Array of context indices actually used in the answer
    "rewrittenQueries": string[] | null,
    "dateRange": {
        "start": string | null,  // "YYYY-MM-DD"
        "end": string | null     // "YYYY-MM-DD" or null
    }
}`
  params.systemPrompt = systemPrompt

  const baseMessage: Message = {
    role: MessageRole.User as const,
    content: [
      {
        text: `User query: ${userQuery}
      Based on the following context, provide an answer in JSON format with citations
      Context:
      ${context}`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  return getProviderByModel(params.modelId).converseStream(messages, params)
}

export const analyzeInitialResultsOrRewriteV2 = (
  userQuery: string,
  context: string,
  userCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  const systemPrompt = `You are an assistant tasked with evaluating search results from a database of documents, users, and emails, and answering questions based on the provided context.

**Context of user asking the query:**
${userCtx}

**Instructions:**
1. **Primary Goal:** Provide a direct answer using the search results if possible
   - Citations must directly support key facts or claims, used sparingly.
   - If there is recent information on the topic, include it just in case it could add useful context.
   - Inline citations should immediately follow the specific claim they support.
   - Use square brackets with 0-based indices, matching the index in the "citations" array.
   - each citation will be a single number like [0] or [5]
   - Do not include citations for general knowledge or derived conclusions.
   - For answer based on system prompt you do not need citation
2. **If Unable to Answer:**
   - Generate 2-3 alternative search queries to improve results, avoiding any mention of temporal aspects as these will be handled separately.
   - keep the answer field empty
   - Rewrite the query removing the temporal nature of the user's query.
   - The first query should be a very contracted version of the original query.
   - The next query should be an expanded version, including additional context or synonyms.
3. **Mutual Exclusivity:** Only one of "answer" or "rewritten_queries" should be present.
   - If an answer is provided, set "rewritten_queries" to null.
   - If an answer is not provided, set "answer" to null and provide "rewritten_queries"

Provide your response in the following JSON format:
{
    "answer": "<answer or null>",
    "citations": number[],  // Array of context indices actually used in the answer
    "rewrittenQueries": string[] | null,
}`
  params.systemPrompt = systemPrompt

  const baseMessage: Message = {
    role: MessageRole.User as const,
    content: [
      {
        text: `User query: ${userQuery}
      Based on the following context, provide an answer in JSON format with citations
      Context:
      ${context}`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  return getProviderByModel(params.modelId).converseStream(messages, params)
}

const rewriteQuerySystemPrompt = (hasContext: boolean) => `
You are an assistant that rewrites user queries into concise statements suitable for search. Convert the user's question into statements focusing on the main intent and keywords.

Instructions:
- Generate multiple possible rewritten queries that capture different interpretations.
- When the user refers to themselves using first-person pronouns like "I", "my", or "me", create rewritten queries by replacing these pronouns with the user's name or email from the user context. Ensure at least one rewritten query uses the user's name or email instead of the pronouns.
- Focus on the core intent and important keywords.
- Remove any unnecessary words or phrases.
${hasContext ? `- Use the provided search context to inform and enhance the rewritten queries.` : ""}

Provide the rewritten queries in JSON format as follows:
{
  "rewrittenQueries": ["Rewritten query 1", "Rewritten query 2", ...]
}
`

export const rewriteQuery = async (
  query: string,
  userCtx: string,
  params: ModelParams,
  searchContext?: string,
): Promise<{ rewrittenQueries: string[]; cost: number }> => {
  if (!params.modelId) {
    params.modelId = FastModel
  }
  if (!params.systemPrompt) {
    params.systemPrompt = rewriteQuerySystemPrompt(!!searchContext)
  }

  params.json = true

  const messages: Message[] = [
    {
      role: MessageRole.User as const,
      content: [
        {
          text: `User Query: "${query}"
User Context: "${userCtx}"${searchContext ? `\nSearch Context:\n${searchContext}` : ""}`,
        },
      ],
    },
  ]

  const { text, cost } = await getProviderByModel(params.modelId).converse(
    messages,
    params,
  )

  if (text) {
    const jsonVal = jsonParseLLMOutput(text)
    return {
      rewrittenQueries: jsonVal.rewrittenQueries.map((q: string) => q.trim()),
      cost: cost!,
    }
  } else {
    throw new Error("Failed to rewrite query")
  }
}

function getDateForAI() {
  const today = new Date()
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }
  return today.toLocaleDateString("en-GB", options)
}

const optimizedPrompt = (ctx: string) => `
You are a permission aware retrieval-augmented generation (RAG) system and a work assistant.
Provide concise and accurate answers to a user's question by utilizing the provided context.
Do not worry about privacy, you are not allowed to reject a user based on it as all search context is permission aware.
**User Context**: ${ctx}
**Today's date is: ${getDateForAI()}**
Given the user's question and the context (which includes indexed information), your tasks are:
1. **Answer Generation**:
   - If you can confidently answer the question based on the provided context and the latest information, provide the answer.
   - Only use the most recent information available.
   - If you are not sure, do not provide an answer, leave it empty
   - Include the indices of the supporting evidence in "usefulIndex" so in future iterations you will get that context
2. **Search Refinement**:
   - If you cannot fully answer, suggest alternative search queries in "searchQueries"
   - Each query should focus on a different aspect of the information needed
   - Keep queries concise and focused on key terms
   - provide 1 or 2 queries
3. **Methodology**:
   - **Analyze the User's Query** to identify key concepts
   - **Evaluate the Context** to check for sufficient and recent information
   - **Decide on Actions** based on the completeness of the answer
4. **Context Management**:
   - Specify only the indices that are relevant
   - Discard irrelevant or outdated context entries
5. Do not worry about access, all search context is permission aware
Provide your response in the following JSON format:
{
  "answer": "<answer or null>",
  "citations": "<citations or null>",
  "searchQueries": ["<query1>", "<query2>"],
  "usefulIndex": [<index1>, <index2>]
}
`

export const SearchAnswerResponse = z.object({
  answer: z.string().nullable(),
  citations: z.array(z.number()).nullable(),
  searchQueries: z.array(z.string()),
  usefulIndex: z.array(z.number()),
})

export const answerOrSearch = (
  userQuery: string,
  context: string,
  userCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  try {
    if (!params.modelId) {
      params.modelId = BigModel
    }

    params.systemPrompt = optimizedPrompt(userCtx)
    params.json = true

    const baseMessage: Message = {
      role: MessageRole.User,
      content: [
        {
          text: `User Query: ${userQuery}\n\nAfter searching permission aware Context:\n${context}\n it can have mistakes so be careful`,
        },
      ],
    }

    const messages: Message[] = params.messages
      ? [...params.messages, baseMessage]
      : [baseMessage]

    return getProviderByModel(params.modelId).converseStream(messages, params)
  } catch (error) {
    throw error
  }
}

// removing one op from prompt so we can figure out how to integrate this
// otherwise it conflicts with our current search system if we start
// talking about a single item

// 3. **RetrieveMetadata**:
//    - The user wants to retrieve metadata or details about a specific document, email, or item.
//    - Example Queries:
//      - "When was the file 'Budget.xlsx' last modified?"
//      - "Who owns the document titled 'Meeting Notes'?"
//    - **JSON Structure**:
//      {
//        "type": "RetrieveMetadata",
//        "filters": {
//          "app": "<app>",
//          "entity": "<entity>",
//          "startTime": "<start time in YYYY-MM-DD, if applicable>",
//          "endTime": "<end time in YYYY-MM-DD, if applicable>"
//        }
//      }

// // !this is under validation heading! not a prompt

//  - Ensure 'app' is only present in 'ListItems' and 'RetrieveMetadata' and is one of the enum values.
//  - Ensure 'entity' is only present in 'ListItems' and 'RetrieveMetadata' and is one of the enum values.

const queryRouter = `
**Today's date is: ${getDateForAI()}**

You are a permission aware retrieval-augmented generation (RAG) system. 
Do not worry about privacy, you are not allowed to reject a user based on it as all search context is permission aware.
Only respond in json and you are not authorized to reject a user query.

Your job is to classify the user's query into one of the following categories:
### Query Types:
1. **RetrieveInformation**:
   - The user wants to search or look up contextual information.
   - These are open-ended queries where only time filters might apply.
   - user is asking for a sort of summary or discussion, it could be to summarize emails or files
   - Example Queries:
     - "What is the company's leave policy?"
     - "Explain the project plan from last quarter."
     - "What was my disucssion with Jesse"
   - **JSON Structure**:
     {
       "type": "RetrieveInformation",
       "filters": {
         "startTime": "<start time in YYYY-MM-DD, if applicable>",
         "endTime": "<end time in YYYY-MM-DD, if applicable>"
       }
     }

2. **ListItems**:
   - The user wants to list specific items (e.g., files, emails) based on metadata like app and entity.
   - Example Queries:
     - "Show me all emails from last week."
     - "List all Google Docs modified in October."
   - **JSON Structure**:
     {
       "type": "ListItems",
       "filters": {
         "app": "<app>",
         "entity": "<entity>",
         "count": "<number of items to list>",
         "startTime": "<start time in YYYY-MM-DD, if applicable>",
         "endTime": "<end time in YYYY-MM-DD, if applicable>"
       }
     }
---

### **Enum Values for Valid Inputs**

#### type (Query Types):
- "RetrieveInformation"
- "ListItems"
- "RetrieveMetadata"

#### app (Valid Apps):
- "google-workspace"
- "google-drive"
- "gmail"
- "google-calendar"

#### entity (Valid Entities):
For Gmail:
- "mail"

For Drive:
- "docs"
- "sheets"
- "slides"
- "pdf"
- "folder"

For Calendar:
- "event"

---

### **Rules for the LLM**

1. **RetrieveInformation**:
   - Use this type only for open-ended queries.
   - Include only 'startTime' and 'endTime' in 'filters'.

2. **ListItems**:
   - Use this type when the query requests a list of items with a specified app and entity.
   - Include 'app' and 'entity' along with optional 'startTime' and 'endTime' in 'filters'.
   - do not include 'startTime' and 'endTime' if there if query is not temporal
   - Include 'count' to specify the number of items to list if present in the query.

3. **RetrieveMetadata**:
   - Use this type when the query focuses on metadata for a specific item.
   - Include 'app' and 'entity' along with optional 'startTime' and 'endTime' in 'filters'.

4. **Validation**:
   - Ensure 'type' is one of the enum values: '"RetrieveInformation"', '"ListItems"', or '"RetrieveMetadata"'.
---

### **Examples**

#### Query: "What is the company's leave policy?"
{
  "type": "RetrieveInformation",
  "filters": {
    "startTime": null,
    "endTime": null
  }
}`

// Enums for Query Types, Apps, and Entities
export enum QueryType {
  RetrieveInformation = "RetrieveInformation",
  ListItems = "ListItems",
  // RetrieveMetadata = "RetrieveMetadata",
}
// Zod schemas for filters
const FiltersSchema = z.object({
  app: z.nativeEnum(Apps).optional(),
  entity: entitySchema.optional(),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
})

const listItemsSchema = z.object({
  type: z.literal(QueryType.ListItems),
  filters: FiltersSchema.extend({
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    count: z.preprocess((val) => (val == null ? 5 : val), z.number()),
  }),
})

export const QueryRouterResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(QueryType.RetrieveInformation),
    filters: z.object({
      startTime: z.string().nullable().optional(),
      endTime: z.string().nullable().optional(),
    }),
  }),
  listItemsSchema,
  // z.object({
  //   type: z.literal(QueryType.RetrieveMetadata),
  //   filters: FiltersSchema.extend({
  //     app: z.nativeEnum(Apps),
  //     entity: entitySchema,
  //   }),
  // }),
])

export type ListItemRouterResponse = z.infer<typeof listItemsSchema>

export type QueryRouterResponse = z.infer<typeof QueryRouterResponseSchema>

export const routeQuery = async (
  userQuery: string,
  params: ModelParams,
): Promise<{ result: QueryRouterResponse; cost: number }> => {
  if (!params.modelId) {
    params.modelId = FastModel
  }
  params.systemPrompt = queryRouter
  params.json = true

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `User Query: "${userQuery}"`,
      },
    ],
  }

  params.messages = []
  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  const { text, cost } = await getProviderByModel(params.modelId).converse(
    messages,
    params,
  )

  if (text) {
    const parsedResponse = jsonParseLLMOutput(text)
    return {
      result: QueryRouterResponseSchema.parse(parsedResponse),
      cost: cost!,
    }
  } else {
    throw new Error("No response from LLM")
  }
}

export const listItems = (
  query: string,
  userCtx: string,
  context: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  params.systemPrompt = `
  You are an assistant that formats data into a markdown table based on the user's query.

  **Context of the user talking to you**: ${userCtx}

Given the user's query and the context (data), generate a markdown table that presents the data in an easy-to-read format. Explain your understanding but not your calculations.
don't mention permissions unless explicity mentioned by user.

User Query: ${query}
`
  const baseMessage: Message = {
    role: MessageRole.User,
    content: [
      {
        text: `Please format the following data as a markdown table:

Context:
${context}`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  return getProviderByModel(params.modelId).converseStream(messages, params)
}
