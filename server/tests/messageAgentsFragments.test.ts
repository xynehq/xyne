import { describe, expect, test } from "bun:test"
import type { AgentRunContext } from "@/api/chat/agent-schemas"
import {
  __messageAgentsHistoryInternals,
  __messageAgentsMetadataInternals,
  afterToolExecutionHook,
  beforeToolExecutionHook,
  buildDelegatedAgentFragments,
  buildFinalSynthesisPayload,
  buildReviewPromptFromContext,
} from "@/api/chat/message-agents"
import { getRecentImagesFromContext } from "@/api/chat/runContextUtils"
import { buildMCPJAFTools } from "@/api/chat/jaf-adapter"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { Apps } from "@xyne/vespa-ts/types"
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

const createMockContext = (): AgentRunContext => ({
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
  clarifications: [],
  ambiguityResolved: true,
  toolCallHistory: [],
  seenDocuments: new Set<string>(),
  allFragments: [],
  turnFragments: new Map(),
  allImages: [],
  imagesByTurn: new Map(),
  recentImages: [],
  currentTurnArtifacts: {
    fragments: [],
    unrankedFragmentsByTool: new Map(),
    expectations: [],
    toolOutputs: [],
    images: [],
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
  decisions: [],
  finalSynthesis: {
    requested: false,
    completed: false,
    suppressAssistantStreaming: false,
    streamedText: "",
    ackReceived: false,
  },
  stopRequested: false,
})

describe("message-agents context tracking", () => {
  test("afterToolExecutionHook stores fragments and images in context collections", async () => {
    const context = createMockContext()
    const imageRef = {
      fileName: "0_doc-1_0",
      addedAtTurn: 1,
      sourceFragmentId: baseFragment.id,
      sourceToolName: "searchGlobal",
      isUserAttachment: false,
    }
    const fragmentWithImage: MinimalAgentFragment = {
      ...baseFragment,
      images: [imageRef],
    }

    await afterToolExecutionHook(
      "searchGlobal",
      {
        status: "success",
        metadata: {
          contexts: [fragmentWithImage],
        },
        data: {
          result: "Found ARR updates.",
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
      new Set<string>(),
      undefined,
      context.turnCount
    )

    // With deferred ranking, afterToolExecutionHook stores fragments in
    // unrankedFragmentsByTool instead of allFragments. Key is "toolName:query".
    // Ranking + recording into allFragments happens at turn-end via batchRankFragments.
    const entry = context.currentTurnArtifacts.unrankedFragmentsByTool.get("searchGlobal:ARR")
    expect(entry?.fragments).toHaveLength(1)
    expect(entry?.query).toBe("ARR")
    expect(context.currentTurnArtifacts.executionToolsCalled).toBe(1)
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
      new Set<string>(),
      undefined,
      context.turnCount
    )

    // With deferred ranking, fragments are stored in unrankedFragmentsByTool; seenDocuments
    // is populated at turn-end when ranked fragments are recorded. So after the hook we only
    // have the entry in unrankedFragmentsByTool. Simulate turn-end having run so excludedIds
    // can be verified: add the docId to seenDocuments (as turn-end recording would).
    context.seenDocuments.add("doc-1")

    const preparedArgs = await beforeToolExecutionHook(
      "searchGlobal",
      {
        query: "ARR",
        excludedIds: [],
      },
      context
    )

    expect(preparedArgs.excludedIds).toEqual(["doc-1"])
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
      new Set<string>(),
      undefined,
      context.turnCount
    )

    expect(context.allFragments).toHaveLength(0)
    expect(context.currentTurnArtifacts.fragments).toHaveLength(0)
  }, 15000)

  test("buildReviewPromptFromContext includes plan, expectations, and image metadata", () => {
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
      fragments: [baseFragment],
    })
    context.currentTurnArtifacts.expectations.push({
      toolName: "searchGlobal",
      expectation: {
        goal: "Find ARR mentions",
        successCriteria: ["ARR keyword present"],
      },
    })
    context.currentTurnArtifacts.images.push({
      fileName: "0_doc-1_0",
      addedAtTurn: 1,
      sourceFragmentId: baseFragment.id,
      sourceToolName: "searchGlobal",
      isUserAttachment: true,
    })
    context.allImages.push(...context.currentTurnArtifacts.images)

    const { prompt, imageFileNames } = buildReviewPromptFromContext(context, {
      focus: "turn_end",
      turnNumber: 1,
    })

    expect(imageFileNames).toEqual(["0_doc-1_0"])
    expect(prompt).toContain("User Question")
    expect(prompt).toContain("Execution Plan Snapshot")
    expect(prompt).toContain("Recent Tool Activity")
    expect(prompt).toContain("Expectations")
    expect(prompt).toContain("Images")
    expect(prompt).toContain("Review Focus")
  })

  test("buildDelegatedAgentFragments synthesizes citation when no context provided", () => {
    const fragments = buildDelegatedAgentFragments({
      result: { data: { result: "Delegate says hello." } },
      gatheredFragmentsKeys: new Set(),
      agentId: "agent-123",
      agentName: "Delegate",
      sourceToolName: "run_public_agent",
      turnNumber: 3,
    })

    expect(fragments).toHaveLength(1)
    expect(fragments[0].source.app).toBe(Apps.Xyne)
    expect(fragments[0].content).toContain("Delegate")
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

  test("getRecentImagesFromContext prioritizes attachments and last two turns", () => {
    const context = createMockContext()
    context.currentTurnArtifacts.images.push({
      fileName: "current",
      addedAtTurn: 3,
      sourceFragmentId: "frag-current",
      sourceToolName: "searchGlobal",
      isUserAttachment: true,
    })
    context.recentImages = [
      {
        fileName: "turn2",
        addedAtTurn: 2,
        sourceFragmentId: "frag-2",
        sourceToolName: "searchDriveFiles",
        isUserAttachment: false,
      },
      {
        fileName: "turn1",
        addedAtTurn: 1,
        sourceFragmentId: "frag-1",
        sourceToolName: "searchGmail",
        isUserAttachment: false,
      },
    ]

    const selected = getRecentImagesFromContext(context)
    expect(selected[0]).toBe("current")
    expect(selected).toContain("turn2")
    expect(selected).not.toContain("duplicate")
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

  test("final synthesis payload includes metadata-enriched fragment context", () => {
    const context = createMockContext()
    context.dedicatedAgentSystemPrompt =
      "You are an enterprise agent. Always use verified workspace evidence."
    context.allFragments = [
      {
        ...baseFragment,
        source: {
          ...baseFragment.source,
          page_title: "Quarterly Planning Sheet",
          status: "Open",
        },
      },
    ]

    const payload = buildFinalSynthesisPayload(context)
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
    expect(payload.userMessage).toContain("Context Fragments:")
    expect(payload.userMessage).toContain("index 1 {file context begins here...}")
    expect(payload.userMessage).toContain("- title: ARR Summary")
    expect(payload.userMessage).toContain("- page_title: Quarterly Planning Sheet")
    expect(payload.userMessage).toContain("Content:")
    expect(payload.userMessage).toContain("Quarterly ARR grew 12%")
  })
})
