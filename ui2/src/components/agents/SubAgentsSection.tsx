import { useState } from "react"
import { Pencil, Plus, Trash2 } from "lucide-react"

import type {
  AgentToolDescriptor,
  SubAgent,
  SubAgentCreateInput,
  SubAgentUpdateInput,
} from "@/lib/api"
import {
  createSubAgent,
  deleteSubAgent,
  SUB_AGENT_THINKING_LEVELS,
  updateSubAgent,
} from "@/lib/api"

import { ToolPicker } from "./ToolPicker"

// Empty draft used both when adding a brand-new sub-agent and as the
// reset value when an inline edit is cancelled. Tools defaults to []
// ("all tools" semantics) so a new sub-agent inherits the full registry
// unless the author explicitly picks a subset.
const emptyDraft = (): SubAgentCreateInput => ({
  name: "",
  description: "",
  systemPrompt: "",
  tools: [],
  // "medium" is the same default the server stores at row creation; the
  // form mirrors it so an unedited new sub-agent matches what would land
  // in the DB anyway.
  thinkingLevel: "medium",
})

const fromExisting = (s: SubAgent): SubAgentCreateInput => ({
  name: s.name,
  description: s.description,
  systemPrompt: s.systemPrompt,
  tools: s.tools,
  thinkingLevel: s.thinkingLevel,
})

/** Manages the sub_agents rows under a given parent agent. Each
 *  add/edit/delete writes directly to the API — no piggybacking on the
 *  parent's Save button — because sub-agents are independent rows with
 *  their own lifecycle (created in M3, dispatched in M7).
 *
 *  State is LIFTED to AgentForm: the parent fetches the list once and
 *  passes it in via `subAgents`, then this component calls `onMutate()`
 *  after every successful create/update/delete so the parent re-fetches.
 *  That lets the parent decide whether to render the "Sub-agents"
 *  PromptSection in the Behaviour block (only when count > 0). */
export function SubAgentsSection({
  parentExternalId,
  subAgents,
  onMutate,
  toolCatalog,
}: {
  parentExternalId: string
  /** null while the parent's initial load is in flight; [] when loaded
   *  with zero rows; populated otherwise. */
  subAgents: SubAgent[] | null
  /** Called after every successful mutation so the parent can refresh
   *  its lifted state. Awaited so the editor closes only once the new
   *  state is reflected upstream. */
  onMutate: () => Promise<void>
  toolCatalog: AgentToolDescriptor[]
}): JSX.Element {
  const rows = subAgents
  const [loadError, setLoadError] = useState<string | null>(null)
  // `editing` is the external_id of the row whose inline form is open,
  // "new" for the add form, or null when no form is open. Mutually
  // exclusive — at most one form open at a time so the UI stays scannable.
  const [editing, setEditing] = useState<string | "new" | null>(null)
  const [draft, setDraft] = useState<SubAgentCreateInput>(emptyDraft())
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const startCreate = (): void => {
    setDraft(emptyDraft())
    setSubmitError(null)
    setEditing("new")
  }

  const startEdit = (s: SubAgent): void => {
    setDraft(fromExisting(s))
    setSubmitError(null)
    setEditing(s.externalId)
  }

  const cancelEdit = (): void => {
    setEditing(null)
    setDraft(emptyDraft())
    setSubmitError(null)
  }

  const handleSubmit = async (): Promise<void> => {
    const name = draft.name.trim()
    const description = draft.description.trim()
    const systemPrompt = draft.systemPrompt.trim()
    if (!name || !description || !systemPrompt) {
      setSubmitError(
        "Name, description, and system prompt are all required.",
      )
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (editing === "new") {
        await createSubAgent(parentExternalId, {
          name,
          description,
          systemPrompt,
          tools: draft.tools ?? [],
          thinkingLevel: draft.thinkingLevel ?? "medium",
        })
      } else if (editing) {
        // PATCH — send only what could have changed. Letting the server
        // diff is simpler than computing the delta in the UI.
        const payload: SubAgentUpdateInput = {
          name,
          description,
          systemPrompt,
          tools: draft.tools ?? [],
          thinkingLevel: draft.thinkingLevel ?? "medium",
        }
        await updateSubAgent(parentExternalId, editing, payload)
      }
      await onMutate()
      cancelEdit()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (s: SubAgent): Promise<void> => {
    if (!confirm(`Delete sub-agent "${s.name}"? This can't be undone.`)) {
      return
    }
    try {
      await deleteSubAgent(parentExternalId, s.externalId)
      await onMutate()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Delete failed")
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11.5px] text-muted-foreground/90">
          Specialist delegates this agent can dispatch via{" "}
          <code className="rounded bg-surface-muted px-1 py-0.5 text-[11px]">
            dispatchSubagent
          </code>
          . Each sub-agent has its own prompt + tool subset and inherits
          this agent&apos;s knowledge scope at run time.
        </p>
        <button
          type="button"
          onClick={startCreate}
          disabled={editing !== null}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 py-1 text-[12px] font-medium text-foreground transition hover:border-border/80 disabled:opacity-50"
        >
          <Plus className="h-3 w-3" aria-hidden strokeWidth={2} />
          Sub-agent
        </button>
      </div>

      {loadError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11.5px] text-destructive">
          {loadError}
        </p>
      )}

      {rows === null && !loadError && (
        <p className="text-[11.5px] text-muted-foreground/80">Loading…</p>
      )}

      {rows !== null && rows.length === 0 && editing !== "new" && (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11.5px] text-muted-foreground/80">
          No sub-agents yet. Click <em>Sub-agent</em> to add one.
        </p>
      )}

      {/* Existing rows. Each row collapses into its own inline editor
          when "editing" matches its external_id. */}
      {rows?.map((s) =>
        editing === s.externalId ? (
          <SubAgentEditor
            key={s.externalId}
            mode="edit"
            draft={draft}
            setDraft={setDraft}
            submitting={submitting}
            submitError={submitError}
            toolCatalog={toolCatalog}
            onSubmit={handleSubmit}
            onCancel={cancelEdit}
          />
        ) : (
          <SubAgentRow
            key={s.externalId}
            sub={s}
            disabled={editing !== null}
            onEdit={() => startEdit(s)}
            onDelete={() => void handleDelete(s)}
          />
        ),
      )}

      {editing === "new" && (
        <SubAgentEditor
          mode="create"
          draft={draft}
          setDraft={setDraft}
          submitting={submitting}
          submitError={submitError}
          toolCatalog={toolCatalog}
          onSubmit={handleSubmit}
          onCancel={cancelEdit}
        />
      )}
    </div>
  )
}

// ── Row ─────────────────────────────────────────────────────────────────────

function SubAgentRow({
  sub,
  disabled,
  onEdit,
  onDelete,
}: {
  sub: SubAgent
  disabled: boolean
  onEdit: () => void
  onDelete: () => void
}): JSX.Element {
  const toolsLabel =
    sub.tools.length === 0 ? "All tools" : `${sub.tools.length} tools`
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface-elevated px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[13px] font-medium text-foreground">
            {sub.name}
          </span>
          <span className="text-[11.5px] text-muted-foreground/80">
            {toolsLabel}
          </span>
          <span
            className="text-[11.5px] text-muted-foreground/80"
            title="Reasoning effort for this sub-agent"
          >
            · thinking: {sub.thinkingLevel}
          </span>
        </div>
        <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground/90">
          {sub.description}
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onEdit}
          disabled={disabled}
          title="Edit sub-agent"
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
        >
          <Pencil className="h-3 w-3" aria-hidden strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          title="Delete sub-agent"
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
        >
          <Trash2 className="h-3 w-3" aria-hidden strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

// ── Inline editor ───────────────────────────────────────────────────────────

function SubAgentEditor({
  mode,
  draft,
  setDraft,
  submitting,
  submitError,
  toolCatalog,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit"
  draft: SubAgentCreateInput
  setDraft: React.Dispatch<React.SetStateAction<SubAgentCreateInput>>
  submitting: boolean
  submitError: string | null
  toolCatalog: AgentToolDescriptor[]
  onSubmit: () => void
  onCancel: () => void
}): JSX.Element {
  const update = <K extends keyof SubAgentCreateInput>(
    key: K,
    value: SubAgentCreateInput[K],
  ): void => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-elevated p-3">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-semibold text-foreground">
          {mode === "create" ? "New sub-agent" : "Edit sub-agent"}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-muted-foreground">
          Name <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder="researcher"
          className="w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[13px] text-foreground placeholder:text-muted-foreground/60 transition focus:border-ring focus:outline-none"
        />
        <span className="text-[11px] text-muted-foreground/80">
          Lowercase slug. The parent LLM uses this string to address the
          sub-agent in <code>dispatchSubagent</code>.
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-muted-foreground">
          Description <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          value={draft.description}
          onChange={(e) => update("description", e.target.value)}
          placeholder="When and why to delegate to this sub-agent"
          className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/60 transition focus:border-ring focus:outline-none"
        />
        <span className="text-[11px] text-muted-foreground/80">
          Routing hint surfaced to the parent LLM. Action-oriented works
          best — e.g. &ldquo;deep multi-doc analysis on a single SEBI
          topic, cites every passage&rdquo;.
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-muted-foreground">
          System prompt <span className="text-destructive">*</span>
        </label>
        <textarea
          value={draft.systemPrompt}
          onChange={(e) => update("systemPrompt", e.target.value)}
          rows={6}
          placeholder="You are the researcher sub-agent. Read deeply via getChunks; cite [docId#N]."
          className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 transition focus:border-ring focus:outline-none"
        />
        <span className="text-[11px] text-muted-foreground/80">
          Single field — sub-agents are leaves and don&apos;t further
          compose sections.
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-muted-foreground">
          Reasoning effort
        </label>
        <select
          value={draft.thinkingLevel ?? "medium"}
          onChange={(e) =>
            update(
              "thinkingLevel",
              e.target.value as SubAgentCreateInput["thinkingLevel"],
            )
          }
          className="w-fit rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground transition focus:border-ring focus:outline-none"
        >
          {SUB_AGENT_THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-muted-foreground/80">
          Reasoning budget for this sub-agent&apos;s nested session.
          &ldquo;medium&rdquo; is the default; raise to &ldquo;high&rdquo;
          for research-heavy leaves, lower to &ldquo;minimal&rdquo; for
          quick formatters.
        </span>
      </div>

      <ToolPicker
        tools={toolCatalog}
        selected={draft.tools ?? []}
        onChange={(next) => update("tools", next)}
      />

      {submitError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11.5px] text-destructive">
          {submitError}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[12.5px] font-medium text-foreground transition hover:border-border/80 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
        >
          {submitting ? "Saving…" : mode === "create" ? "Create" : "Save"}
        </button>
      </div>
    </div>
  )
}
