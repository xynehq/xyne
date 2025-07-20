import { api } from "@/api"
import { Link, useLocation, useRouter } from "@tanstack/react-router"
import {
  Bot,
  Plug,
  Plus,
  History,
  Sun,
  Moon,
  LogOut,
  ExternalLink,
  Key,
} from "lucide-react"
import { useState, useEffect } from "react"
import HistoryModal from "@/components/HistoryModal"
import { CLASS_NAMES, SELECTORS } from "../lib/constants"
import { useTheme } from "@/components/ThemeContext"
import { useSidebar } from "@/components/SidebarContext"
import { UserRole } from "shared/types"
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
  const { isExpanded, setIsExpanded } = useSidebar()
  const { theme, toggleTheme } = useTheme()
  const isDarkMode = theme === "dark"

  const router = useRouter()

  const logout = async (): Promise<void> => {
    try {
      const res = await api.auth.logout.$post()
      if (res.ok) {
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
        setShowHistory(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [showHistory])

  // toggleDarkMode is now toggleTheme from context (no separate function needed here)

  return (
    <>
      {/* Dimmer overlay when sidebar is expanded */}
      {isExpanded && (
        <div
          className="fixed inset-0 bg-black/20 z-10 transition-opacity duration-300"
          onClick={() => setIsExpanded(false)}
        />
      )}
      
      <TooltipProvider>
        <div
          className={`bg-white dark:bg-[#1E1E1E] h-full ${isExpanded ? "w-[200px]" : "w-[52px]"} border-r-[0.5px] border-[#D7E0E9] dark:border-gray-700 flex flex-col fixed ${className} z-20 select-none transition-all duration-300 ease-in-out ${CLASS_NAMES.SIDEBAR_CONTAINER}`}
          onMouseEnter={(e) => {
            // Only expand if we're hovering over the sidebar itself, not the history modal
            const target = e.target as HTMLElement
            const isHistoryModal = target.closest(`.${CLASS_NAMES.HISTORY_MODAL_CONTAINER}`)
            if (!isHistoryModal) {
              setIsExpanded(true)
            }
          }}
          onMouseLeave={(e) => {
            // Collapse sidebar when mouse leaves, unless history modal is open
            if (!showHistory) {
              setIsExpanded(false)
            }
          }}
        >
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
            className={`flex ${isExpanded ? "w-[calc(100%-32px)] mx-4 px-3 py-2 justify-start gap-3" : "w-8 h-8 justify-center"} border border-[#C4D0DC] items-center rounded-md transition-all duration-300 hover:bg-[#D8DFE680] dark:hover:bg-gray-700`}
          >
            {isExpanded ? (
              <>
                <Plus
                  size={18}
                  stroke="#384049"
                  className="dark:stroke-[#F1F3F4] flex-shrink-0"
                />
                <span className="text-sm font-medium text-[#384049] dark:text-[#F1F3F4]">New</span>
              </>
            ) : (
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
            )}
          </Link>

          <div
            onClick={() => setShowHistory((history) => !history)}
            className={`flex ${isExpanded ? "w-[calc(100%-32px)] mx-4 px-3 py-2 justify-start gap-3" : "w-8 h-8 justify-center"} ${showHistory ? "bg-[#D8DFE680] dark:bg-gray-700" : ""} rounded-lg items-center cursor-pointer hover:bg-[#D8DFE680] dark:hover:bg-gray-700 mt-[10px] transition-all duration-300`}
          >
            {isExpanded ? (
              <>
                <History
                  size={18}
                  stroke="#384049"
                  className="dark:stroke-[#F1F3F4] flex-shrink-0"
                />
                <span className="text-sm font-medium text-[#384049] dark:text-[#F1F3F4]">History</span>
              </>
            ) : (
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
            )}
          </div>

          {/* TODO: Add appropriate Link destination and Tooltip info for the Bot icon */}
          {isAgentMode && (
            <Link
              to="/agent"
              className={`flex ${isExpanded ? "w-[calc(100%-32px)] mx-4 px-3 py-2 justify-start gap-3" : "w-8 h-8 justify-center"} items-center hover:bg-[#D8DFE680] dark:hover:bg-gray-700 rounded-md mt-[10px] ${
                location.pathname.includes("/agent")
                  ? "bg-[#D8DFE680] dark:bg-gray-700"
                  : ""
              } transition-all duration-300`}
            >
              {isExpanded ? (
                <>
                  <Bot
                    stroke="#384049"
                    size={18}
                    className="dark:stroke-[#F1F3F4] flex-shrink-0"
                  />
                  <span className="text-sm font-medium text-[#384049] dark:text-[#F1F3F4]">Agent</span>
                </>
              ) : (
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
              )}
            </Link>
          )}

          <Link
            to={`${role === UserRole.SuperAdmin || role === UserRole.Admin ? "/admin/integrations" : "/integrations"}`}
            className={`flex ${isExpanded ? "w-[calc(100%-32px)] mx-4 px-3 py-2 justify-start gap-3" : "w-8 h-8 justify-center"} items-center hover:bg-[#D8DFE680] dark:hover:bg-gray-700 rounded-md mt-[10px] ${
              location.pathname.includes("/admin/integrations") ||
              location.pathname.includes("/integrations")
                ? "bg-[#D8DFE680] dark:bg-gray-700"
                : ""
            } transition-all duration-300`}
          >
            {isExpanded ? (
              <>
                <Plug
                  stroke="#384049"
                  size={18}
                  className="dark:stroke-[#F1F3F4] flex-shrink-0"
                />
                <span className="text-sm font-medium text-[#384049] dark:text-[#F1F3F4]">Integrations</span>
              </>
            ) : (
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
            )}
          </Link>

          <div
            onClick={toggleTheme}
            className={`flex ${isExpanded ? "w-[calc(100%-32px)] mx-4 px-3 py-2 justify-start gap-3" : "w-8 h-8 justify-center"} rounded-lg items-center cursor-pointer hover:bg-[#D8DFE680] dark:hover:bg-gray-700 mt-[10px] transition-all duration-300`}
          >
            {isExpanded ? (
              <>
                {isDarkMode ? (
                  <Sun size={18} stroke="#F1F3F4" className="flex-shrink-0" />
                ) : (
                  <Moon size={18} stroke="#384049" className="flex-shrink-0" />
                )}
                <span className="text-sm font-medium text-[#384049] dark:text-[#F1F3F4]">
                  {isDarkMode ? "Light Mode" : "Dark Mode"}
                </span>
              </>
            ) : (
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
            )}
          </div>
        </div>
        <div className="mt-auto mb-4 flex justify-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <img src={Logo} alt="Logo" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="ml-2">
              <DropdownMenuItem
                key={"api-key"}
                role="button"
                className="flex text-[14px] py-[8px] px-[10px] hover:bg-[#EBEFF2] items-center"
                onClick={() => {
                  router.navigate({ to: "/api-key" })
                }}
              >
                <Key size={16} />
                <span>API Key</span>
              </DropdownMenuItem>
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
    
    {/* History Modal rendered outside sidebar to prevent hover interference */}
    {showHistory && (
      <HistoryModal
        pathname={location.pathname}
        onClose={() => setShowHistory(false)}
        sidebarExpanded={isExpanded}
      />
    )}
    </>
  )
}
