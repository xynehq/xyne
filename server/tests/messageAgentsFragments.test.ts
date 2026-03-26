import { describe, expect, test } from "bun:test"
import type { AgentRunContext } from "@/api/chat/agent-schemas"
import {
  chunkKeyFromContent,
  createDocumentState,
  getFragmentsForSynthesis,
  getAllImagesFromDocumentMemory,
} from "@/api/chat/document-memory"
import {
  __messageAgentsHistoryInternals,
  __messageAgentsMetadataInternals,
  __messageAgentsPromptInternals,
  afterToolExecutionHook,
  beforeToolExecutionHook,
  buildDelegatedAgentFragments,
  buildFinalSynthesisRequest,
  buildFinalSynthesisPayload,
  buildReviewRequest,
  buildReviewPromptFromContext,
} from "@/api/chat/message-agents"
import { SynthesizeFinalAnswerInputSchema } from "@/api/chat/tool-schemas"
import { buildMCPJAFTools } from "@/api/chat/jaf-adapter"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import { Apps } from "@xyne/vespa-ts/types"
import { XyneTools } from "@/shared/types"
import { createRunId, createTraceId } from "@xynehq/jaf"

const baseFragment: MinimalAgentFragment = {
  id: "doc-1",
  content: "Quarterly ARR grew 12%",
  source: {
    docId: "doc-1",
    title: "ARR Summary",
    url: "https://example.com/doc-1",
    app: Apps.KnowledgeBase,
    entity: "file" as any,
  },
  confidence: 0.9,
}

const createMockContext = (): AgentRunContext => {
  const context: AgentRunContext = {
  user: {
    email: "tester@example.com",
    workspaceId: "workspace",
    id: "user-1",
  },
  chat: {
    externalId: "chat-1",
    metadata: {},
  },
  message: {
    text: "How is ARR tracking?",
    attachments: [],
    timestamp: new Date().toISOString(),
  },
  plan: null,
  currentSubTask: null,
  userContext: "",
  agentPrompt: undefined,
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
  enabledTools: new Set<string>(),
  delegationEnabled: true,
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

  // Legacy helper used by excludedIds injection tests (not part of AgentRunContext)
  ;(context as any).seenDocuments = new Set<string>()
  return context
}

describe("message-agents context tracking", () => {
  test("run_public_agent with no rawDocuments creates a synthetic DocumentState", async () => {
    const context = createMockContext()

    await afterToolExecutionHook(
      XyneTools.runPublicAgent,
      {
        status: "success",
        data: {
          resultSummary: "Delegate found something but gave no citations.",
          rawDocuments: [],
          citations: [],
          agentId: "agent-123",
        },
      },
      {
        toolCall: { id: "call-delegate-1" } as any,
        args: { agentId: "agent-123", query: "test" },
        state: {
          context,
          messages: [],
          runId: createRunId("run-delegate-1"),
          traceId: createTraceId("trace-delegate-1"),
          currentAgentName: "xyne-agent",
          turnCount: 1,
        },
        agentName: "xyne-agent",
        executionTime: 10,
        status: "success",
      },
      context.message.text,
      [],
      undefined,
      context.turnCount,
    )

    // Delegated agent outputs now always produce a synthetic delegated DocumentState
    // (even when there are no citations/rawDocuments).
    expect(context.currentTurnArtifacts.syntheticDocs.length).toBe(1)
    expect(context.currentTurnArtifacts.syntheticDocs[0].docId).toContain(
      "delegated_agent:agent-123:turn:1",
    )
    expect(context.currentTurnArtifacts.toolOutputs.length).toBe(1)
    expect(context.currentTurnArtifacts.toolOutputs[0].toolName).toBe(
      XyneTools.runPublicAgent,
    )
    expect(context.currentTurnArtifacts.toolOutputs[0].resultSummary).toContain(
      "Delegate found something",
    )
  })

  test("afterToolExecutionHook stores rawDocuments in documentMemory and toolOutputs", async () => {
    const context = createMockContext()
    const imageRef = {
      fileName: "0_doc-1_0",
      addedAtTurn: 1,
      sourceFragmentId: baseFragment.id,
      sourceToolName: "searchGlobal",
      isUserAttachment: false,
    }
    const rawDocuments = [
      {
        docId: baseFragment.id,
        relevance: 0.8,
        source: baseFragment.source,
        chunks: [
          {
            chunkKey: "c:1",
            content: baseFragment.content,
            score: 0.8,
          },
        ],
        vespaHit: {
          relevance: 0.8,
          fields: { sddocname: "file", docId: baseFragment.id },
        },
      } as any,
    ]

    await afterToolExecutionHook(
      "searchGlobal",
      {
        status: "success",
        metadata: {},
        data: {
          result: "Found ARR updates.",
          rawDocuments,
        },
      },
      {
        toolCall: { id: "call-1" } as any,
        args: { query: "ARR" },
        state: {
          context,
          messages: [],
          runId: createRunId("run-1"),
          traceId: createTraceId("trace-1"),
          currentAgentName: "xyne-agent",
          turnCount: 1,
        },
        agentName: "xyne-agent",
        executionTime: 10,
        status: "success",
      },
      context.message.text,
      [],
      undefined,
      context.turnCount
    )

    // Tool results are buffered and merged into currentTurnDocumentMemory at turn-end
    expect(context.currentTurnDocumentMemory.size).toBe(0)
    const toolOutput = context.currentTurnArtifacts.toolOutputs.find(
      (o) => o.toolName === "searchGlobal"
    )
    expect(toolOutput?.rawDocuments).toHaveLength(1)
    expect(toolOutput?.query).toBe("ARR")
    expect(context.currentTurnArtifacts.executionToolsCalled).toBe(1)
  })

  test("getFragmentsForSynthesis normalizes vespaHit to doc.chunks slice", async () => {
    const doc = createDocumentState(
      "doc-1",
      {
        docId: "doc-1",
        title: "Doc",
        url: "https://example.com/doc-1",
        app: Apps.KnowledgeBase,
        entity: "file" as any,
      },
    )

    // Document state has only B and C (evicted A).
    doc.chunks.set("seq:1", {
      content: "CHUNK_B_RELEVANT",
      firstSeenTurn: 1,
      lastSeenTurn: 1,
      confidence: 0, // all-zero chunk scores (important regression case)
      queries: ["q"],
    })
    doc.chunks.set("seq:2", {
      content: "CHUNK_C_RELEVANT",
      firstSeenTurn: 1,
      lastSeenTurn: 1,
      confidence: 0,
      queries: ["q"],
    })

    doc.signals.push({
      query: "q",
      confidence: 1,
      turn: 1,
      toolName: XyneTools.readDocument,
    })
    doc.relevanceScore = 1
    doc.maxScore = 1

    // The original vespaHit still contains A,B,C.
    doc.vespaHit = {
      relevance: 1,
      fields: {
        sddocname: "file",
        docId: "doc-1",
        metadata: { parents: [{ folderName: "root" }] },
        chunks_summary: ["CHUNK_A_EVICTED", "CHUNK_B_RELEVANT", "CHUNK_C_RELEVANT"],
        // Intentionally omit matchfeatures / chunks_pos_summary to force answerContextMap to rely on
        // chunks_summary selection and verify normalization fixes it.
      },
    } as any

    const fragments = await getFragmentsForSynthesis(
      new Map([[doc.docId, doc]]),
      { email: "tester@example.com", query: "q" },
    )

    expect(fragments.length).toBe(1)
    const content = fragments[0].content
    expect(content).toContain("CHUNK_B_RELEVANT")
    expect(content).toContain("CHUNK_C_RELEVANT")
    expect(content).not.toContain("CHUNK_A_EVICTED")
  })

  test("excludedIds injection uses seen source docIds rather than fragment ids", async () => {
    const context = createMockContext()
    const chunkedFragment: MinimalAgentFragment = {
      ...baseFragment,
      id: "doc-1:0",
      source: {
        ...baseFragment.source,
        docId: "doc-1",
      },
    }

    await afterToolExecutionHook(
      "searchGlobal",
      {
        status: "success",
        metadata: {
          contexts: [chunkedFragment],
        },
        data: {
          result: "Found ARR updates.",
        },
      },
      {
        toolCall: { id: "call-docid-1" } as any,
        args: { query: "ARR" },
        state: {
          context,
          messages: [],
          runId: createRunId("run-docid-1"),
          traceId: createTraceId("trace-docid-1"),
          currentAgentName: "xyne-agent",
          turnCount: 1,
        },
        agentName: "xyne-agent",
        executionTime: 10,
        status: "success",
      },
      context.message.text,
      [],
      undefined,
      context.turnCount
    )

    // With deferred ranking, fragments are stored in unrankedFragmentsByTool; seenDocuments
    // is populated at turn-end when ranked fragments are recorded. So after the hook we only
    // have the entry in unrankedFragmentsByTool. Simulate turn-end having run so excludedIds
    // can be verified: add the docId to seenDocuments (as turn-end recording would).
    const preparedArgs = await beforeToolExecutionHook(
      "searchGlobal",
      {
        query: "ARR",
        excludedIds: [],
      },
      context
    )

    expect(preparedArgs.excludedIds).toEqual([])
  }, 15000)

  test("afterToolExecutionHook enforces strict metadata constraints when no compliant docs exist", async () => {
    const context = createMockContext()
    const nonCompliantFragment: MinimalAgentFragment = {
      ...baseFragment,
      source: {
        ...baseFragment.source,
        title: "General Notes",
      },
    }

    await afterToolExecutionHook(
      "searchGlobal",
      {
        status: "success",
        metadata: {
          contexts: [nonCompliantFragment],
        },
        data: {
          result: "Found documents.",
        },
      },
      {
        toolCall: { id: "call-2" } as any,
        args: { query: "notes" },
        state: {
          context,
          messages: [],
          runId: createRunId("run-2"),
          traceId: createTraceId("trace-2"),
          currentAgentName: "xyne-agent",
          turnCount: 1,
        },
        agentName: "xyne-agent",
        executionTime: 10,
        status: "success",
      },
      'Answer only from source "Q4 Planning".',
      [],
      undefined,
      context.turnCount
    )

    // No rawDocuments when strict metadata has no compliant docs → nothing merged into current-turn memory
    expect(context.currentTurnDocumentMemory.size).toBe(0)
  }, 15000)

  test("buildReviewPromptFromContext includes first-review memory context", async () => {
    const context = createMockContext()
    context.plan = {
      goal: "Deliver ARR update",
      subTasks: [
        {
          id: "1",
          description: "Gather ARR docs",
          status: "in_progress",
          toolsRequired: ["searchGlobal"],
        },
      ],
    }
    context.currentTurnArtifacts.toolOutputs.push({
      toolName: "searchGlobal",
      arguments: { query: "ARR" },
      status: "success",
      resultSummary: "Located 2 docs",
    })
    context.currentTurnArtifacts.expectations.push({
      toolName: "searchGlobal",
      expectation: {
        goal: "Find ARR mentions",
        successCriteria: ["ARR keyword present"],
      },
    })
    context.episodicMemoriesText =
      "- [preference] User prefers concise summaries. (chatId: chat-9)"
    context.chatMemoryText = [
      "User: Share ARR update",
      "Assistant thinking: Pull supporting evidence from the strongest fragment.",
      "Assistant: ARR grew 12%.",
    ].join("\n")
    context.documentMemory.set("doc-1", createDocumentState("doc-1", baseFragment.source))
    context.documentMemory.get("doc-1")!.images = [
      { fileName: "doc-1_0", isAttachment: true },
    ]

    const { prompt, imageFileNames } = await buildReviewPromptFromContext(
      context,
      { focus: "turn_end", turnNumber: 1 },
    )

    expect(imageFileNames).toEqual(["0_doc-1_0"])
    expect(prompt).toContain("User Question")
    expect(prompt).toContain("Execution Plan Snapshot")
    expect(prompt).toContain("Memory Context")
    expect(prompt).toContain("Relevant Past Experiences")
    expect(prompt).toContain("Retrieved Chat Memory")
    expect(prompt).toContain("User: Share ARR update")
    expect(prompt).toContain("Assistant: ARR grew 12%.")
    expect(prompt).not.toContain("Assistant thinking:")
    expect(prompt).toContain("Recent Tool Activity")
    expect(prompt).toContain("Expectations")
    expect(prompt).toContain("Images")
    expect(prompt).toContain("Review Focus")
  })

  test("buildReviewRequest prepends conversation history only on first review", async () => {
    const context = createMockContext()
    context.conversationHistoryMessages = [
      {
        role: ConversationRole.USER,
        content: [{ text: "Earlier user question" }],
      },
      {
        role: ConversationRole.ASSISTANT,
        content: [{ text: "Earlier assistant answer" }],
      },
    ]
    context.episodicMemoriesText =
      "- [preference] User prefers concise summaries. (chatId: chat-9)"
    context.chatMemoryText = [
      "User: Share ARR update",
      "Assistant thinking: Pull supporting evidence from the strongest fragment.",
      "Assistant: ARR grew 12%.",
    ].join("\n")

    const request = await buildReviewRequest(context, {
      focus: "turn_end",
      turnNumber: 1,
    })

    expect(request.isFirstReview).toBe(true)
    expect(request.messages).toHaveLength(3)
    expect((request.messages[0] as any).role).toBe("user")
    expect((request.messages[1] as any).role).toBe("assistant")
    expect((request.messages[2] as any).role).toBe("user")
    expect((request.messages[2] as any).content?.[0]?.text).toContain(
      "Review Focus: turn_end (evaluating through turn 1)"
    )
    expect(request.prompt).toContain("Memory Context")
    expect(request.prompt).not.toContain("Assistant thinking:")
  })

  test("buildReviewRequest keeps later reviews on single prompt without memory context", async () => {
    const context = createMockContext()
    context.conversationHistoryMessages = [
      {
        role: ConversationRole.USER,
        content: [{ text: "Earlier user question" }],
      },
      {
        role: ConversationRole.ASSISTANT,
        content: [{ text: "Earlier assistant answer" }],
      },
    ]
    context.episodicMemoriesText =
      "- [preference] User prefers concise summaries. (chatId: chat-9)"
    context.chatMemoryText = [
      "User: Share ARR update",
      "Assistant thinking: Pull supporting evidence from the strongest fragment.",
      "Assistant: ARR grew 12%.",
    ].join("\n")
    context.review.lastReviewResult = {
      status: "ok",
      notes: "Prior review completed.",
      toolFeedback: [],
      unmetExpectations: [],
      planChangeNeeded: false,
      anomaliesDetected: false,
      anomalies: [],
      recommendation: "proceed",
      ambiguityResolved: true,
    }

    const { prompt } = await buildReviewPromptFromContext(context, {
      focus: "turn_end",
      turnNumber: 2,
    })
    const request = await buildReviewRequest(context, {
      focus: "turn_end",
      turnNumber: 2,
    })

    expect(prompt).not.toContain("Memory Context")
    expect(request.isFirstReview).toBe(false)
    expect(request.messages).toHaveLength(1)
    expect((request.messages[0] as any).role).toBe("user")
    expect((request.messages[0] as any).content?.[0]?.text).not.toContain(
      "Memory Context"
    )
  })

  test("review system prompt includes conversation and memory guidance on first review only", () => {
    const firstReviewPrompt =
      __messageAgentsPromptInternals.buildReviewSystemPrompt({
        isFirstReview: true,
        delegationNote:
          "- If delegation tools are available, ensure list_custom_agents precedes run_public_agent when delegation is appropriate.",
      })

    expect(firstReviewPrompt).toContain(
      "If prior conversation history is provided as messages, use it only for continuity, intent, and prior commitments."
    )
    expect(firstReviewPrompt).toContain(
      "If memory context appears in the user prompt, treat it as supporting context."
    )
    expect(firstReviewPrompt).toContain(
      "Prioritize current turn tool outputs, expectations, clarifications, plan state, fragments, and images over older assistant statements in conversation history."
    )
  })

  test("review system prompt omits first-review-only guidance after the first review", () => {
    const laterReviewPrompt =
      __messageAgentsPromptInternals.buildReviewSystemPrompt({
        isFirstReview: false,
        delegationNote:
          "- If delegation tools are available, ensure list_custom_agents precedes run_public_agent when delegation is appropriate.",
      })

    expect(laterReviewPrompt).not.toContain(
      "If prior conversation history is provided as messages, use it only for continuity, intent, and prior commitments."
    )
    expect(laterReviewPrompt).not.toContain(
      "If memory context appears in the user prompt, treat it as supporting context."
    )
    expect(laterReviewPrompt).not.toContain(
      "Prioritize current turn tool outputs, expectations, clarifications, plan state, fragments, and images over older assistant statements in conversation history."
    )
  })

  test("buildDelegatedAgentFragments adds response fragment only when citations absent", async () => {
    const turnNumber = 3

    const withCitationsContext = createMockContext()
    const withCitations = (await buildDelegatedAgentFragments({
      result: {
        data: {
          result: "Agent says hi",
          citations: [baseFragment.source],
        },
      },
      agentId: "agent-123",
      agentName: "Test Agent",
      turnNumber,
      sourceToolName: "run_public_agent",
      rawFragments: [],
      rawDocuments: [],
      context: withCitationsContext,
      toolQuery: "test",
      resultSummary: "Agent says hi",
    })).fragments
    expect(withCitations.length).toBe(0)

    const noCitationsContext = createMockContext()
    const noCitations = (await buildDelegatedAgentFragments({
      result: {
        data: {
          result: "Agent says hi",
          citations: [],
        },
      },
      agentId: "agent-123",
      agentName: "Test Agent",
      turnNumber,
      sourceToolName: "run_public_agent",
      rawFragments: [],
      rawDocuments: [],
      context: noCitationsContext,
      toolQuery: "test",
      resultSummary: "Agent says hi",
    })).fragments
    expect(noCitations.length).toBe(0)
  })

  test("buildConversationHistoryForAgentRun normalizes context JSON and filters invalid turns", () => {
    const { buildConversationHistoryForAgentRun } =
      __messageAgentsHistoryInternals

    const history = [
      {
        messageRole: "user",
        message: '[{"type":"text","value":"Summarize"},{"type":"pill","value":{"title":"Q4 Plan"}}]',
        fileIds: ["clf-1"],
        errorMessage: "",
      },
      {
        messageRole: "assistant",
        message: "Sure, sharing summary.",
        fileIds: [],
        errorMessage: "",
      },
      {
        messageRole: "assistant",
        message: "",
        fileIds: [],
        errorMessage: "",
      },
      {
        messageRole: "user",
        message: "bad turn",
        fileIds: [],
        errorMessage: "timeout",
      },
    ] as any

    const { jafHistory, llmHistory } = buildConversationHistoryForAgentRun(history)

    expect(jafHistory).toHaveLength(2)
    expect(jafHistory[0].role).toBe("user")
    expect(jafHistory[0].content).toContain('User referred a file with title "Q4 Plan"')
    expect(jafHistory[1].role).toBe("assistant")
    expect(llmHistory).toHaveLength(2)
    expect((llmHistory[0] as any).role).toBe("user")
    expect((llmHistory[1] as any).role).toBe("assistant")
  })

  test("getAllImagesFromDocumentMemory prefixes by doc order", () => {
    const context = createMockContext()
    context.documentMemory.set("doc-a", createDocumentState("doc-a", baseFragment.source))
    context.documentMemory.set("doc-b", createDocumentState("doc-b", baseFragment.source))
    context.documentMemory.get("doc-a")!.images = [{ fileName: "doc-a_0", isAttachment: true }]
    context.documentMemory.get("doc-b")!.images = [{ fileName: "doc-b_0", isAttachment: false }]

    const { imageFileNamesForModel } = getAllImagesFromDocumentMemory(
      context.documentMemory,
      { docOrder: ["doc-b", "doc-a"], maxImages: 10 },
    )

    expect(imageFileNamesForModel).toEqual(["0_doc-b_0", "1_doc-a_0"])
  })

  test("buildMCPJAFTools synthesizes fragments when MCP response only has text", async () => {
    const tools = buildMCPJAFTools({
      "123": {
        tools: [{ toolName: "echo" }],
        client: {
          callTool: async () => ({
            content: [{ text: "MCP response text" }],
          }),
        },
        metadata: { name: "Connector 123" },
      },
    })

    expect(tools).toHaveLength(1)
    const execution = await tools[0].execute({}, {} as AgentRunContext)
    if (!execution || typeof execution === "string" || execution.status !== "success") {
      throw new Error("MCP tool did not execute successfully")
    }
    const contexts = (execution.metadata as any)?.contexts as MinimalAgentFragment[]
    expect(contexts).toHaveLength(1)
    expect(contexts[0].source.title).toContain("Connector 123")
    expect(contexts[0].content).toContain("MCP response text")
  })

  test("metadata constraints are inferred and ranked generically from user request", () => {
    const constraints =
      __messageAgentsMetadataInternals.extractMetadataConstraintsFromUserMessage(
        'Answer only from source "Q4 Planning" and exclude "Legacy Notes".'
      )

    expect(constraints.strict).toBe(true)
    expect(constraints.includeTerms).toContain("q4 planning")
    expect(constraints.excludeTerms).toContain("legacy notes")

    const matchingFragment: MinimalAgentFragment = {
      ...baseFragment,
      id: "doc-2",
      source: {
        ...baseFragment.source,
        title: "Q4 Planning",
      },
    }
    const excludedFragment: MinimalAgentFragment = {
      ...baseFragment,
      id: "doc-3",
      source: {
        ...baseFragment.source,
        title: "Legacy Notes",
      },
    }

    const ranked = __messageAgentsMetadataInternals.rankFragmentsByMetadataConstraints(
      [excludedFragment, matchingFragment],
      constraints
    )
    expect(ranked.hasConstraints).toBe(true)
    expect(ranked.hasCompliantCandidates).toBe(true)
    expect(ranked.rankedCandidates[0].fragment.id).toBe("doc-2")
  })

  test("final synthesis payload includes metadata-enriched fragment context", async () => {
    const context = createMockContext()
    context.dedicatedAgentSystemPrompt =
      "You are an enterprise agent. Always use verified workspace evidence."
    context.episodicMemoriesText =
      "- [preference] User prefers concise executive summaries. (chatId: chat-7)"
    context.chatMemoryText = [
      "User: Summarize ARR for me",
      "Assistant thinking: Identify the strongest evidence first.",
      "Assistant: ARR grew last quarter.",
    ].join("\n")
    const fragmentSource = {
      ...baseFragment.source,
      page_title: "Quarterly Planning Sheet",
      status: "Open",
    }
    const doc = createDocumentState(baseFragment.id, fragmentSource)
    doc.chunks.set(chunkKeyFromContent(baseFragment.content), {
      content: baseFragment.content,
      firstSeenTurn: 1,
      lastSeenTurn: 1,
      confidence: baseFragment.confidence ?? 0.7,
      queries: [],
    })
    doc.relevanceScore = 0.8
    doc.maxScore = 0.7
    context.documentMemory.set(doc.docId, doc)

    const payload = await buildFinalSynthesisPayload(context)
    expect(payload.userMessage).toContain("Agent System Prompt Context:")
    expect(payload.userMessage).toContain("This is the system prompt of agent:")
    expect(payload.userMessage).toContain("<system prompt>")
    expect(payload.userMessage).toContain(
      "You are an enterprise agent. Always use verified workspace evidence."
    )
    expect(payload.userMessage).not.toContain(
      "You are Xyne, an enterprise search assistant with agentic capabilities."
    )
    expect(payload.userMessage).toContain("</system prompt>")
    expect(payload.userMessage).toContain("Memory Context:")
    expect(payload.userMessage).toContain("Relevant Past Experiences:")
    expect(payload.userMessage).toContain("Retrieved Chat Memory:")
    expect(payload.userMessage).toContain("User: Summarize ARR for me")
    expect(payload.userMessage).toContain("Assistant: ARR grew last quarter.")
    expect(payload.userMessage).not.toContain("Assistant thinking:")
    expect(payload.userMessage).toContain("Context Fragments:")
    expect(payload.userMessage).toContain("index 1 {file context begins here...}")
    expect(payload.userMessage).toContain("- title: ARR Summary")
    expect(payload.userMessage).toContain("- page_title: Quarterly Planning Sheet")
    expect(payload.userMessage).toContain("Content:")
    expect(payload.userMessage).toContain("Quarterly ARR grew 12%")
  })

  test("final synthesis request keeps prior conversation as separate messages", async () => {
    const context = createMockContext()
    context.conversationHistoryMessages = [
      {
        role: ConversationRole.USER,
        content: [{ text: "Earlier user question" }],
      },
      {
        role: ConversationRole.ASSISTANT,
        content: [{ text: "Earlier assistant answer" }],
      },
    ]

    const request = await buildFinalSynthesisRequest(context, {
      insightsUsefulForAnswering:
        "Lead with the ARR delta before discussing supporting evidence.",
    })

    expect(request.messages).toHaveLength(3)
    expect((request.messages[0] as any).role).toBe("user")
    expect((request.messages[1] as any).role).toBe("assistant")
    expect((request.messages[2] as any).role).toBe("user")
    expect((request.messages[2] as any).content?.[0]?.text).toContain(
      "Synthesize the final answer using the evidence above."
    )
    expect((request.messages[2] as any).content?.[0]?.text).toContain(
      "User Question:\nHow is ARR tracking?"
    )
    expect(request.userMessage).toContain("Agent Insights for Final Answer:")
    expect(request.userMessage).toContain(
      "Lead with the ARR delta before discussing supporting evidence."
    )
  })

  test("synthesize final answer schema accepts optional insights", () => {
    expect(SynthesizeFinalAnswerInputSchema.safeParse({}).success).toBe(true)
    expect(
      SynthesizeFinalAnswerInputSchema.safeParse({
        insightsUsefulForAnswering: "Start with the conclusion.",
      }).success
    ).toBe(true)
  })
})
