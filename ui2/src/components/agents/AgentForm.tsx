import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Bot,
  File,
  Folder,
  FolderPlus,
  Globe,
  Lock,
  X,
} from "lucide-react"
import type { Agent, AgentCreateInput } from "@/lib/api"
import { EmailMultiInput } from "./EmailMultiInput"
import { KbPickerModal, type KbSelection } from "./KbPickerModal"

export type AgentFormValues = AgentCreateInput

/** Imperative handle exposed via forwardRef so a parent toolbar's Save
 *  button can drive submission while the form keeps owning its working
 *  state (values, kbSources, touched flags, validation). */
export type AgentFormHandle = {
  requestSubmit(): void
}

type Props = {
  mode: "create" | "edit"
  initial?: Agent
  submitting: boolean
  submitError: string | null
  onCancel: () => void
  onSubmit: (values: AgentFormValues) => void | Promise<void>
  /** When true, the form's own sticky submit bar is suppressed — useful
   *  when the page's toolbar already provides Save / Cancel buttons. */
  hideSubmitRow?: boolean
}

// `model` is intentionally not exposed in the form — v1's UI hardcodes
// "Auto" and the user explicitly asked us not to surface it. The create
// route adds it back into the payload at submit time.
const emptyValues = (): AgentFormValues => ({
  name: "",
  description: "",
  prompt: "",
  isPublic: false,
  isRagOn: true,
  allowWebSearch: false,
  userEmails: [],
  ownerEmails: [],
})

const fromAgent = (a: Agent): AgentFormValues => ({
  name: a.name,
  description: a.description ?? "",
  prompt: a.prompt ?? "",
  isPublic: a.isPublic,
  isRagOn: a.isRagOn,
  allowWebSearch: a.allowWebSearch,
  userEmails: a.userEmails ?? [],
  ownerEmails: a.ownerEmails ?? [],
  // Preserve appIntegrations through the round trip so non-KB app configs
  // (Drive, Gmail filters, etc.) aren't silently stripped when an editor
  // who never touches those sections hits Save.
  ...(a.appIntegrations !== undefined
    ? { appIntegrations: a.appIntegrations }
    : {}),
})

export const AgentForm = forwardRef<AgentFormHandle, Props>(function AgentForm(
  {
    mode,
    initial,
    submitting,
    submitError,
    onCancel,
    onSubmit,
    hideSubmitRow = false,
  },
  ref,
): JSX.Element {
  const formRef = useRef<HTMLFormElement | null>(null)
  const [values, setValues] = useState<AgentFormValues>(
    initial ? fromAgent(initial) : emptyValues(),
  )
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [kbSources, setKbSources] = useState<KbSelection[]>(() =>
    initial ? kbFromAgent(initial) : [],
  )
  const [kbPickerOpen, setKbPickerOpen] = useState(false)

  useImperativeHandle(
    ref,
    () => ({
      // Dispatch the form's submit event so all the usual validation /
      // touched / trimming logic in handleSubmit runs identically whether
      // the user clicked the toolbar Save or pressed Enter inside the form.
      requestSubmit(): void {
        formRef.current?.requestSubmit()
      },
    }),
    [],
  )

  useEffect(() => {
    if (initial) {
      setValues(fromAgent(initial))
      setKbSources(kbFromAgent(initial))
    }
  }, [initial])

  const setField = <K extends keyof AgentFormValues>(
    key: K,
    value: AgentFormValues[K],
  ): void => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const errors = useMemo<Record<string, string>>(() => {
    const e: Record<string, string> = {}
    if (!values.name?.trim()) e["name"] = "Name is required."
    return e
  }, [values])

  const canSubmit = Object.keys(errors).length === 0 && !submitting

  const handleSubmit = async (
    ev: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    ev.preventDefault()
    setTouched({ name: true })
    if (!canSubmit) return
    const trimmedName = values.name?.trim()
    if (!trimmedName) return
    await onSubmit({
      ...values,
      name: trimmedName,
      description: values.description?.trim() ?? "",
      prompt: values.prompt?.trim() ?? "",
      // KB picks have to land in BOTH fields. `docIds` carries display
      // metadata (name/entity) so the form can rehydrate chips on edit;
      // `appIntegrations.knowledge_base.itemIds` is the canonical list
      // that v1's resource-access and v2's loadAgentScope actually honor
      // at retrieval time. Writing only `docIds` (the prior behavior)
      // silently dropped the scope at query time because mergeDocIds
      // skips non-drive-like apps.
      docIds: kbSources.map((s) => ({
        docId: s.docId,
        name: s.name,
        app: s.app,
        entity: s.entity,
      })),
      appIntegrations: mergeKbIntegration(values.appIntegrations, kbSources),
    })
  }

  const removeKbSource = (docId: string): void => {
    setKbSources((prev) => prev.filter((s) => s.docId !== docId))
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="flex flex-col gap-6 animate-fade-up"
    >
      {/* Identity */}
      <Section
        title="Identity"
        hint="How this agent shows up in the picker."
      >
        <Field
          label="Name"
          required
          {...(touched["name"] && errors["name"]
            ? { error: errors["name"] }
            : {})}
        >
          <input
            type="text"
            value={values.name ?? ""}
            onChange={(e) => {
              setField("name", e.target.value)
            }}
            onBlur={() => {
              setTouched((t) => ({ ...t, name: true }))
            }}
            placeholder="e.g. Engineering Wiki"
            autoFocus={mode === "create"}
            className="h-8 w-full rounded-md border border-border bg-surface-elevated px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/80 transition focus:border-ring focus:outline-none"
          />
        </Field>

        <Field
          label="Description"
          hint="Shown under the name in the agent picker."
        >
          <textarea
            value={values.description ?? ""}
            onChange={(e) => {
              setField("description", e.target.value)
            }}
            rows={2}
            placeholder="e.g. Knows the architecture docs, RFCs, and onboarding guides."
            className="w-full resize-y rounded-md border border-border bg-surface-elevated px-2.5 py-2 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/80 transition focus:border-ring focus:outline-none"
          />
        </Field>
      </Section>

      {/* Behaviour */}
      <Section
        title="Behaviour"
        hint="System prompt and the boundaries the agent operates within."
      >
        <Field
          label="System prompt"
          hint="Pinned to every turn — tone, scope, and rules."
        >
          <textarea
            value={values.prompt ?? ""}
            onChange={(e) => {
              setField("prompt", e.target.value)
            }}
            rows={10}
            placeholder="You are the engineering wiki copilot. Answer with citations. If a question falls outside the docs, say so plainly."
            // Fixed height with internal scroll — large agent prompts can be
            // thousands of lines (e.g. SEBI), and we don't want the form to
            // grow unbounded.
            className="h-64 w-full resize-none overflow-y-auto rounded-md border border-border bg-surface-elevated px-2.5 py-2 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/80 transition focus:border-ring focus:outline-none"
          />
        </Field>

        {/* "Use workspace knowledge" and "Allow web search" toggles are
            intentionally hidden — the team treats them as default-on for v2
            and surfaces them globally rather than per-agent. The values are
            still part of the form state (default isRagOn=true,
            allowWebSearch=false) and round-trip on edit, so existing agents
            keep their setting until those defaults move. */}
      </Section>

      {/* Knowledge sources */}
      <Section
        title="Knowledge sources"
        hint="Pick the specific documents and folders this agent can reach. Leave empty to use the workspace knowledge default."
      >
        <KbSourcesField
          sources={kbSources}
          onOpenPicker={() => {
            setKbPickerOpen(true)
          }}
          onRemove={removeKbSource}
        />
      </Section>

      {/* Sharing */}
      <Section
        title="Sharing"
        hint="Who can see and use this agent."
      >
        <Toggle
          label={values.isPublic ? "Public to the workspace" : "Private"}
          hint={
            values.isPublic
              ? "Everyone in your workspace will see this agent."
              : "Only you and people explicitly shared with can see it."
          }
          icon={
            values.isPublic ? (
              <Globe className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
            ) : (
              <Lock className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
            )
          }
          checked={values.isPublic ?? false}
          onChange={(v) => {
            setField("isPublic", v)
          }}
        />

        {!values.isPublic && (
          <>
            <EmailMultiInput
              label="Viewers"
              hint="People who can use this agent in chat. Built for adding many — search, paste a CSV, or both."
              emails={values.userEmails ?? []}
              onChange={(list) => {
                setField("userEmails", list)
              }}
              excludeEmails={values.ownerEmails ?? []}
            />
            <EmailMultiInput
              label="Co-owners"
              hint="People who can also edit and delete this agent."
              emails={values.ownerEmails ?? []}
              onChange={(list) => {
                setField("ownerEmails", list)
              }}
              excludeEmails={values.userEmails ?? []}
            />
          </>
        )}
      </Section>

      {/* Submit feedback. Always rendered (even when the page's toolbar
          owns the action buttons) so server errors from toolbar-driven
          submits still surface inline next to the form. */}
      {submitError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
          {submitError}
        </div>
      ) : null}

      {/* Sticky submit row. Suppressed when `hideSubmitRow` is set — the
          page chrome (KB-style toolbar) provides Cancel / Save in that
          case. Form `requestSubmit()` is still wired via forwardRef. */}
      {!hideSubmitRow ? (
        <div className="sticky bottom-0 z-10 mt-2 rounded-xl border border-border bg-surface-elevated px-3 py-3 shadow-[0_-2px_12px_-4px_hsl(var(--ring)/0.12)]">
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="inline-flex h-8 items-center rounded-md border border-border bg-surface-elevated px-3 text-[12.5px] text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex h-8 items-center rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting
                ? mode === "create"
                  ? "Creating…"
                  : "Saving…"
                : mode === "create"
                  ? "Create agent"
                  : "Save changes"}
            </button>
          </div>
        </div>
      ) : null}

      <KbPickerModal
        open={kbPickerOpen}
        initial={kbSources}
        onClose={() => {
          setKbPickerOpen(false)
        }}
        onApply={(next) => {
          setKbSources(next)
          setKbPickerOpen(false)
        }}
      />
    </form>
  )
})


const VALID_KB_ITEM_ID =
  /^(cl-|clfd-|clf-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function kbFromAgent(agent: Agent): KbSelection[] {
  // Index `docIds` by docId for O(1) name/entity lookup. Tolerate any
  // shape — agents predating the v2 form may have bare strings, partial
  // records, or non-KB drive entries mixed in.
  const docMeta = new Map<
    string,
    { name: string; app: string; entity: string }
  >()
  if (Array.isArray(agent.docIds)) {
    for (const raw of agent.docIds) {
      if (!raw || typeof raw !== "object") continue
      const r = raw as Record<string, unknown>
      const docId = typeof r["docId"] === "string" ? r["docId"] : null
      const name = typeof r["name"] === "string" ? r["name"] : null
      const app = typeof r["app"] === "string" ? r["app"] : "knowledge_base"
      const entity = typeof r["entity"] === "string" ? r["entity"] : "file"
      if (!docId || !name) continue
      docMeta.set(docId, { name, app, entity })
    }
  }

  // Pull the canonical itemIds. Tolerate the field being absent, malformed,
  // or in the legacy `appIntegrations: string[]` shape (which can't carry
  // a knowledge_base key at all).
  let itemIds: string[] = []
  const integrations = agent.appIntegrations
  if (integrations && typeof integrations === "object" && !Array.isArray(integrations)) {
    const kb = (integrations as Record<string, unknown>)["knowledge_base"]
    if (kb && typeof kb === "object") {
      const raw = (kb as Record<string, unknown>)["itemIds"]
      if (Array.isArray(raw)) {
        itemIds = raw.filter(
          (v): v is string => typeof v === "string" && VALID_KB_ITEM_ID.test(v),
        )
      }
    }
  }

  // If we have itemIds, they're the source of truth; enrich with docIds
  // metadata where available. If we don't (e.g. a v2-only agent saved by
  // a prior buggy build that only wrote docIds), fall back to whatever
  // `docIds` says so the user isn't stranded.
  const out: KbSelection[] = []
  const seen = new Set<string>()
  if (itemIds.length > 0) {
    for (const id of itemIds) {
      if (seen.has(id)) continue
      seen.add(id)
      const meta = docMeta.get(id)
      const entity = meta?.entity ?? (id.startsWith("clfd-") ? "folder" : "file")
      out.push({
        docId: id,
        name: meta?.name ?? id,
        app: meta?.app ?? "knowledge_base",
        entity,
        pathLabel: meta?.name ?? id,
      })
    }
    return out
  }
  for (const [id, meta] of docMeta) {
    if (meta.app !== "knowledge_base") continue
    if (!VALID_KB_ITEM_ID.test(id)) continue
    out.push({
      docId: id,
      name: meta.name,
      app: meta.app,
      entity: meta.entity,
      pathLabel: meta.name,
    })
  }
  return out
}

// Merge the form's KB picks into `appIntegrations.knowledge_base` while
// preserving every other key the agent already had. We always return an
// object (even an empty one) rather than undefined, because v1's update
// endpoint distinguishes between "field absent" (preserve existing) and
// "field set to {}" (overwrite to empty). If the user clears every KB
// pick on an agent that only had KB integrations, we want the server to
// actually drop the knowledge_base entry — sending undefined would leave
// the stale picks behind.
function mergeKbIntegration(
  existing: unknown,
  kbSources: readonly KbSelection[],
): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  if (Array.isArray(existing)) {
    // Legacy `appIntegrations: string[]` shape (older agents). Promote each
    // entry to the new map form so we don't silently drop the agent's
    // other enabled apps when persisting KB picks. `ds-*` entries are
    // data-source IDs, not app keys, and can't be cleanly promoted — they
    // belong on the legacy array branch only. We skip them and rely on
    // the user re-picking their data sources after a v2 edit. The server's
    // parseAppSelectionMap normalises whatever app key we send.
    for (const raw of existing) {
      if (typeof raw !== "string") continue
      const lower = raw.toLowerCase()
      if (lower.startsWith("ds-") || lower.startsWith("ds_")) continue
      base[raw] = { itemIds: [], selectedAll: true }
    }
  } else if (
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing)
  ) {
    Object.assign(base, existing as Record<string, unknown>)
  }
  delete base["knowledge_base"]
  if (kbSources.length > 0) {
    base["knowledge_base"] = {
      itemIds: kbSources.map((s) => s.docId),
      // The v2 picker only does explicit picks — there's no "select all
      // items in this collection" UI — so selectedAll is always false.
      // If the picker grows that affordance, mirror it here.
      selectedAll: false,
    }
  }
  return base
}

function KbSourcesField({
  sources,
  onOpenPicker,
  onRemove,
}: {
  sources: KbSelection[]
  onOpenPicker: () => void
  onRemove: (docId: string) => void
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenPicker}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 text-[13px] text-foreground transition hover:border-ring"
        >
          <FolderPlus
            className="h-3.5 w-3.5"
            aria-hidden
            strokeWidth={1.75}
          />
          Browse knowledge
        </button>
        {sources.length > 0 && (
          <span className="rounded-full bg-secondary/70 px-2 py-0.5 text-[11.5px] font-medium tabular-nums text-muted-foreground">
            {sources.length} added
          </span>
        )}
      </div>

      {sources.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-surface px-3 py-2.5 text-[12px] text-muted-foreground">
          No specific sources selected — the agent will see the workspace
          default for whoever asks it a question.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-1.5">
          {sources.map((s) => (
            <li key={s.docId}>
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-secondary/50">
                <span
                  aria-hidden
                  className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md bg-secondary text-foreground"
                >
                  {s.entity === "folder" ? (
                    <Folder className="h-3.5 w-3.5" strokeWidth={1.6} />
                  ) : (
                    <File className="h-3.5 w-3.5" strokeWidth={1.6} />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] text-foreground">
                    {s.name}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground/80">
                    {s.pathLabel}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${s.name}`}
                  onClick={() => {
                    onRemove(s.docId)
                  }}
                  className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"
                >
                  <X className="h-3 w-3" aria-hidden strokeWidth={2} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Form primitives ─────────────────────────────────────────────────────────

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      <header>
        <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{hint}</p>
      </header>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

function Field({
  label,
  required,
  error,
  hint,
  children,
}: {
  label: string
  required?: boolean
  error?: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground">
        {label}
        {required && <span className="text-destructive">*</span>}
      </span>
      {children}
      {error ? (
        <span className="text-[11.5px] text-destructive">{error}</span>
      ) : hint ? (
        <span className="text-[11.5px] text-muted-foreground/80">{hint}</span>
      ) : null}
    </label>
  )
}

function Toggle({
  label,
  hint,
  icon,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  icon?: JSX.Element
  checked: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => {
        onChange(!checked)
      }}
      className={`flex items-start gap-3 rounded-xl border p-3 text-left transition ${
        checked
          ? "border-foreground/15 bg-surface-elevated"
          : "border-border bg-surface hover:border-ring"
      }`}
    >
      <span
        aria-hidden
        className={`mt-0.5 grid h-7 w-7 flex-shrink-0 place-items-center rounded-lg ${
          checked
            ? "bg-foreground text-background"
            : "bg-secondary text-muted-foreground"
        }`}
      >
        {icon ?? <Bot className="h-3.5 w-3.5" strokeWidth={1.75} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        {hint && (
          <span className="mt-0.5 text-[11.5px] text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
      <span
        aria-hidden
        className={`relative mt-1 inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition ${
          checked ? "bg-foreground" : "bg-secondary"
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full bg-background shadow transition ${
            checked ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  )
}

