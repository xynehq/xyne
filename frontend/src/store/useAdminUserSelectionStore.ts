import { create } from "zustand"

export interface SelectedUser {
  userId: number
  userName: string
  userEmail: string
}

type DashboardTab = "my-activity" | "shared-agents" | "admin-overview"
type ActiveTab = "normal" | "agent"

interface AdminUserSelectionStore {
  selectedUser: SelectedUser | null
  dashboardTab: DashboardTab | null
  activeTab: ActiveTab
  dateRange: {
    from: Date | undefined
    to: Date | undefined
  }
  setSelectedUser: (user: SelectedUser) => void
  setDashboardTab: (tab: DashboardTab) => void
  setActiveTab: (tab: ActiveTab) => void
  setDateRange: (from: Date | undefined, to: Date | undefined) => void
  clearSelectedUser: () => void
  clearDateRange: () => void
}

export const useAdminUserSelectionStore = create<AdminUserSelectionStore>(
  (set) => ({
    selectedUser: null,
    dashboardTab: null,
    activeTab: "agent",
    dateRange: {
      from: undefined,
      to: undefined,
    },

    setSelectedUser: (user: SelectedUser) => {
      set({ selectedUser: user })
    },

    setDashboardTab: (tab: DashboardTab) => {
      set({ dashboardTab: tab })
    },

    setActiveTab: (tab: ActiveTab) => {
      set({ activeTab: tab })
    },

    setDateRange: (from: Date | undefined, to: Date | undefined) => {
      set({ dateRange: { from, to } })
    },

    clearSelectedUser: () => {
      set({ selectedUser: null })
    },

    clearDateRange: () => {
      set({ dateRange: { from: undefined, to: undefined } })
    },
  }),
)
