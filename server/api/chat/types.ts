import config from "@/config"
import { messageFeedbackEnum } from "@/db/schema"
import { Apps, entitySchema, type Entity } from "@/search/types"
import type { Span } from "@/tracer"
import { z } from "zod"

const {
  JwtPayloadKey,
  chatHistoryPageSize,
  defaultBestModel,
  defaultFastModel,
  maxDefaultSummary,
  chatPageSize,
  isReasoning,
  fastModelReasoning,
  StartThinkingToken,
  EndThinkingToken,
  maxValidLinks,
} = config
// this is not always the case but unless our router detects that we need
// these we will by default remove them
const nonWorkMailLabels = ["CATEGORY_UPDATES", "CATEGORY_PROMOTIONS"]

export enum RagPipelineStages {
  QueryRouter = "QueryRouter",
  NewChatTitle = "NewChatTitle",
  AnswerOrSearch = "AnswerOrSearch",
  AnswerWithList = "AnswerWithList",
  AnswerOrRewrite = "AnswerOrRewrite",
  RewriteAndAnswer = "RewriteAndAnswer",
  UserChat = "UserChat",
  DefaultRetrieval = "DefaultRetrieval",
}

export const ragPipelineConfig = {
  [RagPipelineStages.QueryRouter]: {
    modelId: defaultFastModel,
    reasoning: fastModelReasoning,
  },
  [RagPipelineStages.AnswerOrSearch]: {
    modelId: defaultBestModel, //defaultBestModel,
    reasoning: fastModelReasoning,
  },
  [RagPipelineStages.AnswerWithList]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.NewChatTitle]: {
    modelId: defaultFastModel,
  },
  [RagPipelineStages.AnswerOrRewrite]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.RewriteAndAnswer]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.UserChat]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.DefaultRetrieval]: {
    modelId: defaultBestModel,
    page: 5,
  },
}

export const MinimalCitationSchema = z.object({
  docId: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  app: z.nativeEnum(Apps),
  entity: entitySchema,
  threadId: z.string().optional(),
})

export type Citation = z.infer<typeof MinimalCitationSchema>

export interface MinimalAgentFragment {
  id: string // Unique ID for the fragment
  content: string
  source: Citation
  confidence: number
}

export const messageFeedbackSchema = z.object({
  messageId: z.string(),
  feedback: z.enum(messageFeedbackEnum.enumValues).nullable(), // Allows 'like', 'dislike', or null
})

export interface AgentTool {
  name: string
  description: string
  parameters: Record<
    string,
    {
      type: string
      description: string
      required: boolean
    }
  >
  execute: (
    params: any,
    span?: Span,
    email?: string,
    userCtx?: string,
    agentPrompt?: string,
    userMessage?: string,
  ) => Promise<{
    result: string // Human-readable summary of action/result
    contexts?: MinimalAgentFragment[] // Data fragments found
    error?: string // Error message if failed
  }>
}

export interface PaginationParameters {
  limit?: number
  offset?: number
  order_direction?: "asc" | "desc"
}

export interface FilterParameters {
  filter_query: string
  excludedIds?: string[]
}

export interface DateRangeParameters {
  from?: string
  to?: string
}

export interface SlackChannelUserParameters {
  channel_name?: string
  user_email?: string
}

export interface AppEntityParameters {
  app?: Apps
  entity?: Entity
}
export interface SearchParameters
  extends PaginationParameters,
    FilterParameters,
    AppEntityParameters {
  filter_query: string
  from: string
  to: string
}

export type MinimalSearchParameters = Pick<
  SearchParameters,
  "filter_query" | "limit"
>

export interface FilteredSearchParameters
  extends PaginationParameters,
    FilterParameters,
    AppEntityParameters {}

export interface MetadataRetrievalParameters
  extends PaginationParameters,
    FilterParameters,
    AppEntityParameters {
  item_type: string
}

export interface UserInfoParameters {}

export interface GetSlackThreadsParameters
  extends PaginationParameters,
    FilterParameters {}

export interface GetSlackMessagesFromUserParameters
  extends PaginationParameters,
    FilterParameters,
    DateRangeParameters,
    Pick<SlackChannelUserParameters, "channel_name"> {
  user_email: string
}

export interface GetSlackRelatedMessagesParameters
  extends PaginationParameters,
    FilterParameters,
    DateRangeParameters,
    SlackChannelUserParameters {}

export interface GetUserSlackProfileParameters {
  user_email: string
}

export interface GetSlackMessagesFromChannelParameters
  extends PaginationParameters,
    FilterParameters,
    DateRangeParameters,
    Pick<SlackChannelUserParameters, "user_email"> {
  channel_name: string
}

export interface GetSlackMessagesFromTimeRangeParameters
  extends PaginationParameters,
    FilterParameters,
    DateRangeParameters,
    SlackChannelUserParameters {
  date_from: string
  date_to: string
}
// Unified context for holding all types of IDs referenced by the user
export interface UserReferencedIds {
  fileIds: string[]
  threadIds: string[]
  channelIds: string[]
  extractedLinkFileCount?: number
}
