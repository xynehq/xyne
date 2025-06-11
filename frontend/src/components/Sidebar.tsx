import { Link, useLocation } from "@tanstack/react-router"
import { Bot, Plug, Plus, History, Sun, Moon } from "lucide-react"
import { useState, useEffect } from "react"
import HistoryModal from "@/components/HistoryModal"
import { CLASS_NAMES, SELECTORS } from "../lib/constants"
import { useTheme } from "@/components/ThemeContext"
import { UserRole } from "shared/types"
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Tip } from "@/components/Tooltip"
import Logo from "@/assets/logo.svg"

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
  const isDarkMode = theme === 'dark'


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

      if (
        !isSidebarClick &&
        !isHistoryModalClick &&
        !isChatInput &&
        !isSearchArea &&
        !isReferenceBox &&
        !isAtMentionArea &&
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
    <TooltipProvider>
      <div
        className={`bg-white dark:bg-[#1E1E1E] h-full w-[52px] border-r-[0.5px] border-[#D7E0E9] dark:border-gray-700 flex flex-col fixed ${className} z-20 select-none ${CLASS_NAMES.SIDEBAR_CONTAINER}`}
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
                <Plus size={18} stroke="#384049" className="dark:stroke-[#F1F3F4]" />
              </TooltipTrigger>
              <Tip side="right" info="New" />
            </Tooltip>
          </Link>

          <div
            onClick={() => setShowHistory((history) => !history)}
            className={`flex w-8 h-8 ${showHistory ? "bg-[#D8DFE680] dark:bg-gray-700" : ""} rounded-lg items-center justify-center cursor-pointer hover:bg-[#D8DFE680] dark:hover:bg-gray-700 mt-[10px]`}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <History size={18} stroke="#384049" className="dark:stroke-[#F1F3F4]" />
              </TooltipTrigger>
              <Tip side="right" info="History" />
            </Tooltip>
          </div>

          {/* TODO: Add appropriate Link destination and Tooltip info for the Bot icon */}
          {isAgentMode && (
            <Link
              to="/agent"
              className={`flex w-8 h-8 items-center justify-center hover:bg-[#D8DFE680] dark:hover:bg-gray-700 rounded-md mt-[10px] ${
                location.pathname.includes("/agent") ? "bg-[#D8DFE680] dark:bg-gray-700" : ""
              }`}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Bot stroke="#384049" size={18} className="dark:stroke-[#F1F3F4]" />
                </TooltipTrigger>
                <Tip side="right" info="agent" />{" "}
                {/* Placeholder: Update this tooltip info */}
              </Tooltip>
            </Link>
          )}

          <Link
            to={`${role === UserRole.SuperAdmin || role === UserRole.Admin ? "/admin/integrations" : "/integrations"}`}
            className={`flex w-8 h-8 items-center justify-center hover:bg-[#D8DFE680] dark:hover:bg-gray-700 rounded-md mt-[10px] ${
              location.pathname.includes("/admin/integrations") ||
              location.pathname.includes("/integrations")
                ? "bg-[#D8DFE680] dark:bg-gray-700"
                : ""
            }`}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Plug stroke="#384049" size={18} className="dark:stroke-[#F1F3F4]" />
              </TooltipTrigger>
              <Tip side="right" info="Integrations" />
            </Tooltip>
          </Link>

          <div
            onClick={toggleTheme}
            className="flex w-8 h-8 rounded-lg items-center justify-center cursor-pointer hover:bg-[#D8DFE680] dark:hover:bg-gray-700 mt-[10px]"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                {isDarkMode ? (
                  <Sun size={18} stroke="#F1F3F4" />
                ) : (
                  <Moon size={18} stroke="#384049" />
                )}
              </TooltipTrigger>
              <Tip side="right" info={isDarkMode ? "Light Mode" : "Dark Mode"} />
            </Tooltip>
          </div>
        </div>

        <a
          href="https://xynehq.com"
          className="mt-auto mb-4 flex justify-center"
        >
          <img src={Logo} alt="Logo" />
        </a>
      </div>
    </TooltipProvider>
  )
}
