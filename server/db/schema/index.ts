// Export all tables
export * from "@/db/schema/workspaces"
export * from "@/db/schema/users"
export * from "@/db/schema/userPersonalization"
export * from "@/db/schema/connectors"
export * from "@/db/schema/oauthProviders"
export * from "@/db/schema/syncJobs"
export * from "@/db/schema/syncHistory"
export * from "@/db/schema/chats"
export * from "@/db/schema/messages"
export * from "@/db/schema/chatTrace"
export * from "@/db/schema/agents"
export * from "@/db/schema/userAgentPermissions"
export * from "@/db/schema/McpConnectors"
export * from "@/db/schema/sharedChats"
export * from "@/db/schema/knowledgeBase"
export * from "@/db/schema/apiKey"
export * from "@/db/schema/workflows"
// export * from "@/db/schema/tools" // Commented out - conflicts with new workflow schema

// Export combined types
import type { PublicUser, SelectUser } from "@/db/schema/users"
import type { PublicWorkspace, SelectWorkspace } from "@/db/schema/workspaces"

export type PublicUserWorkspace = {
  user: PublicUser
  workspace: PublicWorkspace
}

// if data is not sent out, we can keep all fields
export type InternalUserWorkspace = {
  user: SelectUser
  workspace: SelectWorkspace
}
