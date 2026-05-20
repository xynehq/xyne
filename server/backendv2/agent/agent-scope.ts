// Loads a custom agent record and projects it into a flat search scope for
// the v2 vespa tools. Mirrors the contract the v1 UI writes to the `agents`
// table — same shape of `appIntegrations` and `docIds` — but without sharing
// code with v1's chat module. The DB layer (@/db/*) and search types
// (@/search/types) are the only shared surface; v1 business logic is not
// imported.
//
// Returning `null` from `loadAgentScope` means "no agent in play" — vespa
// search keeps its default KB-only behavior. A non-null scope flips the
// vespa tool into agent-scoped mode where the agent's allowlist (apps,
// docIds, channels, KB collections) drives visibility, bypassing the
// per-user `createdBy == email` filter that ships with the KB profile.

import { and, eq, isNull } from "drizzle-orm"

import { db } from "@/db/client"
import { agents, subAgents } from "@/db/schema"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import { Apps, SlackEntity } from "@xyne/vespa-ts/types"
import type { SubAgentSummary } from "./pi-mono/system-prompt"

/** A sub-agent row projected with enough fields to be dispatched at run
 *  time. Extends the assembler-facing SubAgentSummary (name +
 *  description) with the columns the dispatchSubagent tool actually
 *  needs to spin a nested pi-mono session: stable identity
 *  (externalId), the sub-agent's own systemPrompt, and its tool name
 *  subset. The assembler still only reads name + description from this
 *  shape; the extras are inert until the dispatch tool picks them up. */
export type DispatchableSubAgent = SubAgentSummary & {
  externalId: string
  systemPrompt: string
  tools: string[]
  // Reasoning effort to use for the nested pi-mono session at dispatch
  // time. Pulled off the sub_agents row directly — the parent agent's
  // configured level (or the chat request's level) doesn't override it.
  // The runner already enforced "thinkingLevel is something the model
  // operator picks for that model"; storing it on the sub-agent makes
  // each leaf independently tunable.
  thinkingLevel: "minimal" | "low" | "medium" | "high"
}

// Coerce a raw column value into the closed thinking-level set. Same
// defensive shape SubAgentsService.normaliseThinkingLevel uses — kept
// local to agent-scope so loadAgentScope doesn't take a dependency on
// the service layer.
const VALID_THINKING_LEVELS: ReadonlyArray<"minimal" | "low" | "medium" | "high"> = [
  "minimal",
  "low",
  "medium",
  "high",
]
const normaliseThinkingLevel = (
  raw: unknown,
): DispatchableSubAgent["thinkingLevel"] =>
  typeof raw === "string" &&
  (VALID_THINKING_LEVELS as readonly string[]).includes(raw)
    ? (raw as DispatchableSubAgent["thinkingLevel"])
    : "medium"
import type { UserId, WorkspaceId } from "./storage/types"

// ─── Public types ───────────────────────────────────────────────────────────

/** A single per-app filter group as stored on the agent record. The fields
 *  that matter to v2 vespa search today are echoed here; unknown fields are
 *  preserved so downstream tools that learn new filter shapes don't need a
 *  type change. */
export type AgentAppFilter = {
  id: number
  from?: string[]
  to?: string[]
  cc?: string[]
  bcc?: string[]
  senderId?: string[]
  channelId?: string[]
  timeRange?: { startDate: number; endDate: number }
}

/** v1 also persists Zoho/etc. nested filters; we pass them through opaquely. */
export type AgentAppFilters = Partial<Record<Apps, AgentAppFilter[]>>

export type AgentScope = {
  /** External ID — propagates to logs and the run record. */
  externalId: string
  /** Numeric users.id of the creator. Audit-only; search ignores it. */
  ownerUserId: number
  /** When false the agent has RAG disabled and tools should short-circuit. */
  isRagOn: boolean
  /** Apps the agent is allowed to query. */
  appEnums: Apps[]
  /** `ds-`-prefixed external IDs of data sources allowlisted on the agent. */
  dataSourceIds: string[]
  /** Slack channel docIds extracted from the agent's `docIds`. */
  channelIds: string[]
  /** Per-app explicit item ID allowlist. Empty for an app means "selectedAll". */
  selectedItems: Partial<Record<Apps, string[]>>
  /** Per-app filter groups (Gmail from/to, time ranges, Slack senders). */
  appFilters: AgentAppFilters
  /** KB collection selections gathered from `selectedItems.knowledge_base`. */
  collectionSelections: Array<{
    collectionIds?: string[]
    collectionFolderIds?: string[]
    collectionFileIds?: string[]
  }>
  /** Legacy agent-supplied system prompt (single field, pre-M2). When set
   *  and the new per-section fields are all NULL, the chat service treats
   *  it as a verbatim REPLACE for the entire assembled prompt — preserves
   *  v1 behaviour for agents created before the 3-section split. */
  prompt?: string
  /** Three independently editable system-prompt sections (M2). NULL on a
   *  field means "fall back to the hard-coded default" — the assembler
   *  resolves this. An agent with all three NULL and no legacy `prompt`
   *  uses the full default prompt. */
  systemPromptMain?: string | null
  systemPromptTools?: string | null
  systemPromptSubagents?: string | null
  /** Tool names from the pi-mono registry this agent is allowed to call.
   *  Empty = all tools (matches `buildToolsForRun(undefined, ctx)`). */
  tools: string[]
  /** Sub-agents linked to this parent. Each carries `name` + `description`
   *  for the assembler's `<subagents>` catalog. Empty array = the
   *  sub-agents section is suppressed entirely from the prompt. */
  subAgents: DispatchableSubAgent[]
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/** A drive-like app's docIds expand into `selectedItems[app]`. Other apps
 *  (Gmail, KB) carry their item IDs through `appIntegrations` instead. */
const DRIVE_LIKE_APPS: ReadonlySet<Apps> = new Set([
  Apps.GoogleDrive,
  Apps.GoogleWorkspace,
])

/** Canonicalize the various spellings of app keys the v1 UI persists. Unknown
 *  values produce `null` so callers can drop them instead of polluting the
 *  scope with garbage app enums. */
const normalizeApp = (raw: string): Apps | null => {
  const v = raw.toLowerCase()
  switch (v) {
    case "googledrive":
    case "googlesheets":
    case "googleslides":
    case "googledocs":
      return Apps.GoogleDrive
    case "gmail":
      return Apps.Gmail
    case "googlecalendar":
      return Apps.GoogleCalendar
    case "google-workspace":
      return Apps.GoogleWorkspace
    case "slack":
      return Apps.Slack
    case "knowledge_base":
    case "knowledgebase":
      return Apps.KnowledgeBase
    case "datasource":
    case "data-source":
      return Apps.DataSource
    case "zohodesk":
      return Apps.ZohoDesk
    case "github":
      return Apps.Github
    default:
      return null
  }
}

const dedupe = <T>(items: readonly T[]): T[] => Array.from(new Set(items))

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Shape check for an `AppSelectionMap` entry. Doesn't validate filter
 *  internals — those are passed through opaquely. */
const isAppSelection = (
  v: unknown,
): v is { itemIds?: unknown; selectedAll?: boolean; filters?: unknown } => {
  if (!isPlainObject(v)) return false
  return "itemIds" in v || "selectedAll" in v || "filters" in v
}

/** True when `value` looks like `{ [appKey]: AppSelection, ... }`. */
const isAppSelectionMap = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false
  if (Object.keys(value).length === 0) return true // empty map is valid
  for (const v of Object.values(value)) {
    if (!isAppSelection(v)) return false
  }
  return true
}

/** Pull a string[] safely off an unknown record field. Non-arrays and
 *  non-string members are dropped silently so a malformed filter doesn't
 *  blow up the whole scope. */
const pickStringList = (
  src: Record<string, unknown>,
  key: string,
): string[] | undefined => {
  const v = src[key]
  if (!Array.isArray(v)) return undefined
  const out = v.filter((s): s is string => typeof s === "string")
  return out.length > 0 ? out : undefined
}

/** Coerce arbitrary filter payloads into our typed shape. Unknown keys are
 *  ignored; the result is safe to pass into downstream vespa queries. */
const coerceFilters = (raw: unknown): AgentAppFilter[] => {
  if (!Array.isArray(raw)) return []
  const out: AgentAppFilter[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const id = typeof item["id"] === "number" ? item["id"] : 0
    const filter: AgentAppFilter = { id }
    const from = pickStringList(item, "from")
    if (from) filter.from = from
    const to = pickStringList(item, "to")
    if (to) filter.to = to
    const cc = pickStringList(item, "cc")
    if (cc) filter.cc = cc
    const bcc = pickStringList(item, "bcc")
    if (bcc) filter.bcc = bcc
    const senderId = pickStringList(item, "senderId")
    if (senderId) filter.senderId = senderId
    const channelId = pickStringList(item, "channelId")
    if (channelId) filter.channelId = channelId
    const timeRange = item["timeRange"]
    if (
      isPlainObject(timeRange) &&
      typeof timeRange["startDate"] === "number" &&
      typeof timeRange["endDate"] === "number"
    ) {
      filter.timeRange = {
        startDate: timeRange["startDate"],
        endDate: timeRange["endDate"],
      }
    }
    out.push(filter)
  }
  return out
}

type ParsedIntegrations = {
  appEnums: Set<Apps>
  selectedItems: Partial<Record<Apps, string[]>>
  appFilters: AgentAppFilters
  dataSourceIds: string[]
}

/** Parse the AppSelectionMap form of `appIntegrations`.
 *
 *  Convention from v1: `selectedAll: true` (or empty `itemIds`) means "all
 *  items for this app" and we record the app enum but no item allowlist. An
 *  explicit `itemIds` list narrows the agent's visibility to just those IDs.
 */
const parseAppSelectionMap = (
  map: Record<string, unknown>,
  acc: ParsedIntegrations,
): void => {
  for (const [appName, selection] of Object.entries(map)) {
    if (!isAppSelection(selection)) continue
    const app = normalizeApp(appName)
    if (!app) continue
    acc.appEnums.add(app)

    const itemIds = Array.isArray(selection.itemIds)
      ? (selection.itemIds as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : []
    const selectedAll = selection.selectedAll === true
    if (!selectedAll && itemIds.length > 0) {
      const prior = acc.selectedItems[app] ?? []
      acc.selectedItems[app] = dedupe([...prior, ...itemIds])
    }

    const filters = coerceFilters(selection.filters)
    if (filters.length > 0) {
      acc.appFilters[app] = [...(acc.appFilters[app] ?? []), ...filters]
    }
  }
}

/** Parse the legacy `string[]` form of `appIntegrations`: each entry is
 *  either an app key ("googledrive", "gmail", ...) or a data source external
 *  id (`ds-…`). Unknown values are dropped silently. */
const parseLegacyIntegrationArray = (
  values: readonly unknown[],
  acc: ParsedIntegrations,
): void => {
  for (const entry of values) {
    if (typeof entry !== "string") continue
    const lower = entry.toLowerCase()
    if (lower.startsWith("ds-") || lower.startsWith("ds_")) {
      acc.dataSourceIds.push(entry)
      acc.appEnums.add(Apps.DataSource)
      continue
    }
    const app = normalizeApp(entry)
    if (app) acc.appEnums.add(app)
  }
}

/** Merge `agent.docIds` into the scope.
 *
 *  Two cases worth handling explicitly:
 *    - A Slack-channel docId surfaces as a channelId (so search can filter
 *      messages to those channels).
 *    - A drive-like docId widens `selectedItems[GoogleDrive]` (or sibling
 *      drive apps) so the agent can read those specific files/folders.
 *
 *  Other apps in `docIds` are ignored on purpose: v1 only expands drive-like
 *  and Slack entries into the search scope, and we want to match that. */
const mergeDocIds = (
  docIds: unknown,
  acc: ParsedIntegrations,
  channelIds: Set<string>,
): void => {
  if (!Array.isArray(docIds)) return
  const driveBucket: Partial<Record<Apps, string[]>> = {}
  for (const record of docIds) {
    if (!record) continue
    if (typeof record === "string") {
      // Bare string → implicitly a Drive docId in v1's contract.
      ;(driveBucket[Apps.GoogleDrive] ??= []).push(record)
      continue
    }
    if (!isPlainObject(record)) continue
    const docId =
      typeof record["docId"] === "string" ? record["docId"] : undefined
    if (!docId) continue
    if (
      record["app"] === Apps.Slack &&
      record["entity"] === SlackEntity.Channel
    ) {
      channelIds.add(docId)
      acc.appEnums.add(Apps.Slack)
      continue
    }
    const app = normalizeApp(String(record["app"] ?? "googledrive"))
    if (!app || !DRIVE_LIKE_APPS.has(app)) continue
    ;(driveBucket[app] ??= []).push(docId)
  }
  for (const [appKey, ids] of Object.entries(driveBucket)) {
    const app = appKey as Apps
    const deduped = dedupe(ids ?? [])
    if (!deduped.length) continue
    acc.appEnums.add(app)
    acc.selectedItems[app] = dedupe([
      ...(acc.selectedItems[app] ?? []),
      ...deduped,
    ])
  }
}

/** Expand KB selectedItems entries (with `cl-`/`clfd-`/`clf-` prefixes) into
 *  the per-collection / folder / file shape that vespa-ts consumes. */
const collectionSelectionsFromKb = (
  kbItems: readonly string[],
): AgentScope["collectionSelections"] => {
  if (kbItems.length === 0) return []
  const collectionIds: string[] = []
  const collectionFolderIds: string[] = []
  const collectionFileIds: string[] = []
  for (const raw of kbItems) {
    if (raw.startsWith("cl-")) collectionIds.push(raw.replace(/^cl[-_]/, ""))
    else if (raw.startsWith("clfd-"))
      collectionFolderIds.push(raw.replace(/^clfd[-_]/, ""))
    else if (raw.startsWith("clf-"))
      collectionFileIds.push(raw.replace(/^clf[-_]/, ""))
  }
  if (
    collectionIds.length === 0 &&
    collectionFolderIds.length === 0 &&
    collectionFileIds.length === 0
  ) {
    return []
  }
  return [
    {
      ...(collectionIds.length ? { collectionIds: dedupe(collectionIds) } : {}),
      ...(collectionFolderIds.length
        ? { collectionFolderIds: dedupe(collectionFolderIds) }
        : {}),
      ...(collectionFileIds.length
        ? { collectionFileIds: dedupe(collectionFileIds) }
        : {}),
    },
  ]
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Load the agent record and parse it into a search scope. Returns null when
 *  the agent doesn't exist or the viewer lacks permission (matches v1's
 *  `getAgentByExternalIdWithPermissionCheck` semantics — public agents are
 *  visible to everyone in the workspace, non-public ones only to the owner
 *  or explicitly shared users). */
export const loadAgentScope = async (
  viewer: { userId: UserId; workspaceId: WorkspaceId },
  agentExternalId: string,
): Promise<AgentScope | null> => {
  const { user, workspace } = await getUserAndWorkspaceByEmail(
    db,
    String(viewer.workspaceId),
    String(viewer.userId),
  )
  const agent = await getAgentByExternalIdWithPermissionCheck(
    db,
    agentExternalId,
    workspace.id,
    user.id,
  )
  if (!agent) {
    return null
  }

  const acc: ParsedIntegrations = {
    appEnums: new Set(),
    selectedItems: {},
    appFilters: {},
    dataSourceIds: [],
  }

  const integrations = agent.appIntegrations
  if (integrations) {
    if (isAppSelectionMap(integrations)) {
      parseAppSelectionMap(integrations as Record<string, unknown>, acc)
    } else if (Array.isArray(integrations)) {
      parseLegacyIntegrationArray(integrations as readonly unknown[], acc)
    }
  }

  const channelIds = new Set<string>()
  mergeDocIds(agent.docIds, acc, channelIds)

  const kbItems = acc.selectedItems[Apps.KnowledgeBase] ?? []
  const collectionSelections = collectionSelectionsFromKb(kbItems)

  // Sub-agents linked to this parent. Soft-deleted rows are excluded;
  // the dispatchable catalog the LLM sees (and the assembler renders)
  // only contains live sub-agents. Projects the full M7 shape:
  // externalId, name, description, systemPrompt, tools — the assembler
  // only reads name + description, dispatch reads the rest.
  const subAgentRows: DispatchableSubAgent[] = (
    await db
      .select({
        externalId: subAgents.externalId,
        name: subAgents.name,
        description: subAgents.description,
        systemPrompt: subAgents.systemPrompt,
        tools: subAgents.tools,
        thinkingLevel: subAgents.thinkingLevel,
      })
      .from(subAgents)
      .where(
        and(
          eq(subAgents.parentAgentId, agent.id),
          isNull(subAgents.deletedAt),
        ),
      )
  ).map((r) => ({
    externalId: r.externalId,
    name: r.name,
    description: r.description,
    systemPrompt: r.systemPrompt,
    tools: Array.isArray(r.tools)
      ? (r.tools as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    thinkingLevel: normaliseThinkingLevel(r.thinkingLevel),
  }))

  // Tool name list from the agent row — M7-pre made this strictly literal
  // (`[]` = no tools at run time). The cast filter keeps us safe against
  // legacy rows that somehow stored non-string elements.
  const toolNames: string[] = Array.isArray(agent.tools)
    ? (agent.tools as unknown[]).filter(
        (t): t is string => typeof t === "string",
      )
    : []

  return {
    externalId: agent.externalId,
    ownerUserId: user.id,
    isRagOn: agent.isRagOn ?? true,
    appEnums: Array.from(acc.appEnums),
    dataSourceIds: dedupe(acc.dataSourceIds),
    channelIds: Array.from(channelIds),
    selectedItems: acc.selectedItems,
    appFilters: acc.appFilters,
    collectionSelections,
    ...(agent.prompt ? { prompt: agent.prompt } : {}),
    systemPromptMain: agent.systemPromptMain ?? null,
    systemPromptTools: agent.systemPromptTools ?? null,
    systemPromptSubagents: agent.systemPromptSubagents ?? null,
    tools: toolNames,
    subAgents: subAgentRows,
  }
}

// ─── Workspace-default prompt inputs (M4b) ──────────────────────────────────
//
// What chat needs when a turn has NO agent scope: the system-prompt section
// overrides, tool allowlist, and sub-agents list that come from the
// workspace's per-row default agent (the `is_default = true` row). NOT an
// AgentScope — we deliberately don't apply the default row's
// appIntegrations to vespa search, so search visibility for un-scoped
// chats stays KB-only (the user's own items). This is just the prompt
// config.
//
// Returns the workspace's default-agent inputs, or null if no default
// row exists yet (the chat service then falls back to the hard-coded
// DEFAULT_SYSTEM_PROMPT, matching today's behaviour pre-M4b). The
// default row is created lazily by AgentsService.getOrCreateDefault on
// any GET /v2/agents/default request, so once an admin opens the admin
// UI once, every chat picks it up.

export type WorkspaceDefaultPromptInputs = {
  systemPromptMain: string | null
  systemPromptTools: string | null
  systemPromptSubagents: string | null
  tools: string[]
  subAgents: DispatchableSubAgent[]
}

export const loadWorkspaceDefaultPromptInputs = async (viewer: {
  userId: UserId
  workspaceId: WorkspaceId
}): Promise<WorkspaceDefaultPromptInputs | null> => {
  const { workspace } = await getUserAndWorkspaceByEmail(
    db,
    String(viewer.workspaceId),
    String(viewer.userId),
  )
  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspace.id),
        eq(agents.isDefault, true),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1)
  const defaultAgent = rows[0]
  if (!defaultAgent) return null

  // Same dispatchable projection as loadAgentScope — gives the chat
  // service the bits the dispatch tool needs (M7), and the assembler
  // still only reads name + description from each row.
  const subAgentRows: DispatchableSubAgent[] = (
    await db
      .select({
        externalId: subAgents.externalId,
        name: subAgents.name,
        description: subAgents.description,
        systemPrompt: subAgents.systemPrompt,
        tools: subAgents.tools,
        thinkingLevel: subAgents.thinkingLevel,
      })
      .from(subAgents)
      .where(
        and(
          eq(subAgents.parentAgentId, defaultAgent.id),
          isNull(subAgents.deletedAt),
        ),
      )
  ).map((r) => ({
    externalId: r.externalId,
    name: r.name,
    description: r.description,
    systemPrompt: r.systemPrompt,
    tools: Array.isArray(r.tools)
      ? (r.tools as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    thinkingLevel: normaliseThinkingLevel(r.thinkingLevel),
  }))

  const toolNames: string[] = Array.isArray(defaultAgent.tools)
    ? (defaultAgent.tools as unknown[]).filter(
        (t): t is string => typeof t === "string",
      )
    : []

  return {
    systemPromptMain: defaultAgent.systemPromptMain ?? null,
    systemPromptTools: defaultAgent.systemPromptTools ?? null,
    systemPromptSubagents: defaultAgent.systemPromptSubagents ?? null,
    tools: toolNames,
    subAgents: subAgentRows,
  }
}
