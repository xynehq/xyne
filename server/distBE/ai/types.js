import {} from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { Apps, entitySchema } from "../search/types.js"
export var AIProviders;
(function (AIProviders) {
    AIProviders["OpenAI"] = "openai";
    AIProviders["AwsBedrock"] = "bedrock";
    AIProviders["Ollama"] = "ollama";
    AIProviders["Together"] = "together-ai";
    AIProviders["Fireworks"] = "fireworks";
    AIProviders["GoogleAI"] = "google-ai";
})(AIProviders || (AIProviders = {}));
export var Models;
(function (Models) {
    Models["Llama_3_2_1B"] = "us.meta.llama3-2-1b-instruct-v1:0";
    Models["Llama_3_2_3B"] = "us.meta.llama3-2-3b-instruct-v1:0";
    Models["Llama_3_1_70B"] = "meta.llama3-1-70b-instruct-v1:0";
    Models["Llama_3_1_8B"] = "meta.llama3-1-8b-instruct-v1:0";
    Models["Llama_3_1_405B"] = "meta.llama3-1-405b-instruct-v1:0";
    // Bedrock_Claude = "",
    Models["Gpt_4o"] = "gpt-4o";
    Models["Gpt_4o_mini"] = "gpt-4o-mini";
    Models["Gpt_4"] = "gpt-4";
    Models["CohereCmdRPlus"] = "cohere.command-r-plus-v1:0";
    Models["CohereCmdR"] = "cohere.command-r-v1:0";
    Models["Claude_3_5_SonnetV2"] = "us.anthropic.claude-3-5-sonnet-20241022-v2:0";
    Models["Claude_3_7_Sonnet"] = "us.anthropic.claude-3-7-sonnet-20250219-v1:0";
    Models["Claude_3_5_Sonnet"] = "anthropic.claude-3-5-sonnet-20240620-v1:0";
    Models["Claude_3_5_Haiku"] = "anthropic.claude-3-5-haiku-20241022-v1:0";
    Models["Amazon_Nova_Micro"] = "amazon.nova-micro-v1:0";
    Models["Amazon_Nova_Lite"] = "amazon.nova-lite-v1:0";
    Models["Amazon_Nova_Pro"] = "amazon.nova-pro-v1:0";
    Models["DeepSeek_R1"] = "us.deepseek.r1-v1:0";
    Models["Mistral_Large"] = "mistral.mistral-large-2402-v1:0";
})(Models || (Models = {}));
export var QueryCategory;
(function (QueryCategory) {
    QueryCategory["Self"] = "Self";
    QueryCategory["InternalPerson"] = "InternalPerson";
    QueryCategory["ExternalPerson"] = "ExternalPerson";
    QueryCategory["Other"] = "Other";
})(QueryCategory || (QueryCategory = {}));
// Enums for Query Types, Apps, and Entities
export var QueryType;
(function (QueryType) {
    QueryType["RetrieveInformation"] = "RetrieveInformation";
    QueryType["ListItems"] = "ListItems";
    // RetrieveMetadata = "RetrieveMetadata",
})(QueryType || (QueryType = {}));
export const QueryAnalysisSchema = z.object({
    category: z.nativeEnum(QueryCategory),
    mentionedNames: z.array(z.string()),
    mentionedEmails: z.array(z.string()),
});
export const initialResultsOrRewriteSchema = z.object({
    answer: z.string().optional(),
    citations: z.array(z.number()),
    rewrittenQueries: z.array(z.string()).optional(),
});
export const SearchAnswerResponse = z.object({
    answer: z.string().nullable(),
    citations: z.array(z.number()).nullable(),
    searchQueries: z.array(z.string()),
    usefulIndex: z.array(z.number()),
});
// Zod schemas for filters
export const FiltersSchema = z.object({
    app: z.nativeEnum(Apps).optional(),
    entity: entitySchema.optional(),
    startTime: z.string().nullable().optional(),
    endTime: z.string().nullable().optional(),
});
export const listItemsSchema = z.object({
    type: z.literal(QueryType.ListItems),
    filters: FiltersSchema.extend({
        app: z.nativeEnum(Apps),
        entity: entitySchema,
        count: z.preprocess((val) => (val == null ? 5 : val), z.number()),
    }),
});
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
]);
export const QueryContextRank = z.object({
    canBeAnswered: z.boolean(),
    contextualChunks: z.array(z.number()),
});
