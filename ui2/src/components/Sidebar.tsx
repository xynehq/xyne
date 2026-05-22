import { Link, useLocation } from "@tanstack/react-router"
import {
  Bot,
  FolderTree,
  MessageSquarePlus,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sun,
} from "lucide-react"
import { useTheme, type ThemeMode } from "@/lib/theme"
import { useSidebarCollapse } from "@/hooks/useSidebarCollapse"
import { useSidebarMobile } from "@/hooks/useSidebarMobile"
import { useSidebarSearch } from "@/hooks/useSidebarSearch"
import { BrandMark } from "./BrandMark"
import { SidebarNavItem } from "./SidebarNavItem"
import { ChatHistory, type ChatHistoryItem } from "./ChatHistory"
import { ProjectsSection } from "./projects/ProjectsSection"

type Props = {
  me?: { email: string; role: string } | undefined
  chats: ChatHistoryItem[]
  activeChatId?: string | undefined
  chatsLoading?: boolean | undefined
  onCreateChat: () => void
  onSelectChat: (id: string) => void
  onRenameChat: (id: string, title: string) => Promise<void>
  onDeleteChat: (id: string) => Promise<void>
  onAccount?: () => void
}

function initials(email: string): string {
  const local = email.split("@")[0] ?? email
  const parts = local.split(/[._-]+/).filter(Boolean)
  const a = parts[0]?.[0] ?? "?"
  const b = parts[1]?.[0] ?? ""
  return (a + b).toUpperCase()
}

export function Sidebar({
  me,
  chats,
  activeChatId,
  chatsLoading,
  onCreateChat,
  onSelectChat,
  onRenameChat,
  onDeleteChat,
  onAccount,
}: Props): JSX.Element {
  const { collapsed, toggle: onToggle } = useSidebarCollapse()
  const { open: mobileOpen, setOpen: setMobileOpen } = useSidebarMobile()
  const { query, setQuery, searchRef, focusSearch } = useSidebarSearch({
    collapsed,
    expand: onToggle,
  })

  const closeMobile = (): void => {
    setMobileOpen(false)
  }
  const handleCreateChat = (): void => {
    onCreateChat()
    closeMobile()
  }
  const handleSelectChat = (id: string): void => {
    onSelectChat(id)
    closeMobile()
  }

  const showExpanded = !collapsed || mobileOpen

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={closeMobile}
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
        />
      )}
      <aside
        id="app-sidebar"
        aria-label="Sidebar"
        className={
          "fixed inset-y-0 left-0 z-40 h-full w-[280px] flex-shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar transition-[transform,width] duration-300 ease-[cubic-bezier(0.2,0.7,0.1,1)] md:static md:translate-x-0 " +
          (mobileOpen ? "translate-x-0 " : "-translate-x-full ") +
          (collapsed ? "md:w-14 " : "md:w-[272px] ")
        }
      >
        {showExpanded ? (
          <ExpandedShell
            me={me}
            collapsed={collapsed}
            query={query}
            setQuery={setQuery}
            searchRef={searchRef}
            chats={chats}
            activeChatId={activeChatId}
            chatsLoading={chatsLoading}
            onToggle={onToggle}
            onCreateChat={handleCreateChat}
            onSelectChat={handleSelectChat}
            onRenameChat={onRenameChat}
            onDeleteChat={onDeleteChat}
            onAccount={onAccount}
          />
        ) : (
          <CollapsedShell
            me={me}
            collapsed={collapsed}
            onToggle={onToggle}
            onCreateChat={onCreateChat}
            onSearchClick={focusSearch}
          />
        )}
      </aside>
    </>
  )
}

type CollapsedProps = {
  me?: { email: string; role: string } | undefined
  collapsed: boolean
  onToggle: () => void
  onCreateChat: () => void
  onSearchClick: () => void
}

function CollapsedShell({
  me,
  collapsed,
  onToggle,
  onCreateChat,
  onSearchClick,
}: CollapsedProps): JSX.Element {
  const { pathname } = useLocation()
  const onKb = pathname.startsWith("/kb")
  const onAgents = pathname.startsWith("/agents")
  return (
    <div className="flex h-full w-14 flex-col items-center py-3">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Expand sidebar"
        aria-expanded={!collapsed}
        aria-controls="app-sidebar"
        title="Expand sidebar  (⌘\\)"
        className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
      >
        <PanelLeftOpen className="h-4 w-4" aria-hidden strokeWidth={1.75} />
      </button>

      <div className="mt-2 flex flex-col items-center gap-1">
        <SidebarNavItem
          icon={MessageSquarePlus}
          label="New chat"
          collapsed
          onClick={onCreateChat}
        />
        <SidebarNavItem
          icon={Search}
          label="Search conversations"
          collapsed
          onClick={onSearchClick}
        />
        <Link
          to="/kb"
          aria-label="Knowledge"
          title="Knowledge"
          className={
            "grid h-9 w-9 place-items-center rounded-lg transition-colors duration-150 " +
            (onKb
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <FolderTree className="h-4 w-4" aria-hidden strokeWidth={1.75} />
        </Link>
        <Link
          to="/agents"
          aria-label="Agents"
          title="Agents"
          className={
            "grid h-9 w-9 place-items-center rounded-lg transition-colors duration-150 " +
            (onAgents
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <Bot className="h-4 w-4" aria-hidden strokeWidth={1.75} />
        </Link>
      </div>

      <div className="flex-1" />

      <CollapsedThemeButton />
      <Link
        to="/account"
        aria-label="Account"
        title={me?.email ?? "Account"}
        className="mt-2 grid h-9 w-9 place-items-center rounded-full bg-primary text-[11px] font-medium text-primary-foreground transition hover:opacity-90"
      >
        {me ? initials(me.email) : "··"}
      </Link>
    </div>
  )
}

function CollapsedThemeButton(): JSX.Element {
  const { theme, setTheme } = useTheme()
  const order: ThemeMode[] = ["light", "dark", "system"]
  const next = order[(order.indexOf(theme) + 1) % order.length] ?? "system"
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor
  const label =
    theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System"
  return (
    <button
      type="button"
      onClick={(): void => {
        setTheme(next)
      }}
      aria-label={`Theme: ${label}`}
      title={`Theme: ${label}`}
      className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
    >
      <Icon className="h-4 w-4" aria-hidden strokeWidth={1.75} />
    </button>
  )
}

type ExpandedProps = {
  me?: { email: string; role: string } | undefined
  collapsed: boolean
  query: string
  setQuery: (next: string) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  chats: ChatHistoryItem[]
  activeChatId?: string | undefined
  chatsLoading?: boolean | undefined
  onToggle: () => void
  onCreateChat: () => void
  onSelectChat: (id: string) => void
  onRenameChat: (id: string, title: string) => Promise<void>
  onDeleteChat: (id: string) => Promise<void>
  onAccount?: (() => void) | undefined
}

function ExpandedShell({
  me,
  collapsed,
  query,
  setQuery,
  searchRef,
  chats,
  activeChatId,
  chatsLoading,
  onToggle,
  onCreateChat,
  onSelectChat,
  onRenameChat,
  onDeleteChat,
  onAccount,
}: ExpandedProps): JSX.Element {
  const { pathname } = useLocation()
  const onKb = pathname.startsWith("/kb")
  const onAgents = pathname.startsWith("/agents")
  return (
    <div className="flex h-full w-[272px] flex-col">
      <header className="flex items-center justify-between px-3 pb-2 pt-3">
        <BrandMark withWordmark size="md" />
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse sidebar"
          aria-expanded={!collapsed}
          aria-controls="app-sidebar"
          title="Collapse sidebar  (⌘\\)"
          className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        >
          <PanelLeftClose className="h-4 w-4" aria-hidden strokeWidth={1.75} />
        </button>
      </header>

      <nav className="flex flex-col gap-0.5 px-2 pt-1">
        <SidebarNavItem
          icon={MessageSquarePlus}
          label="New chat"
          onClick={onCreateChat}
        />
        <Link
          to="/kb"
          aria-current={onKb ? "page" : undefined}
          className={
            "group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors duration-150 " +
            (onKb
              ? "bg-secondary font-medium text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <FolderTree
            className="h-4 w-4 shrink-0"
            aria-hidden
            strokeWidth={1.75}
          />
          <span className="flex-1 truncate text-left">Knowledge</span>
        </Link>
        <Link
          to="/agents"
          aria-current={onAgents ? "page" : undefined}
          className={
            "group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors duration-150 " +
            (onAgents
              ? "bg-secondary font-medium text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
          }
        >
          <Bot className="h-4 w-4 shrink-0" aria-hidden strokeWidth={1.75} />
          <span className="flex-1 truncate text-left">Agents</span>
        </Link>
      </nav>

      <div className="px-3 pb-1 pt-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
            strokeWidth={1.75}
          />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("")
            }}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="h-9 w-full rounded-lg bg-surface-elevated px-3 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <ProjectsSection activeChatId={activeChatId} />
        <ChatHistory
          items={chats}
          activeId={activeChatId}
          loading={chatsLoading}
          query={query}
          onSelect={onSelectChat}
          onRename={onRenameChat}
          onDelete={onDeleteChat}
        />
      </div>

      <footer className="flex items-center gap-1 border-t border-sidebar-border px-3 py-3">
        <button
          type="button"
          onClick={onAccount}
          title={me?.email ?? "Account"}
          className="group inline-flex min-w-0 flex-1 items-center gap-2 rounded-full px-1.5 py-1 transition-colors hover:bg-secondary/70"
        >
          <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-primary text-[11px] font-medium text-primary-foreground">
            {me ? initials(me.email) : "··"}
          </span>
          {me?.email ? (
            <span className="truncate text-[13px] text-muted-foreground group-hover:text-foreground">
              {me.email}
            </span>
          ) : null}
        </button>
        <CollapsedThemeButton />
      </footer>
    </div>
  )
}
