import { z } from "zod"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionContext, ToolExecutionResult } from "./types"

// Slack tool configuration schema
export const slackConfigSchema = z.object({
  webhookUrl: z.string().url().optional(),
  channel: z.string().optional(),
  username: z.string().default("Workflow Bot"),
  iconEmoji: z.string().default(":robot_face:"),
  messageTemplate: z.string().optional(),
  mentionUsers: z.array(z.string()).default([]),
  mentionChannels: z.array(z.string()).default([]),
  attachments: z.boolean().default(false),
})

// Slack tool input schema
export const slackInputSchema = z.object({
  message: z.string().optional(),
  channelOverride: z.string().optional(),
  messageData: z.record(z.string(), z.any()).optional(),
  attachmentData: z.any().optional(),
})

// Slack tool output schema
export const slackOutputSchema = z.object({
  messageSent: z.boolean(),
  channel: z.string(),
  messageText: z.string(),
  timestamp: z.string().optional(),
  error: z.string().optional(),
  messageLength: z.number(),
})

export type SlackConfig = z.infer<typeof slackConfigSchema>
export type SlackInput = z.infer<typeof slackInputSchema>
export type SlackOutput = z.infer<typeof slackOutputSchema>

// Helper function to format message with mentions
const formatSlackMessage = (
  message: string,
  mentionUsers: string[],
  mentionChannels: string[]
): string => {
  let formattedMessage = message

  // Add user mentions
  if (mentionUsers.length > 0) {
    const userMentions = mentionUsers.map(user => `<@${user}>`).join(" ")
    formattedMessage = `${userMentions} ${formattedMessage}`
  }

  // Add channel mentions
  if (mentionChannels.length > 0) {
    const channelMentions = mentionChannels.map(channel => `<#${channel}>`).join(" ")
    formattedMessage = `${channelMentions} ${formattedMessage}`
  }

  return formattedMessage
}

export class SlackTool implements WorkflowTool<SlackConfig, SlackInput, SlackOutput> {
  type = ToolType.SLACK
  category = ToolCategory.ACTION

  async execute(
    input: SlackInput,
    config: SlackConfig,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<SlackOutput>> {
    try {
      if (!config.webhookUrl) {
        return {
          status: "error",
          result: {
            messageSent: false,
            channel: config.channel || "unknown",
            messageText: "",
            messageLength: 0,
            error: "No Slack webhook URL configured",
          } as SlackOutput,
        }
      }

      // Determine message content
      let messageText = input.message || config.messageTemplate || ""
      
      // If no direct message, try to extract from previous steps
      if (!messageText && context.previousStepResults) {
        const stepKeys = Object.keys(context.previousStepResults)
        if (stepKeys.length > 0) {
          const latestStepKey = stepKeys[stepKeys.length - 1]
          const latestStepResult = context.previousStepResults[latestStepKey]
          
          messageText = latestStepResult?.result?.aiOutput ||
            latestStepResult?.result?.content ||
            latestStepResult?.result?.message ||
            JSON.stringify(latestStepResult?.result || {})
        }
      }

      if (!messageText) {
        messageText = "Workflow step completed"
      }

      // Format message with mentions
      const formattedMessage = formatSlackMessage(
        messageText,
        config.mentionUsers,
        config.mentionChannels
      )

      // Prepare Slack payload
      const slackPayload: any = {
        text: formattedMessage,
        username: config.username,
        icon_emoji: config.iconEmoji,
      }

      if (config.channel) {
        slackPayload.channel = input.channelOverride || config.channel
      }

      // Add attachments if configured
      if (config.attachments && input.attachmentData) {
        slackPayload.attachments = [
          {
            color: "good",
            fields: [
              {
                title: "Workflow Data",
                value: JSON.stringify(input.attachmentData, null, 2),
                short: false,
              },
            ],
            ts: Math.floor(Date.now() / 1000),
          },
        ]
      }

      // Send message to Slack
      const response = await fetch(config.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(slackPayload),
      })

      const messageSent = response.ok
      const responseText = await response.text()

      const output: SlackOutput = {
        messageSent,
        channel: slackPayload.channel || "default",
        messageText: formattedMessage,
        messageLength: formattedMessage.length,
        timestamp: new Date().toISOString(),
        error: messageSent ? undefined : responseText || "Failed to send message",
      }

      return {
        status: messageSent ? "success" : "error",
        result: output,
      }
    } catch (error) {
      return {
        status: "error",
        result: {
          messageSent: false,
          channel: config.channel || "unknown",
          messageText: input.message || "",
          messageLength: 0,
          error: `Slack tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        } as SlackOutput,
      }
    }
  }

  validateInput(input: unknown): input is SlackInput {
    return slackInputSchema.safeParse(input).success
  }

  validateConfig(config: unknown): config is SlackConfig {
    return slackConfigSchema.safeParse(config).success
  }

  getInputSchema() {
    return slackInputSchema
  }

  getConfigSchema() {
    return slackConfigSchema
  }

  getDefaultConfig(): SlackConfig {
    return {
      username: "Workflow Bot",
      iconEmoji: ":robot_face:",
      mentionUsers: [],
      mentionChannels: [],
      attachments: false,
    }
  }
}