import { create } from "zustand"

export interface SelectedUser {
  userId: number
  userName: string
  userEmail: string
}

type DashboardTab = "my-activity" | "shared-agents" | "admin-overview"

interface AdminUserSelectionStore {
  selectedUser: SelectedUser | null
  dashboardTab: DashboardTab | null
  setSelectedUser: (user: SelectedUser) => void
  setDashboardTab: (tab: DashboardTab) => void
  clearSelectedUser: () => void
}

export const useAdminUserSelectionStore = create<AdminUserSelectionStore>(
  (set) => ({
    selectedUser: null,
    dashboardTab: null,

    setSelectedUser: (user: SelectedUser) => {
      set({ selectedUser: user })
    },

    setDashboardTab: (tab: DashboardTab) => {
      set({ dashboardTab: tab })
    },

    clearSelectedUser: () => {
      set({ selectedUser: null })
    },
  }),
)
