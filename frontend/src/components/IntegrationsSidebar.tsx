import { TooltipProvider } from "@/components/ui/tooltip"
import { UserRole } from "shared/types"
import SlackSvg from "@/assets/slack.svg"
import GoogleSvg from "@/assets/google-logo.svg"
import MarkdownSvg from "@/assets/markdown.svg"
import { useLocation, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { ChevronDown, ChevronRight, Database } from "lucide-react"

export const IntegrationsSidebar = ({ role }: { role: string }) => {
  const router = useRouter()
  const location = useLocation()
  const [isMarkdownOpen, setIsMarkdownOpen] = useState(false)

  return (
    <TooltipProvider>
      <div className="max-w-sm w-[300px] ml-[52px] h-full border-r-[0.5px] border-[#D7E0E9] flex flex-col select-none bg-white">
        <div className="flex justify-between items-center ml-[18px] mt-[14px]">
          <p className="text-[#1C1D1F] font-medium text-[16px]">Integrations</p>
        </div>
        <div className="flex-1 overflow-auto mt-[15px]">
          <ul>
            <li
              className={`group flex justify-between items-center ${location.pathname.includes("/integrations/google") ? "bg-[#EBEFF2]" : ""} hover:bg-[#EBEFF2] rounded-[6px] pt-[8px] pb-[8px] ml-[8px] mr-[8px]`}
              onClick={() => {
                router.navigate({
                  to:
                    role === UserRole.SuperAdmin || role === UserRole.Admin
                      ? "/admin/integrations/google"
                      : "/integrations/google",
                })
              }}
            >
              <img width={16} src={GoogleSvg} className="ml-[8px]" />
              <span className="text-[14px] pl-[10px] pr-[10px] truncate cursor-pointer flex-grow max-w-[250px]">
                Google
              </span>
            </li>
            <li
              className={`group flex justify-between items-center ${location.pathname.includes("/integrations/slack") ? "bg-[#EBEFF2]" : ""} hover:bg-[#EBEFF2] rounded-[6px] pt-[8px] pb-[8px] ml-[8px] mr-[8px]`}
              onClick={() => {
                router.navigate({
                  to: "/integrations/slack",
                })
              }}
            >
              <img width={16} src={SlackSvg} className="ml-[8px]" />
              <span className="text-[14px] pl-[10px] pr-[10px] truncate cursor-pointer flex-grow max-w-[250px]">
                Slack
              </span>
            </li>
            <li className="group">
              <div
                className={`flex justify-between items-center ${location.pathname.includes("/integrations/private-store") ? "bg-[#EBEFF2]" : ""} hover:bg-[#EBEFF2] rounded-[6px] pt-[8px] pb-[8px] ml-[8px] mr-[8px] cursor-pointer`}
                onClick={() => setIsMarkdownOpen(!isMarkdownOpen)}
              >
                <div className="flex items-center flex-grow">
                  <Database className="w-4 h-4 ml-[8px] text-[#5D6878]" />
                  <span className="text-[14px] pl-[10px] pr-[10px] truncate flex-grow max-w-[200px]">
                    PrivateStore
                  </span>
                </div>
                {isMarkdownOpen ? (
                  <ChevronDown className="w-4 h-4 text-gray-500 mr-2" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-500 mr-2" />
                )}
              </div>
              {isMarkdownOpen && (
                <ul className="ml-[8px] mt-1">
                  <li
                    className={`flex items-center ${location.pathname.includes("/integrations/private-store") ? "bg-[#EBEFF2]" : ""} hover:bg-[#EBEFF2] rounded-[6px] py-[8px] px-[8px] mx-[8px] cursor-pointer`}
                    onClick={() => {
                      router.navigate({
                        to:
                          role === UserRole.SuperAdmin ||
                          role === UserRole.Admin
                            ? "/admin/integrations/private-store"
                            : "/integrations/private-store",
                      })
                    }}
                  >
                    <img width={14} src={MarkdownSvg} className="ml-[24px]" />
                    <span className="text-[14px] pl-[10px] pr-[10px] truncate text-[#1C1D1F]">
                      Markdown
                    </span>
                  </li>
                </ul>
              )}
            </li>
          </ul>
        </div>
      </div>
    </TooltipProvider>
  )
}
