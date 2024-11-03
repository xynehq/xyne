import { Link, useLocation } from "@tanstack/react-router"
import {
  Home,
  Search,
  Settings,
  Bell,
  User,
  Plug,
  MessageSquarePlus,
} from "lucide-react"

export const Sidebar = ({ className = "" }: { className?: string }) => {
  const location = useLocation()
  return (
    <div
      className={`h-full w-[52px] bg-gray-100 p-4 flex flex-col items-center space-y-6 fixed ${className} z-20`}
    >
      <Link to="/">
        <Home
          size={18}
          {...(location.pathname === "/"
            ? { className: "text-blue-500 hover:text-blue-600" }
            : { className: "hover:text-blue-600" })}
        />
      </Link>
      <Link to="/search">
        <Search
          size={18}
          {...(location.pathname === "/search"
            ? { className: "text-blue-500 hover:text-blue-600" }
            : { className: "hover:text-blue-600" })}
        />
      </Link>
      <Link to="/chat">
        <MessageSquarePlus
          size={18}
          {...(location.pathname === "/_authenticated/chat"
            ? { className: "text-blue-500 hover:text-blue-600" }
            : { className: "hover:text-blue-600" })}
        />
      </Link>
      {
        // @ts-ignore
        <Link to="/notifications" className="hover:text-blue-500">
          <Bell size={18} />
        </Link>
      }
      <Link to="/admin/integrations">
        <Plug
          size={18}
          {...(location.pathname === "/admin/integrations"
            ? { className: "text-blue-500 hover:text-blue-600" }
            : { className: "hover:text-blue-600" })}
        />
      </Link>
      {
        // @ts-ignore
        <Link to="/profile" className="hover:text-blue-500">
          <User size={18} />
        </Link>
      }
      {
        // @ts-ignore
        <Link to="/settings" className="hover:text-blue-500 mt-auto">
          <Settings size={18} />
        </Link>
      }
    </div>
  )
}
