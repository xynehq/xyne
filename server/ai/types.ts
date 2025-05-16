import { type Message } from "@aws-sdk/client-bedrock-runtime"
import { z } from "zod"
import { Apps, entitySchema } from "@/search/types"

export enum AIProviders {
  OpenAI = "openai",
  AwsBedrock = "bedrock",
  Ollama = "ollama",
  Together = "together-ai",
  Fireworks = "fireworks",
  GoogleAI = "google-ai",
}

export enum Models {
  Llama_3_2_1B = "us.meta.llama3-2-1b-instruct-v1:0",
  Llama_3_2_3B = "us.meta.llama3-2-3b-instruct-v1:0",
  Llama_3_1_70B = "meta.llama3-1-70b-instruct-v1:0",
  Llama_3_1_8B = "meta.llama3-1-8b-instruct-v1:0",
  Llama_3_1_405B = "meta.llama3-1-405b-instruct-v1:0",
  // Bedrock_Claude = "",
  Gpt_4o = "gpt-4o",
  Gpt_4o_mini = "gpt-4o-mini",
  Gpt_4 = "gpt-4",
  Gpt_4_1 = "gpt-4.1-2025-04-14",

  CohereCmdRPlus = "cohere.command-r-plus-v1:0",
  CohereCmdR = "cohere.command-r-v1:0",
  Claude_3_5_SonnetV2 = "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
  Claude_3_7_Sonnet = "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
  Claude_3_5_Sonnet = "anthropic.claude-3-5-sonnet-20240620-v1:0",
  Claude_3_5_Haiku = "anthropic.claude-3-5-haiku-20241022-v1:0",
  Amazon_Nova_Micro = "amazon.nova-micro-v1:0",
  Amazon_Nova_Lite = "amazon.nova-lite-v1:0",
  Amazon_Nova_Pro = "amazon.nova-pro-v1:0",

  DeepSeek_R1 = "us.deepseek.r1-v1:0",
  Mistral_Large = "mistral.mistral-large-2402-v1:0",
  Gemini_2_5_Pro_Preview = "gemini-2.5-pro-preview-03-25", // Added new Gemini model
}

// New Enum for UI-friendly model names
// The keys should ideally mirror the keys in the Models enum for consistency
export enum FriendlyModelUIName {
  Llama_3_2_1B = "Llama 3.2 1B",
  Llama_3_2_3B = "Llama 3.2 3B",
  Llama_3_1_70B = "Llama 3.1 70B",
  Llama_3_1_8B = "Llama 3.1 8B",
  Llama_3_1_405B = "Llama 3.1 405B",
  Gpt_4o = "GPT-4o",
  Gpt_4o_mini = "GPT-4o Mini",
  Gpt_4 = "GPT-4",
  Gpt_4_1 = "GPT-4.1",
  CohereCmdRPlus = "Cohere Command R+",
  CohereCmdR = "Cohere Command R",
  Claude_3_5_SonnetV2 = "Claude 3.5 Sonnet v2", // Specific to us.anthropic.claude-3-5-sonnet-20241022-v2:0
  Claude_3_7_Sonnet = "Claude 3.7 Sonnet",     // Specific to us.anthropic.claude-3-7-sonnet-20250219-v1:0
  Claude_3_5_Sonnet = "Claude 3.5 Sonnet",     // Specific to anthropic.claude-3-5-sonnet-20240620-v1:0
  Claude_3_5_Haiku = "Claude 3.5 Haiku",
  Amazon_Nova_Micro = "Amazon Nova Micro",
  Amazon_Nova_Lite = "Amazon Nova Lite",
  Amazon_Nova_Pro = "Amazon Nova Pro",
  DeepSeek_R1 = "DeepSeek R1",
  Mistral_Large = "Mistral Large",
  Gemini_2_5_Pro_Preview = "Gemini 2.5 Pro Preview", // Added new Gemini friendly name
}

// Type for the actual model ID strings (values from the Models enum)
export type ModelId = `${Models}`;

// Type for the friendly UI name strings (values from the FriendlyModelUIName enum)
export type FrontendModelNameString = `${FriendlyModelUIName}`;

// Map from actual ModelId (string) to FriendlyModelNameString
export const ModelIdToFriendlyNameMap: Record<ModelId, FrontendModelNameString> = {
  [Models.Llama_3_2_1B]: FriendlyModelUIName.Llama_3_2_1B,
  [Models.Llama_3_2_3B]: FriendlyModelUIName.Llama_3_2_3B,
  [Models.Llama_3_1_70B]: FriendlyModelUIName.Llama_3_1_70B,
  [Models.Llama_3_1_8B]: FriendlyModelUIName.Llama_3_1_8B,
  [Models.Llama_3_1_405B]: FriendlyModelUIName.Llama_3_1_405B,
  [Models.Gpt_4o]: FriendlyModelUIName.Gpt_4o,
  [Models.Gpt_4o_mini]: FriendlyModelUIName.Gpt_4o_mini,
  [Models.Gpt_4]: FriendlyModelUIName.Gpt_4,
  [Models.CohereCmdRPlus]: FriendlyModelUIName.CohereCmdRPlus,
  [Models.CohereCmdR]: FriendlyModelUIName.CohereCmdR,
  [Models.Gpt_4_1]: FriendlyModelUIName.Gpt_4_1,
  [Models.Claude_3_5_SonnetV2]: FriendlyModelUIName.Claude_3_5_SonnetV2,
  [Models.Claude_3_7_Sonnet]: FriendlyModelUIName.Claude_3_7_Sonnet,
  [Models.Claude_3_5_Sonnet]: FriendlyModelUIName.Claude_3_5_Sonnet,
  [Models.Claude_3_5_Haiku]: FriendlyModelUIName.Claude_3_5_Haiku,
  [Models.Amazon_Nova_Micro]: FriendlyModelUIName.Amazon_Nova_Micro,
  [Models.Amazon_Nova_Lite]: FriendlyModelUIName.Amazon_Nova_Lite,
  [Models.Amazon_Nova_Pro]: FriendlyModelUIName.Amazon_Nova_Pro,
  [Models.DeepSeek_R1]: FriendlyModelUIName.DeepSeek_R1,
  [Models.Mistral_Large]: FriendlyModelUIName.Mistral_Large,
  [Models.Gemini_2_5_Pro_Preview]: FriendlyModelUIName.Gemini_2_5_Pro_Preview, // Added mapping for new Gemini model
};

// Map from FriendlyModelNameString back to actual ModelId (string)
export const FriendlyNameToModelIdMap = Object.fromEntries(
  Object.entries(ModelIdToFriendlyNameMap).map(([id, name]) => [name, id as ModelId])
) as Record<FrontendModelNameString, ModelId>;

export enum QueryCategory {
  Self = "Self",
  InternalPerson = "InternalPerson",
  ExternalPerson = "ExternalPerson",
  Other = "Other",
}

// Enums for Query Types, Apps, and Entities
export enum QueryType {
  RetrieveInformation = "RetrieveInformation",
  RetrievedUnspecificMetadata = "RetrievedUnspecificMetadata",
  RetrieveMetadata = "RetrieveMetadata",
}

export type Cost = {
  pricePerThousandInputTokens: number
  pricePerThousandOutputTokens: number
}

export type TimeDirection = "next" | "prev" | null
export interface TemporalClassifier {
  direction: TimeDirection | null
}

export interface ModelParams {
  max_new_tokens?: number
  top_p?: number
  temperature?: number
  modelId: ModelId // Changed from Models to ModelId
  systemPrompt?: string
  prompt?: string
  userCtx?: string
  stream: boolean
  json?: boolean
  messages?: Message[]
  reasoning?: boolean
}

export interface ConverseResponse {
  text?: string
  metadata?: any
  cost?: number
  reasoning?: boolean
}

export interface LLMProvider {
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

export interface AnswerResponse {
  answer: string | null
}

export const QueryAnalysisSchema = z.object({
  category: z.nativeEnum(QueryCategory),
  mentionedNames: z.array(z.string()),
  mentionedEmails: z.array(z.string()),
})

export type QueryAnalysisResult = z.infer<typeof QueryAnalysisSchema>

export const initialResultsOrRewriteSchema = z.object({
  answer: z.string().optional(),
  citations: z.array(z.number()),
  rewrittenQueries: z.array(z.string()).optional(),
})

export type ResultsOrRewrite = z.infer<typeof initialResultsOrRewriteSchema>

export const SearchAnswerResponse = z.object({
  answer: z.string().nullable(),
  citations: z.array(z.number()).nullable(),
  searchQueries: z.array(z.string()),
  usefulIndex: z.array(z.number()),
})

// Zod schemas for filters
export const FiltersSchema = z.object({
  app: z.nativeEnum(Apps).optional(),
  entity: entitySchema.optional(),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
})

export const RetrievedUnspecificMetadataSchema = z.object({
  type: z.literal(QueryType.RetrievedUnspecificMetadata),
  filters: FiltersSchema.extend({
    count: z.preprocess((val) => (val == null ? 5 : val), z.number()),
    sortDirection: z.string().optional(),
  }),
})

export const RetrieveMetadataSchema = z.object({
  type: z.literal(QueryType.RetrieveMetadata),
  filters: FiltersSchema.extend({
    count: z.preprocess((val) => (val == null ? 5 : val), z.number()),
  }),
})

export const QueryRouterResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(QueryType.RetrieveInformation),
    filters: FiltersSchema,
  }),
  RetrieveMetadataSchema,
  RetrievedUnspecificMetadataSchema,
])

export const QueryContextRank = z.object({
  canBeAnswered: z.boolean(),
  contextualChunks: z.array(z.number()),
})

export type QueryContextRank = z.infer<typeof QueryContextRank>

// export type ListItemRouterResponse = z.infer<typeof listItemsSchema>

export type QueryRouterResponse = z.infer<typeof QueryRouterResponseSchema>
