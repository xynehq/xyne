import { AuthType } from "@/shared/types"

type Email = string
type WorkspaceStats = Record<Email, UserStats>

export enum StatType {
  Gmail = "gmailCount",
  Drive = "driveCount",
  Contacts = "contactsCount",
  Events = "eventsCount",
  Mail_Attachments = "mailAttachmentCount",
}

interface StatMetadata {
  done: boolean
  startedAt: number
  doneAt: number
  type: AuthType
}

type UserStats = Record<StatType, number> & StatMetadata

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
export const oAuthTracker: OAuthProgress = {
  user: "",
  userStats: {},
}

export const emptyUserStats = () => {
  serviceAccountTracker.userStats = {}
  oAuthTracker.userStats = {}
}
// Helper functions to update tracker
const initializeUserStats = (email: string) => {
  if (!serviceAccountTracker.userStats[email]) {
    serviceAccountTracker.userStats[email] = {
      gmailCount: 0,
      driveCount: 0,
      contactsCount: 0,
      eventsCount: 0,
      mailAttachmentCount: 0,
      done: false,
      startedAt: new Date().getTime(),
      doneAt: 0,
      type: AuthType.ServiceAccount,
    }
  }
  if (!oAuthTracker.userStats[email]) {
    oAuthTracker.userStats[email] = {
      gmailCount: 0,
      driveCount: 0,
      contactsCount: 0,
      eventsCount: 0,
      mailAttachmentCount: 0,
      done: false,
      startedAt: new Date().getTime(),
      doneAt: 0,
      type: AuthType.OAuth,
    }
  }
}

export const updateUserStats = (
  email: string,
  type: StatType,
  count: number,
) => {
  initializeUserStats(email)
  serviceAccountTracker.userStats[email][type] += count
  oAuthTracker.userStats[email][type] += count
}

export const markUserComplete = (email: string) => {
  if (!serviceAccountTracker.userStats[email].done) {
    serviceAccountTracker.userStats[email].done = true
    serviceAccountTracker.userStats[email].doneAt = new Date().getTime()
    serviceAccountTracker.completedUsers++
  }
}

export const setTotalUsers = (total: number) => {
  serviceAccountTracker.totalUsers = total
}

export const getProgress = (): number => {
  return Math.floor(
    (serviceAccountTracker.completedUsers / serviceAccountTracker.totalUsers) *
      100,
  )
}

export const setOAuthUser = (mail: string) => {
  oAuthTracker.user = mail
}
