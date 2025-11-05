import { api } from "@/api"
import { Link, useLocation, useRouter } from "@tanstack/react-router"
import {
  Bot,
  Plug,
  Plus,
  History,
  User,
  Sun,
  Moon,
  LogOut,
  ExternalLink,
  BarChart3,
  BookOpen,
  Workflow,
  Users,
} from "lucide-react"
import { useState, useEffect } from "react"
import HistoryModal from "@/components/HistoryModal"
import { CLASS_NAMES, SELECTORS } from "../lib/constants"
import { useTheme } from "@/components/ThemeContext"
import { UserRole } from "shared/types"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Tip } from "@/components/Tooltip"
import Logo from "@/assets/logo.svg"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { toast } from "@/hooks/use-toast"
import { useUnreadCount } from "@/contexts/UnreadCountContext"

export const Sidebar = ({
  className = "",
  photoLink = "",
  role = "",
  isAgentMode = false,
}: {
  className?: string
  photoLink?: string
  role?: string
  isAgentMode?: boolean
}) => {
  const location = useLocation()
  const [showHistory, setShowHistory] = useState<boolean>(false)
  const { theme, toggleTheme } = useTheme()
  const isDarkMode = theme === "dark"
  const { totalUnreadCount } = useUnreadCount()

  const router = useRouter()

  const logout = async (): Promise<void> => {
    try {
      const res = await api.auth.logout.$post()
      if (res.ok) {
        // Clear document chat mappings from sessionStorage on logout
        try {
          sessionStorage.removeItem("documentToTempChatMap")
          sessionStorage.removeItem("tempChatIdToChatIdMap")
        } catch (error) {
          console.error(
            "Failed to clear document chat mappings on logout:",
            error,
          )
        }

        router.navigate({ to: "/auth" })
      } else {
        toast({
          title: "Error logging out",
          description: "Could not logout",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Logout failed:", error)
      toast({
        title: "Error logging out",
        description: "An unexpected error occurred. Please try again.",
        variant: "destructive",
      })
    }
  }

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement

      const isInteractiveElement = target.closest(SELECTORS.INTERACTIVE_ELEMENT)
      if (isInteractiveElement) return
      const isSidebarClick = target.closest(`.${CLASS_NAMES.SIDEBAR_CONTAINER}`)
      const isHistoryModalClick = target.closest(
        `.${CLASS_NAMES.HISTORY_MODAL_CONTAINER}`,
      )
      const isChatInput = target.closest(SELECTORS.CHAT_INPUT)
      const isSearchArea = target.closest(`.${CLASS_NAMES.SEARCH_CONTAINER}`)
      const isReferenceBox = target.closest(`.${CLASS_NAMES.REFERENCE_BOX}`)
      const isAtMentionArea = target.closest(SELECTORS.AT_MENTION_AREA)
      const isBookmarkButton = target.closest(`.${CLASS_NAMES.BOOKMARK_BUTTON}`)
      if (
        !isSidebarClick &&
        !isHistoryModalClick &&
        !isChatInput &&
        !isSearchArea &&
        !isReferenceBox &&
        !isAtMentionArea &&
        !isBookmarkButton &&
        showHistory
      ) {
        if (showHistory) setShowHistory(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [showHistory])

  // toggleDarkMode is now toggleTheme from context (no separate function needed here)

  return (
    <TooltipProvider>
      <div
        className={cn(
          "bg-white dark:bg-[#1E1E1E] h-full w-[52px] border-r-[0.5px] border-[#D7E0E9] dark:border-gray-700 flex flex-col fixed z-20 select-none",
          className,
          CLASS_NAMES.SIDEBAR_CONTAINER,
        )}
      >
        {showHistory && (
          <HistoryModal
            pathname={location.pathname}
            onClose={() => setShowHistory(false)}
          />
        )}
        <div className="flex flex-col items-center pt-4">
          {photoLink && (
            <img
              className="w-8 h-8 rounded-full mb-4"
              src={`/api/v1/proxy/${encodeURIComponent(photoLink)}`}
              alt="Profile"
            />
          )}
        </div>

        <div className="flex flex-col items-center mt-[10px]">
          <Link
            to="/"
            className="flex w-8 h-8 border border-[#C4D0DC] items-center justify-center rounded-md"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Plus
                  size={18}
                  stroke="#384049"
                  className="dark:stroke-[#F1F3F4]"
                />
              </TooltipTrigger>
              <Tip side="right" info="New" />
            </Tooltip>
          </Link>

          <div
            onClick={() => setShowHistory((history) => !history)}
            className={cn(
              "flex w-8 h-8 rounded-lg items-center justify-center cursor-pointer hover:bg-[#D8DFE680] dark:hover:bg-gray-700 mt-[10px]",
              showHistory && "bg-[#D8DFE680] dark:bg-gray-700",
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <History
                  size={18}
                  stroke="#384049"
                  className="dark:stroke-[#F1F3F4]"
                />
              </TooltipTrigger>
              <Tip side="right" info="History" />
            </Tooltip>
          </div>

          <Link
            to="/buzz/chats"
            className={cn(
              "relative flex w-8 h-8 rounded-lg items-center justify-center cursor-pointer hover:bg-[#D8DFE680] dark:hover:bg-gray-700 mt-[10px]",
              location.pathname.includes("/buzz") &&
                "bg-[#D8DFE680] dark:bg-gray-700",
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Users
                  size={18}
                  stroke="#384049"
                  className="dark:stroke-[#F1F3F4]"
                />
              </TooltipTrigger>
              <Tip side="right" info="Buzz" />
            </Tooltip>
            {/* Unread Count Badge */}
            {totalUnreadCount > 0 && (
              <div className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 flex items-center justify-center bg-red-600 dark:bg-red-500 rounded-full border-2 border-white dark:border-[#1E1E1E]">
                <span className="text-[9px] font-bold text-white leading-none">
                  {totalUnreadCount > 99 ? "99+" : totalUnreadCount}
                </span>
              </div>
            )}
          </Link>

          <Link
            to="/workflow"
            className={cn(
              "flex w-8 h-8 items-center justify-center hover:bg-[#D8DFE680] dark:hover:bg-gray-700 rounded-md mt-[10px]",
              location.pathname.includes("/workflow") &&
                "bg-[#D8DFE680] dark:bg-gray-700",
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Workflow
                  stroke="#384049"
                  size={18}
                  className="dark:stroke-[#F1F3F4]"
                />
              </TooltipTrigger>
              <Tip side="right" info="Workflow Builder" />
            </Tooltip>
          </Link>

          {/* TODO: Add appropriate Link destination and Tooltip info for the Bot icon */}
          {isAgentMode && (
            <Link
              to="/agent"
              className={cn(
                "flex w-8 h-8 items-center justify-center hover:bg-[#D8DFE680] dark:hover:bg-gray-700 rounded-md mt-[10px]",
                location.pathname.includes("/agent") &&
                  "bg-[#D8DFE680] dark:bg-gray-700",
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Bot
                    stroke="#384049"
                    size={18}
                    className="dark:stroke-[#F1F3F4]"
                  />
                </TooltipTrigger>
                <Tip side="right" info="agent" />{" "}
                {/* Placeholder: Update this tooltip info */}
              </Tooltip>
            </Link>
          )}

          <Link
            to={`${role === UserRole.SuperAdmin || role === UserRole.Admin ? "/admin/integrations" : "/integrations"}`}
            className={cn(
              "flex w-8 h-8 items-center justify-center hover:bg-[#D8DFE680] dark:hover:bg-gray-700 rounded-md mt-[10px]",
              (location.pathname.includes("/admin/integrations") ||
                location.pathname.includes("/integrations")) &&
                "bg-[#D8DFE680] dark:bg-gray-700",
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Plug
                  stroke="#384049"
                  size={18}
                  className="dark:stroke-[#F1F3F4]"
                />
              </TooltipTrigger>
              <Tip side="right" info="Integrations" />
            </Tooltip>
          </Link>

          <Link
            to="/knowledgeManagement"
            className={`flex w-8 h-8 items-center justify-center hover:bg-[#D8DFE680] dark:hover:bg-gray-700 rounded-md mt-[10px] ${
              location.pathname.includes("/knowledgeManagement")
                ? "bg-[#D8DFE680] dark:bg-gray-700"
                : ""
            }`}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <BookOpen
                  stroke="#384049"
                  size={18}
                  className="dark:stroke-[#F1F3F4]"
                />
              </TooltipTrigger>
              <Tip side="right" info="Collections" />
            </Tooltip>
          </Link>
          {/* User Management - Admin only */}
          {role === UserRole.SuperAdmin && (
            <Link
              to="/admin/userManagement"
              className={cn(
                "flex w-8 h-8 items-center justify-center hover:bg-[#D8DFE680] dark:hover:bg-gray-700 rounded-md mt-[10px]",
                location.pathname.includes("/admin/userManagement") &&
                  "bg-[#D8DFE680] dark:bg-gray-700",
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <User
                    stroke="#384049"
                    size={18}
                    className="dark:stroke-[#F1F3F4]"
                  />
                </TooltipTrigger>
                <Tip side="right" info="User Management" />
              </Tooltip>
            </Link>
          )}
          <Link
            to="/dashboard"
            className={cn(
              "flex w-8 h-8 items-center justify-center hover:bg-[#D8DFE680] dark:hover:bg-gray-700 rounded-md mt-[10px]",
              location.pathname.includes("/dashboard") &&
                "bg-[#D8DFE680] dark:bg-gray-700",
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <BarChart3
                  stroke="#384049"
                  size={18}
                  className="dark:stroke-[#F1F3F4]"
                />
              </TooltipTrigger>
              <Tip side="right" info="Dashboard" />
            </Tooltip>
          </Link>
        </div>
        <div className="mt-auto mb-4 flex flex-col items-center">
          <div
            onClick={toggleTheme}
            className="flex w-8 h-8 rounded-lg items-center justify-center cursor-pointer hover:bg-[#D8DFE680] dark:hover:bg-gray-700 mb-4"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                {isDarkMode ? (
                  <Sun size={18} stroke="#F1F3F4" />
                ) : (
                  <Moon size={18} stroke="#384049" />
                )}
              </TooltipTrigger>
              <Tip
                side="right"
                info={isDarkMode ? "Light Mode" : "Dark Mode"}
              />
            </Tooltip>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <img src={Logo} alt="Logo" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="ml-2">
              <DropdownMenuItem
                key={"xyne"}
                role="button"
                className="flex text-[14px] py-[8px] px-[10px] hover:bg-[#EBEFF2] items-center"
                onClick={() => {
                  window.open(
                    "https://xynehq.com",
                    "_blank",
                    "noopener,noreferrer",
                  )
                }}
              >
                <ExternalLink size={16} />
                <span>Visit Xyne</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                key={"logout"}
                role="button"
                className="flex text-[14px] py-[8px] px-[10px] hover:bg-[#EBEFF2] items-center"
                onClick={() => logout()}
              >
                <LogOut size={16} className="text-red-500" />
                <span className="text-red-500">Logout</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </TooltipProvider>
  )
}
