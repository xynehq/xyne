// Singleton store for the Projects feature. Mirrors chat-store's pattern:
//   • singleton state outside the React tree
//   • subscribers via useSyncExternalStore
//   • two listener buckets (full list vs. top-N) so the sidebar's most-used
//     section doesn't re-render on every full-list refresh and vice versa.
//
// The "move a conversation into / out of a project" actions live here because
// the API endpoints live under /v2/folders/*. We piggy-back chatStore for the
// local conversation-side state update so the sidebar's Recents list reflects
// the new folder without a re-fetch.

import { useSyncExternalStore } from "react"

import {
  type Project,
  type ProjectWithActivity,
  addConversationToProject,
  createProject as apiCreateProject,
  deleteProject as apiDeleteProject,
  updateProject as apiUpdateProject,
  listProjectConversations,
  listProjects,
  listTopProjects,
  removeConversationFromProject,
} from "./api"
import { chatStore } from "./chat-store"
import { toast } from "@/components/Toast"

/** Lightweight view of a conversation inside a project — same shape the
 *  /v2/chat/conversations endpoint returns when filtered by folderId. */
export type ProjectConv = {
  id: string
  title: string
  folderId?: string
  createdAt: number
  updatedAt: number
}

// ─── State ─────────────────────────────────────────────────────────────────
let allProjects: Project[] = []
let topProjects: ProjectWithActivity[] = []
let allLoaded = false
let topLoaded = false

const allListeners = new Set<() => void>()
const topListeners = new Set<() => void>()
const projectListeners = new Map<string, Set<() => void>>()
const projectsById = new Map<string, Project>()
// Per-project conversation list cache. Project detail pages subscribe via
// `useProjectConversations(projectId)` and `moveConversation` mutates the
// relevant entries so an open detail page reflects a drop/move without a
// manual refresh.
const conversationsByProject = new Map<string, ProjectConv[]>()
const projectConvListeners = new Map<string, Set<() => void>>()
const projectConvInFlight = new Map<string, Promise<void>>()

const notifyAll = (): void => {
  for (const fn of allListeners) fn()
}
const notifyTop = (): void => {
  for (const fn of topListeners) fn()
}
const notifyProject = (id: string): void => {
  const set = projectListeners.get(id)
  if (!set) return
  for (const fn of set) fn()
}
const notifyProjectConvs = (projectId: string): void => {
  const set = projectConvListeners.get(projectId)
  if (!set) return
  for (const fn of set) fn()
}

const upsert = (p: Project): void => {
  projectsById.set(p.id, p)
  notifyProject(p.id)
}

// In-flight de-duping so calling load*() during a route mount + a sidebar
// render doesn't fire the same GET twice.
let allInFlight: Promise<void> | null = null
let topInFlight: Promise<void> | null = null

// ─── Loaders ───────────────────────────────────────────────────────────────
const reloadAll = async (): Promise<void> => {
  const projects = await listProjects()
  allProjects = projects
  for (const p of projects) projectsById.set(p.id, p)
  allLoaded = true
  notifyAll()
}

const reloadTop = async (limit = 3): Promise<void> => {
  const projects = await listTopProjects(limit)
  topProjects = projects
  for (const p of projects) projectsById.set(p.id, p)
  topLoaded = true
  notifyTop()
}

// ─── Public actions ────────────────────────────────────────────────────────
export const projectsStore = {
  // Reads ────────────────────────────────────────────────────────────────
  getAll(): Project[] {
    return allProjects
  },
  getTop(): ProjectWithActivity[] {
    return topProjects
  },
  getProject(id: string): Project | null {
    return projectsById.get(id) ?? null
  },
  isAllLoaded(): boolean {
    return allLoaded
  },
  isTopLoaded(): boolean {
    return topLoaded
  },

  // Subscribes ───────────────────────────────────────────────────────────
  subscribeAll(listener: () => void): () => void {
    allListeners.add(listener)
    return () => {
      allListeners.delete(listener)
    }
  },
  subscribeTop(listener: () => void): () => void {
    topListeners.add(listener)
    return () => {
      topListeners.delete(listener)
    }
  },
  subscribeProject(id: string, listener: () => void): () => void {
    let set = projectListeners.get(id)
    if (!set) {
      set = new Set()
      projectListeners.set(id, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) projectListeners.delete(id)
    }
  },
  subscribeProjectConversations(
    projectId: string,
    listener: () => void,
  ): () => void {
    let set = projectConvListeners.get(projectId)
    if (!set) {
      set = new Set()
      projectConvListeners.set(projectId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) projectConvListeners.delete(projectId)
    }
  },
  getProjectConversations(projectId: string): ProjectConv[] | null {
    return conversationsByProject.get(projectId) ?? null
  },

  // Loaders ──────────────────────────────────────────────────────────────
  async loadAll(): Promise<void> {
    if (allInFlight) return allInFlight
    allInFlight = reloadAll().finally(() => {
      allInFlight = null
    })
    return allInFlight
  },
  async loadTop(limit = 3): Promise<void> {
    if (topInFlight) return topInFlight
    topInFlight = reloadTop(limit).finally(() => {
      topInFlight = null
    })
    return topInFlight
  },
  /** Fetch a single project + populate cache. Cache-first: returns the
   *  cached row immediately if we have it, so navigating between projects
   *  doesn't flash a placeholder while a redundant network round-trip runs.
   *  Mutations (create / rename / delete / move) keep the cache in sync, so
   *  this is safe for the single-tab usage pattern. */
  async loadProject(id: string): Promise<Project> {
    const cached = projectsById.get(id)
    if (cached) return cached
    const { getProject } = await import("./api")
    const project = await getProject(id)
    upsert(project)
    return project
  },
  /** Fetch and cache the conversation list for a project. Cache-first for
   *  the same reason as `loadProject` — re-visiting a project we've seen
   *  before should feel instant. Moves/renames/deletes mutate the cache
   *  in place so the data stays correct without a re-fetch. */
  async loadProjectConversations(projectId: string): Promise<void> {
    if (conversationsByProject.has(projectId)) return
    const inflight = projectConvInFlight.get(projectId)
    if (inflight) return inflight
    const promise = (async (): Promise<void> => {
      const res = await listProjectConversations(projectId, { limit: 200 })
      conversationsByProject.set(projectId, res.items)
      notifyProjectConvs(projectId)
    })().finally(() => {
      projectConvInFlight.delete(projectId)
    })
    projectConvInFlight.set(projectId, promise)
    return promise
  },

  // Mutations ────────────────────────────────────────────────────────────
  async createProject(input: {
    name: string
    description?: string | null
  }): Promise<Project> {
    const created = await apiCreateProject(input)
    upsert(created)
    // Prepend to both lists so the sidebar shows the new project immediately
    // (even before the next refresh of most-used reorders by activity).
    allProjects = [created, ...allProjects.filter((p) => p.id !== created.id)]
    notifyAll()
    if (topLoaded) {
      topProjects = [
        {
          ...created,
          lastTouchedAt: null,
          conversationCount: 0,
        },
        ...topProjects.filter((p) => p.id !== created.id),
      ].slice(0, Math.max(topProjects.length, 3))
      notifyTop()
    }
    return created
  },

  async renameProject(
    id: string,
    patch: { name?: string; description?: string | null },
  ): Promise<Project> {
    const updated = await apiUpdateProject(id, patch)
    upsert(updated)
    const reflect = (arr: Project[]): Project[] => {
      const i = arr.findIndex((p) => p.id === id)
      if (i < 0) return arr
      const next = arr.slice()
      next[i] = { ...next[i]!, ...updated }
      return next
    }
    allProjects = reflect(allProjects)
    notifyAll()
    if (topLoaded) {
      const i = topProjects.findIndex((p) => p.id === id)
      if (i >= 0) {
        const next = topProjects.slice()
        const existing = next[i]!
        next[i] = {
          ...existing,
          ...updated,
          lastTouchedAt: existing.lastTouchedAt,
          conversationCount: existing.conversationCount,
        }
        topProjects = next
        notifyTop()
      }
    }
    return updated
  },

  /** Rename a conversation. Wraps chatStore so the per-project cache stays
   *  in sync — useful when the rename happens from the project detail page. */
  async renameConversation(convId: string, title: string): Promise<void> {
    await chatStore.renameConv(convId, title)
    const trimmed = title.trim()
    for (const [projectId, convs] of conversationsByProject) {
      const idx = convs.findIndex((c) => c.id === convId)
      if (idx < 0) continue
      const next = convs.slice()
      next[idx] = { ...next[idx]!, title: trimmed, updatedAt: Date.now() }
      conversationsByProject.set(projectId, next)
      notifyProjectConvs(projectId)
    }
  },

  /** Soft-delete a conversation. Calls chatStore (which hits the API +
   *  clears its own caches), then removes the row from every per-project
   *  cache so any open project detail page reflects the deletion. */
  async deleteConversation(convId: string): Promise<void> {
    await chatStore.deleteConv(convId)
    for (const [projectId, convs] of conversationsByProject) {
      const filtered = convs.filter((c) => c.id !== convId)
      if (filtered.length === convs.length) continue
      conversationsByProject.set(projectId, filtered)
      notifyProjectConvs(projectId)
    }
  },

  async deleteProject(id: string): Promise<void> {
    const existing = projectsById.get(id)
    try {
      await apiDeleteProject(id)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't delete project",
      )
      throw err
    }
    projectsById.delete(id)
    allProjects = allProjects.filter((p) => p.id !== id)
    topProjects = topProjects.filter((p) => p.id !== id)
    notifyAll()
    notifyTop()
    notifyProject(id)
    toast.success(
      existing ? `Deleted "${existing.name}"` : "Project deleted",
    )
  },

  /** Move a conversation into a project, or remove it from its current
   *  project when `destFolderId` is null. The endpoint shape is folder-
   *  rooted (per the API design), so we route through PATCH for assign and
   *  DELETE for unassign — chat-store's local view of the conversation is
   *  updated synchronously so the sidebar shows the new state immediately. */
  async moveConversation(
    conversationId: string,
    destFolderId: string | null,
  ): Promise<void> {
    const currentFolderId = chatStore.getConvFolder(conversationId)
    if (destFolderId === currentFolderId) return // no-op
    try {
      if (destFolderId !== null) {
        // Assign / move to a different folder. PATCH is idempotent and works
        // regardless of where the conversation was before.
        await addConversationToProject(destFolderId, conversationId)
      } else {
        // Explicit unfile. Needs the *current* folder in the URL because the
        // server scopes the DELETE to (folder, conversation).
        if (!currentFolderId) return
        await removeConversationFromProject(currentFolderId, conversationId)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't move chat")
      throw err
    }
    chatStore.setConvFolderLocally(conversationId, destFolderId)
    // Mutate the per-project conversation caches so any open project detail
    // page reflects the move without a manual refresh. Only touches lists
    // that have actually been loaded — a never-visited project doesn't get
    // a stale entry seeded behind its back.
    if (currentFolderId && conversationsByProject.has(currentFolderId)) {
      const src = conversationsByProject.get(currentFolderId) ?? []
      conversationsByProject.set(
        currentFolderId,
        src.filter((c) => c.id !== conversationId),
      )
      notifyProjectConvs(currentFolderId)
    }
    if (destFolderId && conversationsByProject.has(destFolderId)) {
      const fromChat = chatStore.getList().find((c) => c.id === conversationId)
      if (fromChat) {
        const dest = conversationsByProject.get(destFolderId) ?? []
        const entry: ProjectConv = {
          id: fromChat.id,
          title: fromChat.title,
          folderId: destFolderId,
          createdAt: fromChat.createdAt,
          updatedAt: Date.now(),
        }
        // Most-recently-touched first; replace any existing row for this id
        // so a move-within-the-same-project (no-op above) wouldn't dupe.
        conversationsByProject.set(destFolderId, [
          entry,
          ...dest.filter((c) => c.id !== conversationId),
        ])
        notifyProjectConvs(destFolderId)
      }
    }
    const destName = destFolderId
      ? projectsById.get(destFolderId)?.name
      : null
    if (destFolderId) {
      toast.success(destName ? `Moved to "${destName}"` : "Moved to project")
    } else {
      toast.success("Removed from project")
    }
    // Re-rank in the background so the sidebar's most-used order catches up
    // with the bumped lastTouchedAt the server just recorded. Deferred to a
    // microtask + skipped when the destination is already in the top list,
    // so the drop event finishes without a re-render storm racing the
    // droppable rect measurement.
    if (
      destFolderId &&
      topLoaded &&
      !topProjects.some((p) => p.id === destFolderId)
    ) {
      queueMicrotask((): void => {
        void reloadTop()
      })
    }
  },
}

// ─── React hooks ────────────────────────────────────────────────────────────
export function useProjects(): Project[] {
  return useSyncExternalStore(
    (l) => projectsStore.subscribeAll(l),
    () => projectsStore.getAll(),
    () => projectsStore.getAll(),
  )
}

export function useTopProjects(): ProjectWithActivity[] {
  return useSyncExternalStore(
    (l) => projectsStore.subscribeTop(l),
    () => projectsStore.getTop(),
    () => projectsStore.getTop(),
  )
}

export function useProject(id: string): Project | null {
  return useSyncExternalStore(
    (l) => projectsStore.subscribeProject(id, l),
    () => projectsStore.getProject(id),
    () => projectsStore.getProject(id),
  )
}

export function useProjectConversations(
  projectId: string,
): ProjectConv[] | null {
  return useSyncExternalStore(
    (l) => projectsStore.subscribeProjectConversations(projectId, l),
    () => projectsStore.getProjectConversations(projectId),
    () => projectsStore.getProjectConversations(projectId),
  )
}
