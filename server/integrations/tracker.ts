import { Apps, AuthType } from "@/shared/types"
import { IsGoogleApp } from "@/utils"

type Email = string
type WorkspaceStats = Record<Email, UserStats>
interface GoogleTotalStats {
  totalMail: number
  totalDrive: number
}

interface SlackTotalStats {
  totalMessages: number
  totalConversations: number
}

export enum StatType {
  Gmail = "gmailCount",
  Drive = "driveCount",
  Contacts = "contactsCount",
  Events = "eventsCount",
  Mail_Attachments = "mailAttachmentCount",
  Slack_Message = "slackMessageCount",
  Slack_Conversation = "slackConversationCount",
  Slack_User = "slackUserCount",
  Slack_Message_Reply = "slackMessageReplyCount",
  WhatsApp_Message = "whatsappMessageCount",
  WhatsApp_Contact = "whatsappContactCount",
  WhatsApp_Conversation = "whatsappConversationCount",
  WhatsApp_Group = "whatsappGroupCount",
}

interface StatMetadata {
  done: boolean
  startedAt: number
  doneAt: number
  type: AuthType
}

interface GoogleStats {
  gmailCount: number
  driveCount: number
  contactsCount: number
  eventsCount: number
  mailAttachmentCount: number
}

interface SlackStats {
  slackMessageCount: number
  slackConversationCount: number
  slackUserCount: number
  slackMessageReplyCount: number
}

// Union type for all possible stat types
type UserStats = (
  | (GoogleStats & Partial<GoogleTotalStats>)
  | (SlackStats & Partial<SlackTotalStats>)
  | WhatsAppStats
) &
  StatMetadata

interface WhatsAppStats {
  whatsappMessageCount: number
  whatsappContactCount: number
  whatsappConversationCount: number
  whatsappGroupCount: number
}

// Progress tracking types
interface ServiceAccountProgress {
  totalUsers: number
  completedUsers: number
  userStats: Record<string, UserStats>
}

interface OAuthProgress {
  user: string
  userStats: Record<string, UserStats>
  current: number
  total: number
}
// Global tracker object
export const serviceAccountTracker: ServiceAccountProgress = {
  totalUsers: 0,
  completedUsers: 0,
  userStats: {},
}

export class Tracker {
  private app: Apps
  private serviceAccountProgress: ServiceAccountProgress
  private oAuthProgress: OAuthProgress
  private authType: AuthType
  private startTime: number

  constructor(app: Apps, authType: AuthType) {
    this.app = app
    this.authType = authType
    this.serviceAccountProgress = {
      totalUsers: 0,
      completedUsers: 0,
      userStats: {},
    }
    this.oAuthProgress = {
      user: "",
      userStats: {},
      current: 0,
      total: 0,
    }
    this.startTime = new Date().getTime()
  }

  public updateTotal(
    email: string,
    appSpecificTotals: GoogleTotalStats | SlackTotalStats,
  ) {
    this.initializeUserStats(email)

    const serviceStats = this.serviceAccountProgress.userStats[email]
    const oAuthStats = this.oAuthProgress.userStats[email]

    if (IsGoogleApp(this.app)) {
      const totals = appSpecificTotals as GoogleTotalStats
      if ("totalMail" in serviceStats) {
        ;(serviceStats as GoogleStats & GoogleTotalStats).totalMail =
          totals.totalMail
        ;(serviceStats as GoogleStats & GoogleTotalStats).totalDrive =
          totals.totalDrive
      }
      if ("totalMail" in oAuthStats) {
        ;(oAuthStats as GoogleStats & GoogleTotalStats).totalMail =
          totals.totalMail
        ;(oAuthStats as GoogleStats & GoogleTotalStats).totalDrive =
          totals.totalDrive
      }
    } else if (this.app === Apps.Slack) {
      const totals = appSpecificTotals as SlackTotalStats
      if ("totalMessages" in serviceStats) {
        ;(serviceStats as SlackStats & SlackTotalStats).totalMessages =
          totals.totalMessages
        ;(serviceStats as SlackStats & SlackTotalStats).totalConversations =
          totals.totalConversations
      }
      if ("totalMessages" in oAuthStats) {
        ;(oAuthStats as SlackStats & SlackTotalStats).totalMessages =
          totals.totalMessages
        ;(oAuthStats as SlackStats & SlackTotalStats).totalConversations =
          totals.totalConversations
      }
    }
  }

  private initializeUserStats(email: string) {
    const baseStats: StatMetadata = {
      done: false,
      startedAt: new Date().getTime(),
      doneAt: 0,
      type: AuthType.ServiceAccount,
    }
    const baseOAuthStats: StatMetadata = {
      done: false,
      startedAt: new Date().getTime(),
      doneAt: 0,
      type: AuthType.OAuth,
    }

    if (!this.serviceAccountProgress.userStats[email]) {
      if (IsGoogleApp(this.app)) {
        // Assuming Apps.Google exists
        this.serviceAccountProgress.userStats[email] = {
          gmailCount: 0,
          driveCount: 0,
          contactsCount: 0,
          eventsCount: 0,
          mailAttachmentCount: 0,
          totalMail: 0,
          totalDrive: 0,
          ...baseStats,
        }
      } else if (this.app === Apps.Slack) {
        // Assuming Apps.Slack exists
        this.serviceAccountProgress.userStats[email] = {
          slackMessageCount: 0,
          slackConversationCount: 0,
          slackUserCount: 0,
          slackMessageReplyCount: 0,
          totalMessages: 0,
          totalConversations: 0,
          ...baseStats,
        }
      } else if (this.app === Apps.WhatsApp) {
        this.serviceAccountProgress.userStats[email] = {
          whatsappMessageCount: 0,
          whatsappContactCount: 0,
          whatsappConversationCount: 0,
          whatsappGroupCount: 0,
          ...baseStats,
        }
      }
      // Add more else-if blocks for additional apps here
    }

    if (!this.oAuthProgress.userStats[email]) {
      if (IsGoogleApp(this.app)) {
        this.oAuthProgress.userStats[email] = {
          gmailCount: 0,
          driveCount: 0,
          contactsCount: 0,
          eventsCount: 0,
          mailAttachmentCount: 0,
          totalMail: 0,
          totalDrive: 0,
          ...baseOAuthStats,
        }
      } else if (this.app === Apps.Slack) {
        this.oAuthProgress.userStats[email] = {
          slackUserCount: 0,
          slackMessageCount: 0,
          slackConversationCount: 0,
          slackMessageReplyCount: 0,
          totalMessages: 0,
          totalConversations: 0,
          ...baseOAuthStats,
        }
      } else if (this.app === Apps.WhatsApp) {
        this.oAuthProgress.userStats[email] = {
          whatsappMessageCount: 0,
          whatsappContactCount: 0,
          whatsappConversationCount: 0,
          whatsappGroupCount: 0,
          ...baseOAuthStats,
        }
      }
      // Add more else-if blocks for additional apps here
    }
  }

  updateUserStats(email: string, type: StatType, count: number) {
    this.initializeUserStats(email)

    const serviceStats = this.serviceAccountProgress.userStats[email]
    const oAuthStats = this.oAuthProgress.userStats[email]

    // Update only if the stat type exists in the stats object
    if (type in serviceStats) {
      ;(serviceStats as any)[type] += count
    }
    if (type in oAuthStats) {
      ;(oAuthStats as any)[type] += count
    }
  }

  markUserComplete(email: string) {
    if (!this.serviceAccountProgress.userStats[email].done) {
      this.serviceAccountProgress.userStats[email].done = true
      this.serviceAccountProgress.userStats[email].doneAt = new Date().getTime()
      this.serviceAccountProgress.completedUsers++
    }
  }

  setTotalUsers(total: number) {
    this.serviceAccountProgress.totalUsers = total
  }

  getProgress(): number {
    if (IsGoogleApp(this.app)) {
      if (this.authType === AuthType.ServiceAccount) {
        return Math.floor(
          (this.serviceAccountProgress.completedUsers /
            this.serviceAccountProgress.totalUsers) *
            100,
        )
      } else {
        return 0
      }
    } else if (this.app === Apps.Slack) {
      return Math.floor(this.oAuthProgress.current / this.oAuthProgress.total)
    } else if (this.app === Apps.WhatsApp) {
      const stats = this.oAuthProgress.userStats[
        this.oAuthProgress.user
      ] as WhatsAppStats & StatMetadata
      if (!stats) return 0

      // Calculate progress based on WhatsApp metrics
      // We consider the ingestion complete when we have both messages and contacts
      const hasMessages = stats.whatsappMessageCount > 0
      const hasContacts = stats.whatsappContactCount > 0
      const hasConversations = stats.whatsappConversationCount > 0

      if (hasMessages && hasContacts && hasConversations) {
        return 100
      } else if (hasMessages || hasContacts || hasConversations) {
        return 50
      }
      return 0
    } else {
      throw new Error("Invalid app for progress")
    }
  }

  setOAuthUser(email: string) {
    this.oAuthProgress.user = email
  }

  getServiceAccountProgress(): ServiceAccountProgress {
    return { ...this.serviceAccountProgress }
  }

  getOAuthProgress(): OAuthProgress {
    return { ...this.oAuthProgress }
  }

  getStartTime(): number {
    return this.startTime
  }

  setCurrent(curr: number) {
    this.oAuthProgress.current = curr
  }
  setTotal(total: number) {
    this.oAuthProgress.total = total
  }
}
