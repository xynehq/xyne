import { NavLink, Outlet } from "react-router-dom"
import { useAuth } from "@/auth"
import { FileText, Settings, LogOut, Moon, Sun } from "lucide-react"
import { cn } from "@/lib/utils"
import { useTheme } from "@/hooks/useTheme"

const navItems = [
  { to: "/documents", label: "Documents", icon: FileText },
  { to: "/settings", label: "Settings", icon: Settings },
]

export function Layout() {
  const { user, logout } = useAuth()
  const { theme, toggle } = useTheme()

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-60 border-r bg-card flex flex-col">
        <div className="p-5 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-[#FFD6D6] dark:bg-[#FF4F4F]/20 flex items-center justify-center">
              <span className="text-sm font-bold text-[#FF4F4F]">X</span>
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold tracking-tight truncate">
                Xyne SDK
              </h1>
              <p className="text-xs text-muted-foreground truncate">
                {user?.email}
              </p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="px-3 pb-3 space-y-1">
          <button
            onClick={toggle}
            className="flex items-center gap-3 px-3 py-2 w-full rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
            {theme === "dark" ? "Light Mode" : "Dark Mode"}
          </button>
          <button
            onClick={logout}
            className="flex items-center gap-3 px-3 py-2 w-full rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
