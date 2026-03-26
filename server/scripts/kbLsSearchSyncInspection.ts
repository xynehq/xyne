import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import postgres from "postgres"

process.env.LITELLM_API_KEY ??= process.env.LITE_LLM_API_KEY ?? ""
process.env.LITELLM_BASE_URL ??= process.env.LITE_LLM_URL ?? ""
process.env.LITELLM_BEST_MODEL ??= process.env.KB_SYNC_INSPECT_MODEL ?? "private-large"
process.env.LITELLM_BEST_AGENTIC_MODEL ??=
  process.env.LITELLM_BEST_MODEL ?? "private-large"
process.env.LITELLM_FAST_MODEL ??= "open-fast"
process.env.ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://xyne:xyne@localhost:5432/xyne"
const OUTPUT_DIR = join(process.cwd(), "test-results")
const OUTPUT_PATH = join(OUTPUT_DIR, "kb-ls-search-sync-report.json")
const MODEL_ID = process.env.KB_SYNC_INSPECT_MODEL || "private-large"
const MAX_TURNS = Number(process.env.KB_SYNC_INSPECT_MAX_TURNS || "6")
const SCENARIO_TIMEOUT_MS = Number(
  process.env.KB_SYNC_INSPECT_TIMEOUT_MS || "120000",
)

if (!process.env.LITELLM_API_KEY || !process.env.LITELLM_BASE_URL) {
  throw new Error(
    "LiteLLM credentials are missing. Expected LITELLM_* env vars or LITE_LLM_* aliases.",
  )
}

const {
  createRunId,
  createTraceId,
  getTextContent,
  runStream,
} = await import("@xynehq/jaf")
const { Apps } = await import("@xyne/vespa-ts/types")
const { buildAgentPromptAddendum } = await import(
  "@/api/chat/agentPromptCreation"
)
const {
  beforeToolExecutionHook,
  afterToolExecutionHook,
} = await import("@/api/chat/message-agents")
const {
  getFragmentsForSynthesis,
  mergeRawDocumentsIntoDocumentMemory,
} = await import("@/api/chat/document-memory")
const { checkAndYieldCitationsForAgent } = await import("@/api/chat/utils")
const { makeXyneJAFProvider } = await import("@/api/chat/jaf-provider")
const {
  lsKnowledgeBaseTool,
  searchKnowledgeBaseTool,
} = await import("@/api/chat/tools/knowledgeBaseFlow")

type LiveUser = {
  id: number
  email: string
  workspaceExternalId: string
  workspaceNumericId: number
}

type LiveKbAgent = {
  externalId: string
  name: string
  appIntegrations: Record<string, unknown>
}

type ScenarioFixture = {
  name: string
  query: string
  agent: LiveKbAgent
  knowledgeItemIdsOverride?: string[]
}

type ToolResultSnapshot = {
  toolName: string
  data: unknown
}

type ScenarioReport = {
  name: string
  agentName: string
  query: string
  answer: string
  toolSequence: string[]
  toolRequests: Array<{
    name: string
    args: unknown
  }>
  lsSnapshots: Array<{
    targetType: string | null
    entryTypes: string[]
    entryIds: string[]
    total: number | null
  }>
  searchSnapshots: Array<{
    query: string | null
    targets: unknown
    fragmentCount: number
    rawDocumentCount: number
  }>
  synthesisDocIds: string[]
  resolvedCitationDocIds: string[]
  citedDocIdsInAnswer: string[]
  unresolvedCitationDocIds: string[]
  citationDocIdsOutsideSynthesis: string[]
  eventCounts: Record<string, number>
  issues: string[]
  observations: string[]
}

type FullReport = {
  generatedAt: string
  modelId: string
  maxTurns: number
  user: Pick<LiveUser, "email" | "workspaceExternalId">
  scenarios: ScenarioReport[]
  issues: string[]
}

function logSection(title: string) {
  console.log(`\n=== ${title} ===`)
}

function getKnowledgeBaseItemIds(
  appIntegrations: Record<string, unknown>,
): string[] {
  const knowledgeBase = (appIntegrations as any)?.knowledge_base
  return Array.isArray(knowledgeBase?.itemIds)
    ? knowledgeBase.itemIds.filter((itemId: unknown): itemId is string =>
        typeof itemId === "string",
      )
    : []
}

function getFirstFullCollectionId(agent: LiveKbAgent): string | null {
  for (const itemId of getKnowledgeBaseItemIds(agent.appIntegrations)) {
    if (itemId.startsWith("cl-") && !itemId.startsWith("clfd-") && !itemId.startsWith("clf-")) {
      return itemId.slice(3)
    }
  }
  return null
}

function truncate(value: string, max = 240): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...`
}

async function discoverFixtures(): Promise<{
  user: LiveUser
  scenarios: ScenarioFixture[]
}> {
  const sql = postgres(DATABASE_URL)

  try {
    const [user] = await sql<LiveUser[]>`
      select
        u.id,
        u.email,
        u.workspace_external_id as "workspaceExternalId",
        u.workspace_id as "workspaceNumericId"
      from users u
      order by u.id asc
      limit 1
    `

    if (!user) {
      throw new Error("No local user found for KB sync inspection.")
    }

    const agents = await sql<LiveKbAgent[]>`
      select
        a.external_id as "externalId",
        a.name,
        a.app_integrations as "appIntegrations"
      from agents a
      where a.deleted_at is null
        and a.app_integrations ? 'knowledge_base'
      order by a.updated_at desc nulls last, a.created_at desc
    `

    if (!agents.length) {
      throw new Error("No KB-enabled agents found in the local database.")
    }

    const byName = (needle: string) =>
      agents.find((agent) => agent.name.toLowerCase().includes(needle))

    const juspayAgent = byName("juspay") ?? agents[0]
    const uliAgent = byName("uli") ?? agents.find((agent) => agent !== juspayAgent)
    const juspayCollectionId = getFirstFullCollectionId(juspayAgent)

    type PartialScopeFixture = {
      fileId: string
      fileName: string
      folderId: string
      folderName: string
    }

    let juspayPartialScopeFixture: PartialScopeFixture | null = null
    if (juspayCollectionId) {
      ;[juspayPartialScopeFixture] = await sql<PartialScopeFixture[]>`
        select
          f.id as "fileId",
          f.name as "fileName",
          p.id as "folderId",
          p.name as "folderName"
        from collection_items f
        join collection_items p on p.id = f.parent_id
        where f.collection_id = ${juspayCollectionId}
          and f.deleted_at is null
          and p.deleted_at is null
          and f.type = 'file'
          and lower(f.name) like '%.md'
        order by
          case when lower(f.name) = 'get-started.md' then 0 else 1 end,
          case when lower(coalesce(f.path, '')) like '%payment-links%' then 0 else 1 end,
          case when lower(coalesce(f.path, '')) like '%/br/%' then 0 else 1 end,
          lower(coalesce(f.path, '')) asc,
          lower(f.name) asc
        limit 1
      `
    }

    const scenarios: ScenarioFixture[] = [
      {
        name: "juspay-payment-links",
        agent: juspayAgent,
        query: [
          "Use ls before any searchKnowledgeBase call in this run.",
          "In the Brazil payment-links documentation, first inspect the KB structure to find the folder that contains get-started.md.",
          "Then tell me which markdown files are in that folder and what Step 5 says in the Integration Steps Summary on get-started.md.",
          "Cite content claims with exact K[docId_chunkIndex] citations.",
        ].join(" "),
      },
    ]

    if (juspayPartialScopeFixture) {
      scenarios.push({
        name: "juspay-partial-folder-scope",
        agent: juspayAgent,
        knowledgeItemIdsOverride: [`clfd-${juspayPartialScopeFixture.folderId}`],
        query: [
          "Use ls before any searchKnowledgeBase call in this run.",
          "The current KB scope is intentionally narrowed; do not infer collection-root access from the current root.",
          `Starting from the current KB root only, identify the visible folder and list the visible markdown files under it.`,
          `Then answer what ${juspayPartialScopeFixture.fileName} says about its key integration step or summary point.`,
          "Prefer reusing exact ls row ids when you call searchKnowledgeBase.",
          "Cite content claims with exact K[docId_chunkIndex] citations.",
        ].join(" "),
      })

      scenarios.push({
        name: "juspay-partial-file-scope",
        agent: juspayAgent,
        knowledgeItemIdsOverride: [`clf-${juspayPartialScopeFixture.fileId}`],
        query: [
          "Use ls before any searchKnowledgeBase call in this run.",
          "The current KB scope may be a single file root; do not infer folder or collection access.",
          "Starting from the current KB root only, identify the visible file and answer from that file alone.",
          `Tell me the key integration step or summary point stated in ${juspayPartialScopeFixture.fileName}.`,
          "Prefer reusing the exact ls row id when you call searchKnowledgeBase.",
          "Cite content claims with exact K[docId_chunkIndex] citations.",
        ].join(" "),
      })
    }

    if (uliAgent) {
      scenarios.push({
        name: "uli-api-specs",
        agent: uliAgent,
        query: [
          "Use ls before any searchKnowledgeBase call in this run.",
          "Find which folder under the current KB roots contains the API specifications.",
          "Then answer from that scope: according to the relevant API specification, how long is the token valid in sandbox and production?",
          "Cite content claims with exact K[docId_chunkIndex] citations.",
        ].join(" "),
      })
    }

    return { user, scenarios }
  } finally {
    await sql.end()
  }
}

function createAgentContext(
  user: LiveUser,
  query: string,
  agent: LiveKbAgent,
  knowledgeItemIdsOverride?: string[],
) {
  const appIntegrations =
    knowledgeItemIdsOverride && knowledgeItemIdsOverride.length > 0
      ? {
          ...agent.appIntegrations,
          knowledge_base: {
            ...((agent.appIntegrations as any)?.knowledge_base ?? {}),
            itemIds: knowledgeItemIdsOverride,
            selectedAll: false,
          },
        }
      : agent.appIntegrations

  return {
    user: {
      email: user.email,
      workspaceId: user.workspaceExternalId,
      id: String(user.id),
      numericId: user.id,
      workspaceNumericId: user.workspaceNumericId,
    },
    chat: {
      externalId: `kb-sync-${agent.externalId}`,
      metadata: {},
    },
    message: {
      text: query,
      attachments: [],
      timestamp: new Date().toISOString(),
    },
    modelId: MODEL_ID,
    plan: null,
    currentSubTask: null,
    userContext: "",
    agentPrompt: JSON.stringify({
      appIntegrations,
    }),
    dedicatedAgentSystemPrompt: undefined,
    conversationHistoryMessages: [],
    episodicMemoriesText: undefined,
    chatMemoryText: undefined,
    clarifications: [],
    ambiguityResolved: true,
    toolCallHistory: [],
    documentMemory: new Map(),
    currentTurnDocumentMemory: new Map(),
    currentTurnArtifacts: {
      expectations: [],
      toolOutputs: [],
      syntheticDocs: [],
      executionToolsCalled: 0,
      todoWriteCalled: false,
      turnStartedAt: Date.now(),
    },
    turnCount: 1,
    totalLatency: 0,
    totalCost: 0,
    tokenUsage: { input: 0, output: 0 },
    availableAgents: [],
    usedAgents: [],
    enabledTools: new Set(["ls", "searchKnowledgeBase"]),
    delegationEnabled: false,
    failedTools: new Map(),
    retryCount: 0,
    maxRetries: 3,
    review: {
      lastReviewTurn: null,
      reviewFrequency: 5,
      lastReviewedFragmentIndex: 0,
      outstandingAnomalies: [],
      clarificationQuestions: [],
      lastReviewResult: null,
      lockedByFinalSynthesis: false,
      lockedAtTurn: null,
    },
    turnRankedCount: new Map(),
    turnNewChunksCount: new Map(),
    decisions: [],
    finalSynthesis: {
      requested: false,
      completed: false,
      suppressAssistantStreaming: false,
      streamedText: "",
      ackReceived: false,
    },
    stopRequested: false,
  } as const
}

function buildInstructions() {
  return [
    "You are running a targeted knowledge-base ls/search sync inspection.",
    "Only two tools are available: ls and searchKnowledgeBase.",
    "You must browse with ls before any searchKnowledgeBase call in this run.",
    "When reusing ls output, prefer row ids by row type: collection rows as collection targets, folder rows as folder targets, file rows as file targets.",
    "Do not infer collection-root access from a folder or file row.",
    "If you need content evidence, use searchKnowledgeBase after browsing.",
    "Answer concisely and cite any content claims with exact K[docId_chunkIndex] citations.",
    buildAgentPromptAddendum(),
  ].join("\n\n")
}

function countEvents(events: string[]) {
  const counts: Record<string, number> = {}
  for (const event of events) {
    counts[event] = (counts[event] ?? 0) + 1
  }
  return counts
}

function summarizeLsSnapshot(data: any) {
  return {
    targetType:
      data?.target && typeof data.target === "object"
        ? (data.target.type ?? null)
        : null,
    entryTypes: Array.isArray(data?.entries)
      ? data.entries.map((entry: any) => entry?.type ?? "unknown")
      : [],
    entryIds: Array.isArray(data?.entries)
      ? data.entries.map((entry: any) => entry?.id ?? "unknown")
      : [],
    total: typeof data?.total === "number" ? data.total : null,
  }
}

function summarizeSearchSnapshot(data: any) {
  return {
    query: typeof data?.query === "string" ? data.query : null,
    targets: data?.filters?.targets ?? null,
    fragmentCount: Array.isArray(data?.fragments) ? data.fragments.length : 0,
    rawDocumentCount: Array.isArray(data?.rawDocuments)
      ? data.rawDocuments.length
      : 0,
  }
}

function extractActionableIdsFromLsSnapshots(lsSnapshots: ToolResultSnapshot[]) {
  const actionable = {
    collectionIds: new Set<string>(),
    folderIds: new Set<string>(),
    fileIds: new Set<string>(),
  }

  for (const snapshot of lsSnapshots) {
    const data = snapshot.data as any
    const rows = Array.isArray(data?.entries) ? data.entries : []
    const target = data?.target && typeof data.target === "object" ? [data.target] : []

    for (const row of [...rows, ...target]) {
      if (!row || typeof row !== "object") continue
      if (row.type === "collection" && typeof row.id === "string") {
        actionable.collectionIds.add(row.id)
      } else if (row.type === "folder" && typeof row.id === "string") {
        actionable.folderIds.add(row.id)
      } else if (row.type === "file" && typeof row.id === "string") {
        actionable.fileIds.add(row.id)
      }
    }
  }

  return actionable
}

function analyzeScenario(
  query: string,
  toolRequests: Array<{ name: string; args: any }>,
  toolResults: ToolResultSnapshot[],
  synthesisDocIds: string[],
  resolvedCitationDocIds: string[],
  citedDocIdsInAnswer: string[],
) {
  const issues: string[] = []
  const observations: string[] = []

  const lsRequests = toolRequests.filter((request) => request.name === "ls")
  const searchRequests = toolRequests.filter(
    (request) => request.name === "searchKnowledgeBase",
  )
  const firstLsIndex = toolRequests.findIndex((request) => request.name === "ls")
  const firstSearchIndex = toolRequests.findIndex(
    (request) => request.name === "searchKnowledgeBase",
  )

  if (firstLsIndex === -1) {
    issues.push("Model never called ls, so the structure-first KB flow was skipped.")
  }
  if (firstSearchIndex === -1) {
    issues.push("Model never called searchKnowledgeBase, so content retrieval did not happen.")
  }
  if (
    firstLsIndex !== -1 &&
    firstSearchIndex !== -1 &&
    firstSearchIndex < firstLsIndex
  ) {
    issues.push("Model called searchKnowledgeBase before ls, which breaks the intended browse-then-search flow.")
  }

  const actionableIds = extractActionableIdsFromLsSnapshots(
    toolResults.filter((snapshot) => snapshot.toolName === "ls"),
  )

  for (const request of searchRequests) {
    const targets = request.args?.filters?.targets
    if (!Array.isArray(targets) || targets.length === 0) {
      observations.push(
        "searchKnowledgeBase ran without explicit structural targets; valid, but it does not prove ls/search target reuse.",
      )
      continue
    }

    for (const target of targets) {
      if (!target || typeof target !== "object") continue
      if (
        target.type === "collection" &&
        typeof target.collectionId === "string"
      ) {
        if (!actionableIds.collectionIds.has(target.collectionId)) {
          issues.push(
            `searchKnowledgeBase used collection target '${target.collectionId}' that was not present in prior ls output.`,
          )
        }
        continue
      }
      if (target.type === "folder" && typeof target.folderId === "string") {
        if (!actionableIds.folderIds.has(target.folderId)) {
          issues.push(
            `searchKnowledgeBase used folder target '${target.folderId}' that was not present in prior ls output.`,
          )
        }
        continue
      }
      if (target.type === "file" && typeof target.fileId === "string") {
        if (!actionableIds.fileIds.has(target.fileId)) {
          issues.push(
            `searchKnowledgeBase used file target '${target.fileId}' that was not present in prior ls output.`,
          )
        }
        continue
      }
      if (target.type === "path") {
        observations.push(
          "Model reused a path target after browsing. This is allowed, but it is less direct than row-id reuse.",
        )
      }
    }
  }

  if (searchRequests.length > 0 && synthesisDocIds.length === 0) {
    issues.push(
      "searchKnowledgeBase executed but no raw-document chunks were merged into synthesis memory.",
    )
  }

  if (
    searchRequests.length > 0 &&
    resolvedCitationDocIds.length === 0 &&
    /cite/i.test(query)
  ) {
    issues.push(
      "Final answer did not produce any resolvable chunk citations despite the query requesting them.",
    )
  }

  const unresolvedCitationDocIds = citedDocIdsInAnswer.filter(
    (docId) => !resolvedCitationDocIds.includes(docId),
  )
  if (unresolvedCitationDocIds.length > 0) {
    issues.push(
      `Final answer referenced KB citation docIds that did not resolve through citation post-processing: ${unresolvedCitationDocIds.join(", ")}.`,
    )
  }

  const citationDocIdsOutsideSynthesis = citedDocIdsInAnswer.filter(
    (docId) => !synthesisDocIds.includes(docId),
  )
  if (citationDocIdsOutsideSynthesis.length > 0) {
    issues.push(
      `Final answer referenced KB citation docIds that were not present in synthesis memory: ${citationDocIdsOutsideSynthesis.join(", ")}.`,
    )
  }

  return {
    issues,
    observations,
    unresolvedCitationDocIds,
    citationDocIdsOutsideSynthesis,
  }
}

async function collectResolvedCitationDocIds(
  answer: string,
  fragments: Awaited<ReturnType<typeof getFragmentsForSynthesis>>,
  email: string,
) {
  const docIds: string[] = []
  for await (const event of checkAndYieldCitationsForAgent(
    answer,
    new Set<number>(),
    fragments,
    new Map<number, Set<number>>(),
    email,
  )) {
    if (event.citation?.item?.docId) {
      docIds.push(event.citation.item.docId)
    }
  }
  return docIds
}

function extractKbCitationDocIdsFromAnswer(answer: string) {
  const matches = answer.matchAll(/K\[([A-Za-z0-9_-]+)_\d+\]/g)
  return [...new Set(Array.from(matches, (match) => match[1]))]
}

async function runScenario(user: LiveUser, scenario: ScenarioFixture): Promise<ScenarioReport> {
  const context = createAgentContext(
    user,
    scenario.query,
    scenario.agent,
    scenario.knowledgeItemIdsOverride,
  )
  const toolRequests: Array<{ name: string; args: any }> = []
  const toolResults: ToolResultSnapshot[] = []
  const eventTypes: string[] = []
  let answer = ""
  let currentTurn = 1

  const stopController = new AbortController()
  const timeout = setTimeout(() => stopController.abort(), SCENARIO_TIMEOUT_MS)
  ;(context as any).stopSignal = stopController.signal
  ;(context as any).stopRequested = false

  const traceEventHandler = async (event: any) => {
    if (event.type === "before_tool_execution") {
      return beforeToolExecutionHook(
        event.data.toolName,
        event.data.args,
        context as any,
      )
    }
    return undefined
  }

  const agent = {
    name: `kb-sync-${scenario.name}`,
    instructions: () => buildInstructions(),
    tools: [lsKnowledgeBaseTool, searchKnowledgeBaseTool],
    modelConfig: { name: MODEL_ID },
  }

  const runCfg = {
    agentRegistry: new Map([[agent.name, agent]]),
    modelProvider: makeXyneJAFProvider(),
    modelOverride: MODEL_ID,
    maxTurns: MAX_TURNS,
    onAfterToolExecution: async (
      toolName: string,
      result: any,
      hookContext: any,
    ) => {
      toolResults.push({
        toolName,
        data: result?.data ?? null,
      })
      return afterToolExecutionHook(
        toolName,
        result,
        hookContext,
        scenario.query,
        [
          {
            role: "user",
            content: [{ text: scenario.query }],
          },
        ] as any,
        undefined,
        currentTurn,
      )
    },
  }

  const runState = {
    runId: createRunId(`kb-sync-run-${scenario.name}`),
    traceId: createTraceId(`kb-sync-trace-${scenario.name}`),
    messages: [
      {
        role: "user",
        content: scenario.query,
      },
    ],
    currentAgentName: agent.name,
    context,
    turnCount: 1,
  }

  try {
    for await (const event of runStream(runState as any, runCfg as any, traceEventHandler)) {
      eventTypes.push(event.type)
      if (event.type === "turn_start") {
        currentTurn = event.data.turn
        ;(context as any).turnCount = event.data.turn
      }
      if (event.type === "tool_requests") {
        for (const toolCall of event.data.toolCalls) {
          toolRequests.push({
            name: toolCall.name,
            args: toolCall.args,
          })
        }
      }
      if (event.type === "assistant_message") {
        const content = getTextContent(event.data.message.content)
        if (content) {
          answer = content
        }
      }
      if (event.type === "final_output" && typeof event.data.output === "string") {
        answer = event.data.output
      }
    }
  } finally {
    clearTimeout(timeout)
  }

  for (const output of (context as any).currentTurnArtifacts.toolOutputs) {
    if (output.rawDocuments?.length) {
      mergeRawDocumentsIntoDocumentMemory(
        (context as any).documentMemory,
        output.rawDocuments,
        currentTurn,
        output.query ?? "",
        output.toolName,
      )
    }
  }

  const synthesisFragments = await getFragmentsForSynthesis(
    (context as any).documentMemory,
    {
      email: user.email,
      userId: user.id,
      workspaceId: user.workspaceNumericId,
    },
  )
  const synthesisDocIds = synthesisFragments.map((fragment) => fragment.id)
  const resolvedCitationDocIds = await collectResolvedCitationDocIds(
    answer,
    synthesisFragments,
    user.email,
  )
  const citedDocIdsInAnswer = extractKbCitationDocIdsFromAnswer(answer)
  const analysis = analyzeScenario(
    scenario.query,
    toolRequests,
    toolResults,
    synthesisDocIds,
    resolvedCitationDocIds,
    citedDocIdsInAnswer,
  )

  return {
    name: scenario.name,
    agentName: scenario.agent.name,
    query: scenario.query,
    answer,
    toolSequence: toolRequests.map((request) => request.name),
    toolRequests,
    lsSnapshots: toolResults
      .filter((snapshot) => snapshot.toolName === "ls")
      .map((snapshot) => summarizeLsSnapshot(snapshot.data)),
    searchSnapshots: toolResults
      .filter((snapshot) => snapshot.toolName === "searchKnowledgeBase")
      .map((snapshot) => summarizeSearchSnapshot(snapshot.data)),
    synthesisDocIds,
    resolvedCitationDocIds,
    citedDocIdsInAnswer,
    unresolvedCitationDocIds: analysis.unresolvedCitationDocIds,
    citationDocIdsOutsideSynthesis: analysis.citationDocIdsOutsideSynthesis,
    eventCounts: countEvents(eventTypes),
    issues: analysis.issues,
    observations: analysis.observations,
  }
}

async function main() {
  logSection("Discover Fixtures")
  const { user, scenarios } = await discoverFixtures()
  console.log(
    `Using user ${user.email} in workspace ${user.workspaceExternalId} with model ${MODEL_ID}`,
  )
  console.log(
    `Running scenarios: ${scenarios.map((scenario) => scenario.name).join(", ")}`,
  )

  const reports: ScenarioReport[] = []
  const globalIssues: string[] = []

  for (const scenario of scenarios) {
    logSection(`Scenario: ${scenario.name}`)
    console.log(`Agent: ${scenario.agent.name}`)
    console.log(`Query: ${truncate(scenario.query, 320)}`)

    try {
      const report = await runScenario(user, scenario)
      reports.push(report)
      console.log(`Tool sequence: ${report.toolSequence.join(" -> ") || "(none)"}`)
      console.log(`Answer preview: ${truncate(report.answer || "(empty)", 320)}`)
      if (report.issues.length) {
        console.log("Issues:")
        for (const issue of report.issues) {
          console.log(`- ${issue}`)
        }
      } else {
        console.log("Issues: none")
      }
      if (report.observations.length) {
        console.log("Observations:")
        for (const observation of report.observations) {
          console.log(`- ${observation}`)
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error)
      globalIssues.push(
        `${scenario.name}: inspection failed before analysis with '${message}'`,
      )
      console.log(`Scenario failed: ${message}`)
    }
  }

  const report: FullReport = {
    generatedAt: new Date().toISOString(),
    modelId: MODEL_ID,
    maxTurns: MAX_TURNS,
    user: {
      email: user.email,
      workspaceExternalId: user.workspaceExternalId,
    },
    scenarios: reports,
    issues: [
      ...globalIssues,
      ...reports.flatMap((scenario) =>
        scenario.issues.map((issue) => `${scenario.name}: ${issue}`),
      ),
    ],
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  await writeFile(OUTPUT_PATH, JSON.stringify(report, null, 2))

  logSection("Report")
  console.log(`Wrote inspection report to ${OUTPUT_PATH}`)
  if (report.issues.length) {
    console.log("Global issues:")
    for (const issue of report.issues) {
      console.log(`- ${issue}`)
    }
  } else {
    console.log("No issues detected in the inspected scenarios.")
  }
}

await main()
