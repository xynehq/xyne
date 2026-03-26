import { describe, expect, test } from "bun:test"
import { ConversationRole, type Message as BedrockMessage } from "@aws-sdk/client-bedrock-runtime"
import {
  Apps,
  KnowledgeBaseEntity,
} from "@xyne/vespa-ts/types"
import {
  ToolResponse,
  createRunId,
  createTraceId,
  getTextContent,
  runStream,
  type Agent,
  type Message,
  type ModelProvider,
  type Tool,
  type ToolCall,
} from "@xynehq/jaf"
import type {
  AgentRunContext,
  DocumentState,
  ToolRawDocument,
} from "@/api/chat/agent-schemas"
import type { MinimalAgentFragment } from "@/api/chat/types"
import type { Collection, CollectionItem } from "@/db/schema"

process.env.ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

const {
  beforeToolExecutionHook,
  afterToolExecutionHook,
} = await import("@/api/chat/message-agents")
const {
  executeLsKnowledgeBase,
  executeSearchKnowledgeBase,
  LsKnowledgeBaseInputSchema,
  SearchKnowledgeBaseInputSchema,
} = await import("@/api/chat/tools/knowledgeBaseFlow")
const {
  getFragmentsForSynthesis,
  mergeRawDocumentsIntoDocumentMemory,
} = await import("@/api/chat/document-memory")
const { checkAndYieldCitationsForAgent } = await import("@/api/chat/utils")

type LsKnowledgeBaseToolParams = Parameters<typeof executeLsKnowledgeBase>[0]
type SearchKnowledgeBaseToolParams = Parameters<
  typeof executeSearchKnowledgeBase
>[0]
type SearchKnowledgeBaseOptions = NonNullable<
  Parameters<typeof executeSearchKnowledgeBase>[2]
>
type SearchExecutor = NonNullable<SearchKnowledgeBaseOptions["searchExecutor"]>

const createCollection = (overrides: Partial<Collection>): Collection => ({
  id: "collection-default",
  workspaceId: 1,
  ownerId: 1,
  name: "Default Collection",
  description: null,
  vespaDocId: "cl-default",
  isPrivate: true,
  totalItems: 0,
  lastUpdatedByEmail: "owner@example.com",
  lastUpdatedById: 1,
  uploadStatus: "completed" as any,
  statusMessage: null,
  retryCount: 0,
  metadata: {},
  permissions: [],
  collectionSourceUpdatedAt: new Date("2025-01-02T00:00:00.000Z"),
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  updatedAt: new Date("2025-01-02T00:00:00.000Z"),
  deletedAt: null,
  via_apiKey: false,
  ...overrides,
})

const createItem = (overrides: Partial<CollectionItem>): CollectionItem => ({
  id: "item-default",
  collectionId: "collection-default",
  parentId: null,
  workspaceId: 1,
  ownerId: 1,
  name: "default",
  type: "folder",
  path: "/",
  position: 0,
  vespaDocId: "clfd-default",
  totalFileCount: 0,
  originalName: null,
  storagePath: null,
  storageKey: null,
  mimeType: null,
  fileSize: null,
  checksum: null,
  uploadedByEmail: "owner@example.com",
  uploadedById: 1,
  lastUpdatedByEmail: "owner@example.com",
  lastUpdatedById: 1,
  processingInfo: {},
  processedAt: null,
  uploadStatus: "completed" as any,
  statusMessage: null,
  retryCount: 0,
  metadata: {},
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  updatedAt: new Date("2025-01-02T00:00:00.000Z"),
  deletedAt: null,
  ...overrides,
})

const collectionAlpha = createCollection({
  id: "collection-alpha",
  name: "Alpha",
  totalItems: 3,
})

const projectsFolder = createItem({
  id: "folder-projects",
  collectionId: collectionAlpha.id,
  name: "Projects",
  type: "folder",
  path: "/",
  totalFileCount: 1,
})

const apiFolder = createItem({
  id: "folder-api",
  collectionId: collectionAlpha.id,
  parentId: projectsFolder.id,
  name: "API",
  type: "folder",
  path: "/Projects/",
  totalFileCount: 1,
})

const specFile = createItem({
  id: "file-spec",
  collectionId: collectionAlpha.id,
  parentId: apiFolder.id,
  name: "spec.md",
  type: "file",
  path: "/Projects/API/",
  vespaDocId: "clf-spec",
  originalName: "spec.md",
  mimeType: "text/markdown",
})

function createRepo() {
  const collections = [collectionAlpha]
  const items = [projectsFolder, apiFolder, specFile]

  return {
    async getUserByEmail(_email: string) {
      return { id: 7 }
    },
    async listUserScopedCollections(_userId: number) {
      return collections
    },
    async getCollectionById(collectionId: string) {
      return collections.find((collection) => collection.id === collectionId) ?? null
    },
    async getCollectionItemById(itemId: string) {
      return items.find((item) => item.id === itemId) ?? null
    },
    async listCollectionItems(collectionId: string) {
      return items.filter((item) => item.collectionId === collectionId)
    },
    async listCollectionItemsByIds(collectionId: string, itemIds: string[]) {
      return items.filter(
        (item) =>
          item.collectionId === collectionId && itemIds.includes(item.id),
      )
    },
  }
}

function createAgentPrompt(itemIds: string[]) {
  return JSON.stringify({
    appIntegrations: {
      knowledge_base: {
        itemIds,
        selectedAll: false,
      },
    },
  })
}

function createAgentRunContext(options: {
  message: string
  selectedKnowledgeItemIds: string[]
}): AgentRunContext {
  return {
    user: {
      email: "tester@example.com",
      workspaceId: "workspace-1",
      id: "user-1",
      numericId: 7,
      workspaceNumericId: 9,
    },
    chat: {
      externalId: "chat-kb-sync",
      metadata: {},
    },
    message: {
      text: options.message,
      attachments: [],
      timestamp: new Date().toISOString(),
    },
    modelId: "scripted-model",
    plan: null,
    currentSubTask: null,
    userContext: "",
    agentPrompt: createAgentPrompt(options.selectedKnowledgeItemIds),
    dedicatedAgentSystemPrompt: undefined,
    conversationHistoryMessages: [],
    episodicMemoriesText: undefined,
    chatMemoryText: undefined,
    clarifications: [],
    ambiguityResolved: true,
    toolCallHistory: [],
    documentMemory: new Map<string, DocumentState>(),
    currentTurnDocumentMemory: new Map<string, DocumentState>(),
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
    enabledTools: new Set<string>(),
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
  }
}

function createLsTool(
  repo: ReturnType<typeof createRepo>,
): Tool<LsKnowledgeBaseToolParams, AgentRunContext> {
  return {
    schema: {
      name: "ls",
      description: "Browse the current knowledge-base scope.",
      parameters:
        LsKnowledgeBaseInputSchema as unknown as Tool<
          LsKnowledgeBaseToolParams,
          AgentRunContext
        >["schema"]["parameters"],
    },
    async execute(args, context) {
      return executeLsKnowledgeBase(args, context as any, repo as any)
    },
  }
}

function createSearchTool(
  repo: ReturnType<typeof createRepo>,
  searchExecutor: SearchExecutor,
): Tool<SearchKnowledgeBaseToolParams, AgentRunContext> {
  return {
    schema: {
      name: "searchKnowledgeBase",
      description: "Search the current knowledge-base scope.",
      parameters:
        SearchKnowledgeBaseInputSchema as unknown as Tool<
          SearchKnowledgeBaseToolParams,
          AgentRunContext
        >["schema"]["parameters"],
    },
    async execute(args, context) {
      return executeSearchKnowledgeBase(args, context as any, {
        repo: repo as any,
        searchExecutor,
      })
    },
  }
}

function createToolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: "function" as const,
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  }
}

function createScriptedProvider(
  steps: Array<(state: Readonly<{ messages: readonly Message[] }>) => { message?: { content?: string | null; tool_calls?: readonly ToolCall[] } }>,
): ModelProvider<AgentRunContext> {
  let index = 0
  return {
    async getCompletion(state) {
      const step = steps[index]
      if (!step) {
        return {
          message: {
            content: "No scripted completion available.",
          },
        }
      }
      index += 1
      return step(state)
    },
  }
}

function parseSerializedToolMessage(snapshot: string): {
  status: string
  result: string
  tool_name: string
  message: string
} {
  const parsedSnapshot = JSON.parse(snapshot) as {
    content: string
  }
  return JSON.parse(parsedSnapshot.content) as {
    status: string
    result: string
    tool_name: string
    message: string
  }
}

function createBedrockMessages(userMessage: string): BedrockMessage[] {
  return [
    {
      role: ConversationRole.USER,
      content: [{ text: userMessage }],
    },
  ]
}

async function collectResolvedCitations(
  answer: string,
  fragments: MinimalAgentFragment[],
) {
  const citations: string[] = []
  for await (const event of checkAndYieldCitationsForAgent(
    answer,
    new Set<number>(),
    fragments,
    new Map<number, Set<number>>(),
    "tester@example.com",
  )) {
    if (event.citation?.item?.docId) {
      citations.push(event.citation.item.docId)
    }
  }
  return citations
}

async function runScriptedKnowledgeBaseFlow(params: {
  message: string
  selectedKnowledgeItemIds: string[]
  provider: ModelProvider<AgentRunContext>
  searchExecutor: SearchExecutor
}) {
  const context = createAgentRunContext({
    message: params.message,
    selectedKnowledgeItemIds: params.selectedKnowledgeItemIds,
  })
  const repo = createRepo()
  const tools = [
    createLsTool(repo),
    createSearchTool(repo, params.searchExecutor),
  ]
  context.enabledTools = new Set(tools.map((tool) => tool.schema.name))

  const agent: Agent<AgentRunContext, string> = {
    name: "kb-sync-test-agent",
    instructions: () =>
      "Use ls and searchKnowledgeBase to inspect the KB, then answer concisely with chunk citations when available.",
    tools,
    modelConfig: { name: "scripted-model" },
  }

  const toolResults: Array<{
    toolName: string
    data: unknown
  }> = []
  const eventLog: Array<{ type: string; payload: unknown }> = []
  let answer = ""
  let currentTurn = 1

  const traceEventHandler = async (event: any) => {
    if (event.type === "before_tool_execution") {
      return beforeToolExecutionHook(
        event.data.toolName,
        event.data.args,
        context,
      )
    }
    return undefined
  }

  const runCfg = {
    agentRegistry: new Map([[agent.name, agent]]),
    modelProvider: params.provider,
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
        params.message,
        createBedrockMessages(params.message),
        undefined,
        currentTurn,
      )
    },
  }

  const runState = {
    runId: createRunId("kb-sync-scripted-run"),
    traceId: createTraceId("kb-sync-scripted-trace"),
    messages: [
      {
        role: "user" as const,
        content: params.message,
      },
    ],
    currentAgentName: agent.name,
    context,
    turnCount: 1,
  }

  for await (const event of runStream(runState, runCfg, traceEventHandler)) {
    eventLog.push({ type: event.type, payload: event.data })
    if (event.type === "turn_start") {
      currentTurn = event.data.turn
      context.turnCount = event.data.turn
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

  for (const output of context.currentTurnArtifacts.toolOutputs) {
    if (output.rawDocuments?.length) {
      mergeRawDocumentsIntoDocumentMemory(
        context.documentMemory,
        output.rawDocuments,
        currentTurn,
        output.query ?? "",
        output.toolName,
      )
    }
  }

  const synthesisFragments = await getFragmentsForSynthesis(context.documentMemory, {
    email: context.user.email,
    userId: context.user.numericId,
    workspaceId: context.user.workspaceNumericId,
  })

  return {
    answer,
    context,
    eventLog,
    synthesisFragments,
    toolResults,
  }
}

describe("knowledge-base message agent flow", () => {
  test("partial folder scope syncs untargeted ls roots into a folder-scoped KB search and chunk memory", async () => {
    const providerSnapshots: string[] = []
    const searchCalls: Array<Record<string, unknown>> = []

    const provider = createScriptedProvider([
      () => ({
        message: {
          tool_calls: [createToolCall("call-ls-1", "ls", {})],
        },
      }),
      (state) => {
        providerSnapshots.push(
          JSON.stringify(state.messages[state.messages.length - 1] ?? null),
        )
        return {
          message: {
            tool_calls: [
              createToolCall("call-search-1", "searchKnowledgeBase", {
                query: "API spec",
                filters: {
                  targets: [{ type: "folder", folderId: projectsFolder.id }],
                },
              }),
            ],
          },
        }
      },
      (state) => {
        providerSnapshots.push(
          JSON.stringify(state.messages[state.messages.length - 1] ?? null),
        )
        return {
          message: {
            content:
              "The accessible root is Projects, and the matching file is spec.md K[file-spec_0].",
          },
        }
      },
    ])

    const searchExecutor: SearchExecutor = async (options: any) => {
      searchCalls.push({
        collectionSelections: options.collectionSelections,
        excludedIds: options.excludedIds ?? [],
        query: options.query,
      })

      const fragment: MinimalAgentFragment = {
        id: specFile.id,
        content: "Spec chunk 0",
        confidence: 0.91,
        source: {
          docId: specFile.id,
          title: specFile.name,
          url: "",
          app: Apps.KnowledgeBase,
          entity: KnowledgeBaseEntity.File,
        },
      }

      const rawDocument: ToolRawDocument = {
        docId: specFile.id,
        relevance: 0.91,
        source: fragment.source,
        chunks: [
          {
            chunkKey: "i:0",
            content: "Spec chunk 0",
            score: 0.91,
          },
          {
            chunkKey: "i:1",
            content: "Spec chunk 1",
            score: 0.88,
          },
        ],
        vespaHit: {
          relevance: 0.91,
          fields: {
            sddocname: "kb_items",
            docId: specFile.id,
          },
        } as any,
      }

      return {
        fragments: [fragment],
        rawDocuments: [rawDocument],
      }
    }

    const result = await runScriptedKnowledgeBaseFlow({
      message:
        "Browse the current KB root, then search inside the visible folder for the API spec and cite the chunk you used.",
      selectedKnowledgeItemIds: [`clfd-${projectsFolder.id}`],
      provider,
      searchExecutor,
    })

    expect(
      result.eventLog
        .filter((event) => event.type === "tool_requests")
        .map((event) =>
          (event.payload as any).toolCalls.map((call: any) => call.name),
        ),
    ).toEqual([["ls"], ["searchKnowledgeBase"]])

    const lsToolMessage = parseSerializedToolMessage(providerSnapshots[0])
    const searchToolMessage = parseSerializedToolMessage(providerSnapshots[1])

    expect(lsToolMessage.tool_name).toBe("ls")
    expect(lsToolMessage.result).toContain("\"type\":\"folder\"")
    expect(lsToolMessage.result).toContain(`\"id\":\"${projectsFolder.id}\"`)
    expect(searchToolMessage.tool_name).toBe("searchKnowledgeBase")
    expect(searchToolMessage.result).toContain("Spec chunk 0")

    expect(searchCalls).toEqual([
      {
        collectionSelections: [{ collectionFolderIds: [projectsFolder.id] }],
        excludedIds: [],
        query: "API spec",
      },
    ])

    expect(
      result.context.currentTurnArtifacts.toolOutputs.map((output) => ({
        toolName: output.toolName,
        rawDocuments: output.rawDocuments?.length ?? 0,
      })),
    ).toEqual([
      { toolName: "ls", rawDocuments: 0 },
      { toolName: "searchKnowledgeBase", rawDocuments: 1 },
    ])

    expect(result.synthesisFragments).toHaveLength(1)
    expect(result.synthesisFragments[0]?.id).toBe(specFile.id)
    expect(result.answer).toContain("K[file-spec_0]")
    expect(
      await collectResolvedCitations(result.answer, result.synthesisFragments),
    ).toEqual([specFile.id])
  })

  test("full collection scope keeps collection-row reuse valid across the agent loop", async () => {
    const providerSnapshots: string[] = []
    const searchCalls: Array<Record<string, unknown>> = []

    const provider = createScriptedProvider([
      () => ({
        message: {
          tool_calls: [createToolCall("call-ls-1", "ls", {})],
        },
      }),
      (state) => {
        providerSnapshots.push(
          JSON.stringify(state.messages[state.messages.length - 1] ?? null),
        )
        return {
          message: {
            tool_calls: [
              createToolCall("call-search-1", "searchKnowledgeBase", {
                query: "README",
                filters: {
                  targets: [
                    {
                      type: "collection",
                      collectionId: collectionAlpha.id,
                    },
                  ],
                },
              }),
            ],
          },
        }
      },
      () => ({
        message: {
          content: "Alpha contains the README entry and the search stayed collection-scoped.",
        },
      }),
    ])

    const searchExecutor: SearchExecutor = async (options: any) => {
      searchCalls.push({
        collectionSelections: options.collectionSelections,
        query: options.query,
      })
      return {
        fragments: [
          {
            id: specFile.id,
            content: "README overview chunk",
            confidence: 0.8,
            source: {
              docId: specFile.id,
              title: specFile.name,
              url: "",
              app: Apps.KnowledgeBase,
              entity: KnowledgeBaseEntity.File,
            },
          },
        ],
        rawDocuments: [
          {
            docId: specFile.id,
            relevance: 0.8,
            source: {
              docId: specFile.id,
              title: specFile.name,
              url: "",
              app: Apps.KnowledgeBase,
              entity: KnowledgeBaseEntity.File,
            },
            chunks: [
              {
                chunkKey: "i:0",
                content: "README overview chunk",
                score: 0.8,
              },
            ],
            vespaHit: {
              relevance: 0.8,
              fields: {
                sddocname: "kb_items",
                docId: specFile.id,
              },
            } as any,
          },
        ],
      }
    }

    const result = await runScriptedKnowledgeBaseFlow({
      message:
        "List the current KB roots and then search the collection for the README entry.",
      selectedKnowledgeItemIds: [`cl-${collectionAlpha.id}`],
      provider,
      searchExecutor,
    })

    const lsToolMessage = parseSerializedToolMessage(providerSnapshots[0])

    expect(lsToolMessage.tool_name).toBe("ls")
    expect(lsToolMessage.result).toContain("\"type\":\"collection\"")
    expect(lsToolMessage.result).toContain(`\"id\":\"${collectionAlpha.id}\"`)
    expect(searchCalls).toEqual([
      {
        collectionSelections: [{ collectionIds: [collectionAlpha.id] }],
        query: "README",
      },
    ])
    expect(
      result.context.toolCallHistory.map((record) => record.toolName),
    ).toEqual(["ls", "searchKnowledgeBase"])
  })
})
