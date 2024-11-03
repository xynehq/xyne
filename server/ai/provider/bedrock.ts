import llama3Tokenizer from "llama3-tokenizer-js"
import ollama from "ollama"
import {
  BedrockRuntimeClient,
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

export enum Models {
  Llama_3_2_1B = "us.meta.llama3-2-1b-instruct-v1:0",
  Llama_3_2_3B = "us.meta.llama3-2-3b-instruct-v1:0",
  Llama_3_1_70B = "meta.llama3-1-70b-instruct-v1:0",
  Llama_3_1_8B = "meta.llama3-1-8b-instruct-v1:0",
  Llama_3_1_405B = "meta.llama3-1-405b-instruct-v1:0",
  Gpt_4o = "gpt-4o",
  Gpt_4o_mini = "gpt-4o-mini",
}

type Cost = {
  pricePerThousandInputTokens: number
  pricePerThousandOutputTokens: number
}

export const modelDetailsMap: Record<
  string,
  { name: string; cost: { onDemand: Cost; batch: Cost } }
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

interface ConverseResponse {
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
      yield {
        text: chunk.choices[0].delta.content!,
        metadata: chunk.choices[0].finish_reason,
        cost,
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
  apiKey: OpenAIKey, // This is the default and can be omitted
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

    // Attempt to parse the response as JSON
    let structuredResponse
    try {
      structuredResponse = JSON.parse(fullResponse.trim())
    } catch (parseError) {
      // try against backticks
      // a lot of the times the json is in ```
      // TODO: check with startOf before hand itself to prevent doing this in catch only
      try {
        structuredResponse = JSON.parse(
          fullResponse.trim().split("```")[1].trim(),
        )
      } catch (parseError) {
        try {
          structuredResponse = JSON.parse(
            fullResponse.trim().split("```json")[1].split("```")[0].trim(),
          )
        } catch (parseError) {
          console.error("Error parsing structured response:", parseError)
          // Handle parsing error or return the raw response
          throw parseError
        }
      }
    }

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
    // Attempt to parse the response as JSON
    let structuredResponse
    try {
      structuredResponse = JSON.parse(text.trim())
    } catch (parseError) {
      // try against backticks
      // a lot of the times the json is in ```
      // TODO: check with startOf before hand itself to prevent doing this in catch only
      try {
        structuredResponse = JSON.parse(text.trim().split("```")[1].trim())
      } catch (parseError) {
        try {
          structuredResponse = JSON.parse(
            text.trim().split("```json")[1].split("```")[0].trim(),
          )
        } catch (parseError) {
          console.error("Error parsing structured response:", parseError)
          // Handle parsing error or return the raw response
          throw parseError
        }
      }
    }

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

  const { text, cost } = await getProviderByModel(params.modelId).converse(
    messages,
    params,
  )

  if (text) {
    let jsonVal
    try {
      jsonVal = JSON.parse(text.trim())
    } catch (e) {
      try {
        jsonVal = JSON.parse(text.trim().split("```")[1].trim())
      } catch (parseError) {
        try {
          jsonVal = JSON.parse(
            text.trim().split("```json")[1].split("```")[0].trim(),
          )
        } catch (parseError) {
          console.error("Error parsing structured response:", parseError)
          // Handle parsing error or return the raw response
          throw parseError
        }
      }
    }
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
