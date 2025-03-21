import { Apps, AuthType } from "@/shared/types"
import { IsGoogleApp } from "@/utils"

type Email = string
type WorkspaceStats = Record<Email, UserStats>

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
type UserStats = (GoogleStats | SlackStats) & StatMetadata

// Progress tracking types
interface ServiceAccountProgress {
  totalUsers: number
  completedUsers: number
  userStats: Record<string, UserStats>
}

interface OAuthProgress {
  user: string
  userStats: Record<string, UserStats>
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

  constructor(app: Apps) {
    this.app = app
    this.serviceAccountProgress = {
      totalUsers: 0,
      completedUsers: 0,
      userStats: {},
    }
    this.oAuthProgress = {
      user: "",
      userStats: {},
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
          ...baseStats,
        }
      } else if (this.app === Apps.Slack) {
        // Assuming Apps.Slack exists
        this.serviceAccountProgress.userStats[email] = {
          slackMessageCount: 0,
          slackConversationCount: 0,
          slackUserCount: 0,
          slackMessageReplyCount: 0,
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
          ...baseOAuthStats,
        }
      } else if (this.app === Apps.Slack) {
        this.oAuthProgress.userStats[email] = {
          slackUserCount: 0,
          slackMessageCount: 0,
          slackConversationCount: 0,
          slackMessageReplyCount: 0,
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
      return Math.floor(
        (this.serviceAccountProgress.completedUsers /
          this.serviceAccountProgress.totalUsers) *
          100,
      )
    } else if (this.app === Apps.Slack) {
      return 0
      // return Math.floor(this.oAuthProgress.userStats[this.oAuthProgress.user].slackConversationCount/)
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
}

// export const newServiceAccountTracker = (app: Apps): ServiceAccountProgress => {
//   return {
//     totalUsers: 0,
//     completedUsers: 0,
//     userStats: {},
//   }
// }

// export const oAuthTracker: OAuthProgress = {
//   user: "",
//   userStats: {},
// }
// // Helper functions to update tracker
// const initializeUserStats = (app: Apps, email: string) => {
//   if (!serviceAccountTracker.userStats[email]) {
//     serviceAccountTracker.userStats[email] = {
//       gmailCount: 0,
//       driveCount: 0,
//       contactsCount: 0,
//       eventsCount: 0,
//       mailAttachmentCount: 0,
//       done: false,
//       startedAt: new Date().getTime(),
//       doneAt: 0,
//       type: AuthType.ServiceAccount,
//     }
//   }
//   if (!oAuthTracker.userStats[email]) {
//     oAuthTracker.userStats[email] = {
//       gmailCount: 0,
//       driveCount: 0,
//       contactsCount: 0,
//       eventsCount: 0,
//       mailAttachmentCount: 0,
//       done: false,
//       startedAt: new Date().getTime(),
//       doneAt: 0,
//       type: AuthType.OAuth,
//     }
//   }

// }

// export const updateUserStats = (
//   app: Apps,
//   email: string,
//   type: StatType,
//   count: number,
// ) => {
//   initializeUserStats(email)
//   serviceAccountTracker.userStats[email][type] += count
//   oAuthTracker.userStats[email][type] += count
// }

// export const markUserComplete = (email: string) => {
//   if (!serviceAccountTracker.userStats[email].done) {
//     serviceAccountTracker.userStats[email].done = true
//     serviceAccountTracker.userStats[email].doneAt = new Date().getTime()
//     serviceAccountTracker.completedUsers++
//   }
// }

// export const setTotalUsers = (total: number) => {
//   serviceAccountTracker.totalUsers = total
// }

// export const getProgress = (): number => {
//   return Math.floor(
//     (serviceAccountTracker.completedUsers / serviceAccountTracker.totalUsers) *
//       100,
//   )
// }

// export const setOAuthUser = (mail: string) => {
//   oAuthTracker.user = mail
// }
