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
import type {
  Agent,
  AgentCreateInput,
  AgentDefaults,
  AgentToolDescriptor,
  SubAgent,
} from "@/lib/api"
import {
  getAgentDefaults,
  getAgentToolsCatalog,
  listKbCollections,
  listSubAgents,
} from "@/lib/api"
import { EmailMultiInput } from "./EmailMultiInput"
import { KbPickerModal, type KbSelection } from "./KbPickerModal"
import { SubAgentsSection } from "./SubAgentsSection"
import { ToolPicker } from "./ToolPicker"
import { SchemaBuilder } from "./schemaBuilder/SchemaBuilder"
import {
  type ExtractorSchema,
  fromJsonSchema,
  toJsonSchema,
} from "./schemaBuilder/types"

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
  /** When true, the Identity section (name + description) is hidden.
   *  Used by the workspace-default-agent screen (M4b) where the name
   *  isn't editable. */
  hideIdentity?: boolean
  /** When true, the Sharing section (public/private + viewers/owners) is
   *  hidden. Same M4b use case — the default agent is workspace-wide,
   *  there is no per-user sharing to configure. */
  hideSharing?: boolean
  /** When true, NULL prompt sections are prefilled with the workspace
   *  default text so the user sees exactly what the LLM would receive.
   *  Used by the default-agent edit route — for the General agent there
   *  is no "upstream default" above it, so showing empty textareas with
   *  a placeholder is misleading. Custom agents leave this off because
   *  NULL there genuinely means "inherit from the workspace default". */
  prefillSectionsFromDefaults?: boolean
  /** When true, the "Knowledge sources" section is hidden. Used by the
   *  default-agent edit route: the workspace default is the fallback
   *  every untargeted chat lands on, and scoping it to a subset of KB
   *  would silently restrict everyone's default conversations to that
   *  slice. KB scoping is a custom-agent concept; the General agent
   *  intentionally has no docId allowlist. */
  hideKnowledge?: boolean
  /** When true, the form renders the Extractor section (visual schema
   *  builder + retry-count) and submits with isExtractor=true. */
  extractor?: boolean
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
  // null on each section = "use the workspace default"; empty tools = all
  // tools available. The form treats null and "" the same on submit.
  systemPromptMain: null,
  systemPromptTools: null,
  systemPromptSubagents: null,
  tools: [],
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
  // Pull per-section overrides through. `null`/undefined both mean "use
  // the default" — the form renders the default text as a faded
  // placeholder until the user types into the textarea.
  systemPromptMain: a.systemPromptMain ?? null,
  systemPromptTools: a.systemPromptTools ?? null,
  systemPromptSubagents: a.systemPromptSubagents ?? null,
  tools: a.tools ?? [],
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
    hideIdentity = false,
    hideSharing = false,
    prefillSectionsFromDefaults = false,
    hideKnowledge = false,
    extractor = false,
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
  // Extractor-only state. responseSchema is round-tripped through the
  // SchemaBuilder's internal model; toJsonSchema serialises at submit
  // time. Both default to "empty" / 2 retries for new extractors.
  const [extractorSchema, setExtractorSchema] = useState<ExtractorSchema>(() =>
    fromJsonSchema(
      (initial?.responseSchema ?? null) as Record<string, unknown> | null,
    ),
  )
  const [extractorMaxRetries, setExtractorMaxRetries] = useState<number>(
    initial?.extractorMaxRetries ?? 2,
  )

  // Lazy-fetched defaults + tool catalog. Both are pure data the form
  // needs once; fetched in parallel on mount so subsequent renders are
  // instant. Failures degrade silently — "Use default" buttons disable
  // and the tool picker just shows nothing instead of blocking save.
  const [defaults, setDefaults] = useState<AgentDefaults | null>(null)
  const [toolCatalog, setToolCatalog] = useState<AgentToolDescriptor[]>([])
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const [d, c] = await Promise.all([
          getAgentDefaults(),
          getAgentToolsCatalog(),
        ])
        if (cancelled) return
        setDefaults(d)
        setToolCatalog(c.tools)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("agent defaults / tools fetch failed", err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // On create mode, once the tool catalog arrives, pre-select every
  // tool so the user starts with the full registry checked rather than
  // a blank "no tools — agent can't call anything" warning. Edit mode
  // mirrors the DB exactly, no auto-fill (the user's tool subset is
  // canonical).
  const createPrefilledTools = useRef(false)
  useEffect(() => {
    if (mode !== "create") return
    if (createPrefilledTools.current) return
    if (toolCatalog.length === 0) return
    createPrefilledTools.current = true
    setValues((prev) => {
      if ((prev.tools?.length ?? 0) > 0) return prev
      return { ...prev, tools: toolCatalog.map((t) => t.name) }
    })
  }, [mode, toolCatalog])

  // Workspace-default agent only: prefill empty prompt sections with the
  // resolved defaults so the editor sees the exact text the LLM will
  // receive. There is no "upstream default" above the General agent —
  // its rows ARE the workspace defaults — so a placeholder-only view is
  // misleading there. Custom agents skip this branch (NULL on them
  // really means "inherit"). Runs once: when defaults first arrive and
  // the relevant section is still null in `values`, we splice the
  // default text in. Subsequent edits aren't overwritten.
  const defaultsPrefilled = useRef(false)
  useEffect(() => {
    if (!prefillSectionsFromDefaults) return
    if (defaultsPrefilled.current) return
    if (!defaults) return
    defaultsPrefilled.current = true
    setValues((prev) => {
      const next = { ...prev }
      if (prev.systemPromptMain == null || prev.systemPromptMain === "") {
        next.systemPromptMain = defaults.sections.main
      }
      if (prev.systemPromptTools == null || prev.systemPromptTools === "") {
        next.systemPromptTools = defaults.sections.tools
      }
      // Sub-agents instructions only reach the LLM when at least one
      // sub-agent exists (the assembler suppresses the whole block
      // otherwise). Prefilling it when there are zero sub-agents would
      // mislead the editor — the textarea would show text that never
      // gets sent. We wait for the sub-agents list to load and only
      // prefill if any are present. A later, separate effect handles
      // this once `subAgents` arrives.
      return next
    })
  }, [prefillSectionsFromDefaults, defaults])

  // Section textareas mirror the DB values verbatim — NO auto pre-fill
  // from workspace defaults or legacy `prompt`. NULL renders as empty,
  // explicit '' renders as empty, any non-empty override renders as-is.
  // The placeholder still shows the workspace default so the editor
  // can see what they'd inherit by leaving the box blank, and the
  // per-section "Use default" button copies that default into the
  // textarea on click for explicit editing.

  // Sub-agents under this parent — lifted up so a single fetch drives
  // both the embedded CRUD list (SubAgentsSection) and any future
  // gating decisions that need the count.
  const [subAgents, setSubAgents] = useState<SubAgent[] | null>(null)
  useEffect(() => {
    if (mode !== "edit" || !initial?.externalId) {
      setSubAgents([])
      return
    }
    let cancelled = false
    void listSubAgents(initial.externalId)
      .then((rows) => {
        if (!cancelled) setSubAgents(rows)
      })
      .catch(() => {
        if (!cancelled) setSubAgents([])
      })
    return () => {
      cancelled = true
    }
  }, [mode, initial?.externalId])
  // Companion to the main/tools prefill (see prefillSectionsFromDefaults
  // above): fill the sub-agents textarea with the default text only
  // once we know the parent actually has at least one sub-agent. The
  // assembler suppresses the whole sub-agents block when there are
  // none, so prefilling an empty parent would show text that never
  // reaches the LLM.
  const subagentsPrefilled = useRef(false)
  useEffect(() => {
    if (!prefillSectionsFromDefaults) return
    if (subagentsPrefilled.current) return
    if (!defaults) return
    if (!subAgents || subAgents.length === 0) return
    subagentsPrefilled.current = true
    setValues((prev) => {
      if (
        prev.systemPromptSubagents != null &&
        prev.systemPromptSubagents !== ""
      ) {
        return prev
      }
      return {
        ...prev,
        systemPromptSubagents: defaults.sections.subagents,
      }
    })
  }, [prefillSectionsFromDefaults, defaults, subAgents])

  const reloadSubAgents = async (): Promise<void> => {
    if (!initial?.externalId) return
    try {
      setSubAgents(await listSubAgents(initial.externalId))
    } catch {
      // best-effort — keep current list on failure
    }
  }

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

  // Legacy / "Use whole collection" rows arrive from the server with
  // `name = docId` because nothing wrote a real name into agent.docIds
  // when those rows were added. Resolve them once by mapping the bare
  // UUID (after the `cl-` prefix) to the live collection's display
  // name. Fire-and-forget — if the call fails (or the collection no
  // longer exists) the chips just keep showing the docId. Gated by a
  // ref so a single fetch covers the whole edit session even if a
  // collection lookup misses (otherwise the effect re-fires every time
  // setKbSources runs and the "needs" predicate stays true).
  const kbNamesResolved = useRef(false)
  useEffect(() => {
    if (kbNamesResolved.current) return
    const needs = kbSources.some(
      (s) => s.docId.startsWith("cl-") && s.name === s.docId,
    )
    if (!needs) return
    // Mark resolved before the fetch starts. The ref alone guarantees
    // we only ever fire ONE listKbCollections call per form mount, so
    // we deliberately do NOT use a `cancelled` closure here — the
    // effect cleanup runs on the very next kbSources change (e.g.
    // React strict-mode double-mount or the [initial] effect setting
    // kbSources twice), and a cancelled flag would race the fetch and
    // throw away the result we wanted.
    kbNamesResolved.current = true
    void listKbCollections()
      .then((collections) => {
        const byId = new Map(collections.map((c) => [c.id, c.name]))
        setKbSources((prev) =>
          prev.map((s) => {
            if (!s.docId.startsWith("cl-") || s.name !== s.docId) return s
            const id = s.docId.replace(/^cl-/, "")
            const name = byId.get(id)
            if (!name) return s
            return {
              ...s,
              entity: "collection",
              name,
              pathLabel: name,
            }
          }),
        )
      })
      .catch(() => {
        // best-effort; leave chips as-is
      })
  }, [kbSources])

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
    // Section field semantics on save:
    //   • The textareas mirror the DB verbatim — NULL and '' both
    //     render empty (see PromptSection rendering above). No
    //     pre-fill, so what the user sees in the box is what they
    //     intended.
    //   • Trim each value. Empty (after trim) is sent as null so the
    //     server treats it as "no override" — the assembler's
    //     resolveAgentSystemPrompt then falls back to defaults or
    //     legacy prompt as appropriate.
    //   • Anything non-empty is sent verbatim. No "matches default →
    //     auto-null" magic; without pre-fill there's no phantom
    //     override path that needs canceling.
    const normaliseSection = (v: string | null | undefined): string | null => {
      const trimmed = (v ?? "").trim()
      return trimmed.length > 0 ? trimmed : null
    }
    await onSubmit({
      ...values,
      name: trimmedName,
      description: values.description?.trim() ?? "",
      prompt: values.prompt?.trim() ?? "",
      systemPromptMain: normaliseSection(values.systemPromptMain),
      systemPromptTools: normaliseSection(values.systemPromptTools),
      systemPromptSubagents: normaliseSection(values.systemPromptSubagents),
      tools: values.tools ?? [],
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
      // Extractor mode: send isExtractor + serialised JSON Schema +
      // retry budget. Plain-agent submits leave responseSchema null
      // and isExtractor false (server default).
      ...(extractor
        ? {
            isExtractor: true,
            responseSchema: toJsonSchema(extractorSchema),
            extractorMaxRetries,
          }
        : {}),
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
      {/* Identity — hidden for the workspace default agent (M4b),
          which has a fixed name/description. */}
      {!hideIdentity && (
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
      )}

      {/* Extractor — visual schema builder + retry budget. Rendered
          only when the form is mounted in extractor mode (the
          /extractors routes pass extractor={true}). */}
      {extractor && (
        <Section
          title="Response schema"
          hint="Define what the LLM must return. The chat service validates the response against this schema and re-prompts on mismatch."
        >
          <SchemaBuilder
            value={extractorSchema}
            onChange={setExtractorSchema}
          />
          <Field
            label="Max retries on validation failure"
            hint="How many times to re-prompt the LLM with the validation errors before giving up."
          >
            <input
              type="number"
              min={0}
              max={10}
              value={extractorMaxRetries}
              onChange={(e): void => {
                const n = Number.parseInt(e.target.value, 10)
                setExtractorMaxRetries(Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 0)
              }}
              className="w-24 rounded-md border border-border bg-surface-elevated px-2 py-1 text-[13px] text-foreground focus:border-ring focus:outline-none"
            />
          </Field>
        </Section>
      )}

      {/* Behaviour — three independently-editable prompt sections plus
          the per-agent tool allowlist. Each section's textarea shows the
          workspace default as a faded placeholder when blank, so an
          editor sees what they're inheriting without an extra click; the
          "Use default" button copies that text into the textarea so they
          can tweak it. */}
      <Section
        title="Behaviour"
        hint="System prompt sections and which tools this agent can call."
      >
        <PromptSection
          label="Main"
          description="Role, methodology, citation rules — the bulk of the system prompt."
          value={values.systemPromptMain ?? ""}
          defaultText={defaults?.sections.main ?? null}
          rows={10}
          onChange={(v) => setField("systemPromptMain", v.length ? v : null)}
        />
        <PromptSection
          label="Tools"
          description="Extra guidance on how and when to call each tool. Leave blank to use the workspace default phrasing — the catalog the agent has access to is selectable below regardless."
          value={values.systemPromptTools ?? ""}
          defaultText={defaults?.sections.tools ?? null}
          rows={6}
          onChange={(v) => setField("systemPromptTools", v.length ? v : null)}
        />
        <PromptSection
          label="Sub-agents"
          description="Dispatch instructions appended above the sub-agents catalog at run time. Only takes effect when this agent has at least one sub-agent — otherwise the entire block is suppressed in the LLM prompt regardless of this text."
          value={values.systemPromptSubagents ?? ""}
          defaultText={defaults?.sections.subagents ?? null}
          rows={4}
          onChange={(v) =>
            setField("systemPromptSubagents", v.length ? v : null)
          }
        />

        {/* Tool picker — empty selection means "all tools available", which
            matches the runner's back-compat path. Showing every tool as
            checked-by-default would imply a hard set, but we want the
            agent to inherit new tools added to the registry without
            edits; the "All tools" pill makes that policy explicit. */}
        <ToolPicker
          tools={toolCatalog}
          selected={values.tools ?? []}
          onChange={(next) => setField("tools", next)}
        />

        {/* "Use workspace knowledge" and "Allow web search" toggles are
            intentionally hidden — the team treats them as default-on for v2
            and surfaces them globally rather than per-agent. The values are
            still part of the form state (default isRagOn=true,
            allowWebSearch=false) and round-trip on edit, so existing agents
            keep their setting until those defaults move. */}
      </Section>

      {/* Knowledge sources. Hidden on the workspace-default agent — the
          General agent's job is to be the unconstrained fallback for
          every untargeted chat in the workspace; surfacing this control
          would let one editor silently narrow everyone's default
          conversations to a slice of KB. KB scoping is a custom-agent
          concept. */}
      {!hideKnowledge && (
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
      )}

      {/* Sub-agents — only available once the parent exists (we need
          parentExternalId to scope the CRUD endpoints). On create, the
          section is hidden; saving the parent first unlocks it. */}
      {mode === "edit" && initial && (
        <Section
          title="Sub-agents"
          hint="Specialist delegates this agent can dispatch to for deep, focused work."
        >
          <SubAgentsSection
            parentExternalId={initial.externalId}
            subAgents={subAgents}
            onMutate={reloadSubAgents}
            toolCatalog={toolCatalog}
          />
        </Section>
      )}

      {/* Sharing — hidden for the workspace default agent (M4b): it's
          implicitly visible to every workspace member, no per-user
          viewers/owners to configure. */}
      {!hideSharing && (
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
      )}

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

// ── Behaviour helpers ───────────────────────────────────────────────────────

/** A single system-prompt section editor — labelled textarea with a
 *  per-section "Use default" button. Empty string is the canonical "no
 *  override" state; the form's submit handler normalises it to `null` on
 *  the wire. The default text shows as a faded placeholder so the editor
 *  sees what they're inheriting without clicking. */
function PromptSection({
  label,
  description,
  value,
  defaultText,
  rows,
  onChange,
}: {
  label: string
  description: string
  value: string
  defaultText: string | null
  rows: number
  onChange: (v: string) => void
}): JSX.Element {
  const placeholder = defaultText
    ? `Workspace default — leave blank to use as-is. Click “Use default” to start editing from this text.\n\n${truncatePlaceholder(defaultText)}`
    : "Workspace default — leave blank to use as-is."
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-muted-foreground">
          {label}
        </span>
        <button
          type="button"
          disabled={!defaultText}
          onClick={() => {
            if (defaultText) onChange(defaultText)
          }}
          title={
            defaultText
              ? "Copy the workspace default into this field so you can edit it"
              : "Loading…"
          }
          className="text-[11.5px] font-medium text-muted-foreground transition hover:text-foreground disabled:opacity-50"
        >
          Use default
        </button>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full resize-y rounded-md border border-border bg-surface-elevated px-2.5 py-2 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 transition focus:border-ring focus:outline-none"
      />
      <span className="text-[11.5px] text-muted-foreground/80">
        {description}
      </span>
    </div>
  )
}

// Keep the placeholder readable — show just the head of the default so
// the textarea isn't a wall of grey text. The "Use default" button
// gives access to the full thing.
const PLACEHOLDER_PREVIEW = 220
function truncatePlaceholder(s: string): string {
  if (s.length <= PLACEHOLDER_PREVIEW) return s
  return `${s.slice(0, PLACEHOLDER_PREVIEW - 1).trimEnd()}…`
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

