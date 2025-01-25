import { Link, useLocation } from "@tanstack/react-router";
import { Plug, Plus, History } from "lucide-react";
import { useState } from "react";
import HistoryModal from "@/components/HistoryModal";
import { UserRole } from "shared/types";
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tip } from "@/components/Tooltip";
import Logo from '@/assets/logo.svg'

export const Sidebar = ({
  className = "",
  photoLink = "",
  role = "",
}: {
  className?: string;
  photoLink?: string;
  role?: string;
}) => {
  const location = useLocation();
  const [showHistory, setShowHistory] = useState<boolean>(false);
  return (
    <TooltipProvider>
      <div
        className={`bg-white h-full w-[52px] border-r-[0.5px] border-[#D7E0E9] flex flex-col items-center space-y-[10px] fixed ${className} z-20 select-none`}
      >
        {photoLink && (
          <img
            className="w-[32px] h-[32px] mt-[16px] rounded-full mb-[15px]"
            src={`/api/v1/proxy/${encodeURIComponent(photoLink)}`}
            alt="Profile"
          />
        )}
        <Link
          to="/"
          className="flex w-[32px] h-[32px] border-[1px] border-[#C4D0DC] items-center justify-center rounded-[6px]"
        >
                    <Tooltip>
                    <TooltipTrigger asChild>
          <Plus size={18} stroke="#384049" />
          </TooltipTrigger>
            <Tip side="right" info="Home" />
          </Tooltip>
        </Link>
        <div
          onClick={() => setShowHistory((history) => !history)}
          className={`flex w-[32px] h-[32px] ${showHistory ? "bg-[#D8DFE680]" : ""} rounded-[8px] items-center justify-center cursor-pointer  hover:bg-[#D8DFE680]`}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <History size={18} stroke="#384049" />
            </TooltipTrigger>
            <Tip side="right" info="History" />
          </Tooltip>
        </div>
        <Link
          to={`${role === UserRole.SuperAdmin || role === UserRole.Admin ? "/admin/integrations" : "/integrations"}`}
          className="flex w-[32px] h-[32px] items-center justify-center hover:bg-[#D8DFE680] rounded-[6px]"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Plug
                stroke="#384049"
                size={18}
                {...(location.pathname === "/admin/integrations" ||
                location.pathname === "/integrations"
                  ? { className: "text-blue-500 hover:text-blue-600" }
                  : { className: "hover:text-blue-600" })}
              />
            </TooltipTrigger>
            <Tip side="right" info="Integrations" />
          </Tooltip>
        </Link>
        {showHistory && (
          <HistoryModal
            pathname={location.pathname}
            onClose={() => setShowHistory(false)}
          />
        )}
        <img style={{marginTop: "auto", marginBottom: "16px"}} src={Logo} />
      </div>
    </TooltipProvider>
  );
};
