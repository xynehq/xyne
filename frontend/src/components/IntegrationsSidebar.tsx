import { TooltipProvider } from "@/components/ui/tooltip"
import { UserRole } from "shared/types"
import SlackSvg from "@/assets/slack.svg"
import GoogleSvg from "@/assets/google-logo.svg"
import GithubSvg from "@/assets/github.svg"
import microsoftSvg from "@/assets/microsoft.svg"
import { useLocation, useRouter } from "@tanstack/react-router"
import {  Key } from "lucide-react"

export const IntegrationsSidebar = ({
  role,
 
}: { role: string; isAgentMode: boolean }) => {
  const router = useRouter()
  const location = useLocation()
  return (
    <TooltipProvider>
      <div className="max-w-sm w-[300px] ml-[52px] h-full border-r-[0.5px] border-[#D7E0E9] dark:border-gray-700 flex flex-col select-none bg-white dark:bg-[#1E1E1E]">
        <div className="flex justify-between items-center ml-[18px] mt-[14px]">
          <p className="text-[#1C1D1F] dark:text-gray-100 font-medium text-[16px]">
            Integrations
          </p>
        </div>
        <div className="flex-1 overflow-auto mt-[15px]">
          <ul>
            <li
              className={`group flex justify-between items-center ${location.pathname.includes("/integrations/google") ? "bg-[#EBEFF2] dark:bg-slate-700" : ""} hover:bg-[#EBEFF2] dark:hover:bg-slate-700 rounded-[6px] pt-[8px] pb-[8px] ml-[8px] mr-[8px] cursor-pointer`}
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
              <span className="text-[14px] dark:text-gray-200 pl-[10px] pr-[10px] truncate cursor-pointer flex-grow max-w-[250px]">
                Google
              </span>
            </li>
            <li
              className={`group flex justify-between items-center ${location.pathname.includes("/integrations/microsoft") ? "bg-[#EBEFF2] dark:bg-slate-700" : ""} hover:bg-[#EBEFF2] dark:hover:bg-slate-700 rounded-[6px] pt-[8px] pb-[8px] ml-[8px] mr-[8px] cursor-pointer`}
              onClick={() => {
                router.navigate({
                  to:
                    role === UserRole.SuperAdmin || role === UserRole.Admin
                      ? "/admin/integrations/microsoft"
                      : "/integrations/microsoft",
                })
              }}
            >
              <img width={16} src={microsoftSvg} className="ml-[8px]" />
              <span className="text-[14px] dark:text-gray-200 pl-[10px] pr-[10px] truncate cursor-pointer flex-grow max-w-[250px]">
                Microsoft
              </span>
            </li>
            <li
              className={`group flex justify-between items-center ${location.pathname.includes("/integrations/slack") ? "bg-[#EBEFF2] dark:bg-slate-700" : ""} hover:bg-[#EBEFF2] dark:hover:bg-slate-700 rounded-[6px] pt-[8px] pb-[8px] ml-[8px] mr-[8px] cursor-pointer`}
              onClick={() => {
                router.navigate({
                  to:
                    // role === UserRole.SuperAdmin || role === UserRole.Admin
                    "/integrations/slack",
                  // : "/integrations/slack",
                })
              }}
            >
              <img width={16} src={SlackSvg} className="ml-[8px]" />
              <span className="text-[14px] dark:text-gray-200 pl-[10px] pr-[10px] truncate cursor-pointer flex-grow max-w-[250px]">
                Slack
              </span>
            </li>
            <li
              className={`group flex justify-between items-center ${location.pathname.includes("/integrations/mcp") ? "bg-[#EBEFF2] dark:bg-slate-700" : ""} hover:bg-[#EBEFF2] dark:hover:bg-slate-700 rounded-[6px] pt-[8px] pb-[8px] ml-[8px] mr-[8px] cursor-pointer`}
              onClick={() => {
                router.navigate({
                  to:
                    // role === UserRole.SuperAdmin || role === UserRole.Admin
                    "/integrations/mcp",
                  // : "/integrations/slack",
                })
              }}
            >
              <img width={16} src={GithubSvg} className="ml-[8px]" />
              <span className="text-[14px] dark:text-gray-200 pl-[10px] pr-[10px] truncate cursor-pointer flex-grow max-w-[250px]">
                Github
              </span>
            </li>
            
            <li
              className={`group flex justify-between items-center ${location.pathname.includes("/integrations/apiKey") ? "bg-[#EBEFF2] dark:bg-slate-700" : ""} hover:bg-[#EBEFF2] dark:hover:bg-slate-700 rounded-[6px] pt-[8px] pb-[8px] ml-[8px] mr-[8px] cursor-pointer`}
              onClick={() => {
                router.navigate({
                  to: "/integrations/apiKey",
                })
              }}
            >
              <Key className="w-4 h-4 ml-[8px] dark:text-gray-300" />
              <span className="text-[14px] dark:text-gray-200 pl-[10px] pr-[10px] truncate cursor-pointer flex-grow max-w-[250px]">
                API Keys
              </span>
            </li>
          </ul>
        </div>
      </div>
    </TooltipProvider>
  )
}