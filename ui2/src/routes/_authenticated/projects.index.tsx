import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { FolderOpen, Plus } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Topbar } from "@/components/Topbar"
import { SearchField } from "@/components/file-browser"
import { CreateProjectModal } from "@/components/projects/CreateProjectModal"
import {
  projectsStore,
  useProjects,
} from "@/lib/projects-store"
import type { Project } from "@/lib/api"

export const Route = createFileRoute("/_authenticated/projects/")({
  component: ProjectsIndexRoute,
})

function ProjectsIndexRoute(): JSX.Element {
  const projects = useProjects()
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [loaded, setLoaded] = useState(projectsStore.isAllLoaded())
  const [error, setError] = useState<string | null>(null)

  useEffect((): (() => void) => {
    let cancelled = false
    projectsStore
      .loadAll()
      .then((): void => {
        if (!cancelled) setLoaded(true)
      })
      .catch((err: Error): void => {
        if (!cancelled) setError(err.message)
      })
    return (): void => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo<Project[]>(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return projects
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.description ?? "").toLowerCase().includes(needle),
    )
  }, [projects, query])

  const count = filtered.length
  const showingSearch = query.trim().length > 0

  return (
    <div className="flex h-full flex-col">
      <Topbar title="Projects" />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/70 px-5 py-2.5 backdrop-blur-md">
        <span className="text-[13px] font-medium text-foreground">Projects</span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={(): void => {
              setCreateOpen(true)
            }}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] font-medium text-foreground transition hover:bg-secondary"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            New project
          </button>
          <SearchField
            value={query}
            onChange={setQuery}
            className="w-56"
            ariaLabel="Search projects"
            placeholder="Search projects"
          />
        </div>
      </div>

      <main className="flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto w-full max-w-7xl">
          <p className="mb-3 text-[12px] text-muted-foreground">
            {!loaded
              ? "Loading…"
              : count === 0
                ? showingSearch
                  ? "No matches"
                  : "No projects yet"
                : `${String(count)} project${count === 1 ? "" : "s"}`}
          </p>

          {error ? (
            <ErrorPane message={error} />
          ) : !loaded ? (
            <SkeletonGrid />
          ) : count === 0 ? (
            <EmptyPane
              searching={showingSearch}
              query={query}
              onCreate={(): void => {
                setCreateOpen(true)
              }}
            />
          ) : (
            <ul className="grid animate-fade-up grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.map((project) => (
                <li key={project.id}>
                  <ProjectCard project={project} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>

      <CreateProjectModal
        open={createOpen}
        mode="create"
        onClose={(): void => {
          setCreateOpen(false)
        }}
        onSubmit={async (input): Promise<void> => {
          const created = await projectsStore.createProject(input)
          setCreateOpen(false)
          await navigate({
            to: "/projects/$projectId",
            params: { projectId: created.id },
          })
        }}
      />
    </div>
  )
}

function ProjectCard({ project }: { project: Project }): JSX.Element {
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      className="flex h-full w-full flex-col items-start gap-3 rounded-2xl border border-border bg-surface-elevated p-4 text-left transition hover:border-ring/40 hover:bg-secondary/60 active:scale-[0.99]"
      title={project.name}
    >
      <span
        aria-hidden
        className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-surface-muted text-foreground"
      >
        <FolderOpen className="h-5 w-5" strokeWidth={1.5} />
      </span>
      <span className="flex w-full min-w-0 flex-col gap-0.5">
        <span className="truncate text-[13.5px] font-medium text-foreground">
          {project.name}
        </span>
        <span className="line-clamp-2 min-h-[2rem] text-[11.5px] leading-snug text-muted-foreground">
          {project.description?.trim() || (
            <span className="italic text-muted-foreground/70">
              No description.
            </span>
          )}
        </span>
      </span>
    </Link>
  )
}

function SkeletonGrid(): JSX.Element {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <li
          key={i}
          className="h-[148px] animate-breathe rounded-2xl border border-border bg-surface-elevated"
          aria-hidden
        />
      ))}
    </ul>
  )
}

function EmptyPane({
  searching,
  query,
  onCreate,
}: {
  searching: boolean
  query: string
  onCreate: () => void
}): JSX.Element {
  const headline = searching ? "No matches" : "No projects yet"
  const detail = searching
    ? `We couldn${"’"}t find a project matching "${query}". Try a broader term.`
    : "Group related chats into projects so you can jump back into them quickly."
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-24 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-muted text-muted-foreground">
        <FolderOpen className="h-5 w-5" aria-hidden strokeWidth={1.5} />
      </span>
      <p className="text-[14px] font-medium text-foreground">{headline}</p>
      <p className="max-w-xs text-[12.5px] text-muted-foreground">{detail}</p>
      {!searching ? (
        <button
          type="button"
          onClick={onCreate}
          className="mt-1 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] font-medium text-foreground transition hover:bg-secondary"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          New project
        </button>
      ) : null}
    </div>
  )
}

function ErrorPane({ message }: { message: string }): JSX.Element {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
      Couldn&apos;t load projects — {message}
    </div>
  )
}
