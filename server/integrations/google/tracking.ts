type Email = string
type WorkspaceStats = Record<Email, UserStats>

export enum StatType {
  Gmail = "gmailCount",
  Drive = "driveCount",
  Contacts = "contactsCount",
  Events = "eventsCount",
}

interface StatMetadata {
  done: boolean,
  startedAt: number,
  doneAt: number,
}

type UserStats = Record<StatType, number> & StatMetadata

// Progress tracking types
interface ServiceAccountProgress {
  totalUsers: number
  completedUsers: number
  userStats: Record<string, UserStats>
}

// Global tracker object
export const serviceAccountTracker: ServiceAccountProgress = {
  totalUsers: 0,
  completedUsers: 0,
  userStats: {},
}

// Helper functions to update tracker
const initializeUserStats = (email: string) => {
  if (!serviceAccountTracker.userStats[email]) {
    serviceAccountTracker.userStats[email] = {
      gmailCount: 0,
      driveCount: 0,
      contactsCount: 0,
      eventsCount: 0,
      done: false,
      startedAt: new Date().getTime(),
      doneAt: 0
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
}

export const markUserComplete = (email: string) => {
  serviceAccountTracker.userStats[email].done = true
  serviceAccountTracker.userStats[email].doneAt = new Date().getTime()
  serviceAccountTracker.completedUsers++
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
