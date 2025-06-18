import metricRegister from "@/metrics/sharedRegistry"
import { Counter, Histogram } from "prom-client"

// Count of the total number of teams ingested
export const ingestedTeamTotalCount = new Counter({
  name: "ingested_team_total_count",
  help: "Total number of teams ingested in slack",
  labelNames: ["email_domain", "status", "enterprise_id", "domain"],
})

metricRegister.registerMetric(ingestedTeamTotalCount)

export const ingestedMembersTotalCount = new Counter({
  name: "ingested_member_total_count",
  help: "Total Number of members ingested in slack",
  labelNames: ["team_id", "status"],
})

metricRegister.registerMetric(ingestedMembersTotalCount)

export const insertChannelMessagesCount = new Counter({
  name: "insert_channel_message_count",
  help: "Number of times insert chanel messages was invoked",
  labelNames: ["conversation_id", "status", "team_id", "email"],
})

metricRegister.registerMetric(insertChannelMessagesCount)

export const insertConversationCount = new Counter({
  name: "insert_conversation_count",
  help: "Number of times insert conversation was invoked",
  labelNames: ["conversation_id", "status", "team_id", "member_count", "email"],
})

metricRegister.registerMetric(insertConversationCount)

export const insertChatMessagesCount = new Counter({
  name: "insert_chat_message_count",
  help: "Number chat messages ingested",
  labelNames: ["conversation_id", "status", "team_id", "email"],
})

metricRegister.registerMetric(insertChatMessagesCount)

export const insertConversationDuration = new Histogram({
  name: "conversation_insertion_duration",
  help: "Time taken to insert a conversation",
  labelNames: ["conversation_id", "status", "team_id"],
})

metricRegister.registerMetric(insertConversationDuration)

export const insertChannelMessageDuration = new Histogram({
  name: "channel_message_insertion_duration",
  help: "Time taken to insert a channel message",
  labelNames: ["conversation_id", "status", "team_id"],
})

metricRegister.registerMetric(insertChannelMessageDuration)

export const ingestedTeamErrorTotalCount = new Counter({
  name: "ingested_team_error_total_count",
  help: "Total number of teams ingested in slack errors",
  labelNames: ["email_domain", "status", "enterprise_id", "domain", "email"],
})

metricRegister.registerMetric(ingestedTeamErrorTotalCount)

export const ingestedMembersErrorTotalCount = new Counter({
  name: "ingested_member_error_total_count",
  help: "Total Number of members ingested in slack errors",
  labelNames: ["team_id", "status"],
})

metricRegister.registerMetric(ingestedMembersErrorTotalCount)

export const insertConversationErrorCount = new Counter({
  name: "insert_conversation_error_count",
  help: "Number of times insert conversation was invoked and had errors",
  labelNames: ["conversation_id", "status", "team_id", "member_count", "email"],
})

metricRegister.registerMetric(insertConversationErrorCount)

export const insertChannelMessagesErrorCount = new Counter({
  name: "insert_channel_message_error_count",
  help: "Number of times insert chanel messages was invoked and had errors",
  labelNames: ["conversation_id", "status", "team_id", "email"],
})

metricRegister.registerMetric(insertChannelMessagesErrorCount)

export const totalConversationsToBeInserted = new Counter({
  name: "total_conversation_inserted_count",
  help: "Count of total number of conversations inserted",
  labelNames: ["team_id", "email"],
})

metricRegister.registerMetric(totalConversationsToBeInserted)

export const totalChatToBeInsertedCount = new Counter({
  name: "total_chat_to_be_inserted",
  help: "Total number of chats to be inserted",
  labelNames: ["conversation_id", "email"],
})

metricRegister.registerMetric(totalChatToBeInsertedCount)

export const totalConversationsSkipped = new Counter({
  name: "total_conversation_skipped_count",
  help: "Count of number of conversations that was skipped out of the total conversations extracted",
  labelNames: ["team_id", "email", "status"],
})

metricRegister.registerMetric(totalConversationsSkipped)

export const allConversationsInTotal = new Counter({
  name: "total_convesations_extracted_count",
  help: "Total Count of Conversations that the user is a part of",
  labelNames: ["team_id", "email", "status"],
})

metricRegister.registerMetric(allConversationsInTotal)
