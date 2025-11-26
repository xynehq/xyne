import { describe, expect, test } from "bun:test"
import type { AgentRunContext } from "@/api/chat/agent-schemas"
import {
  afterToolExecutionHook,
  buildDelegatedAgentFragments,
  buildReviewPromptFromContext,
} from "@/api/chat/message-agents"
import { getRecentImagesFromContext } from "@/api/chat/runContextUtils"
import { buildMCPJAFTools } from "@/api/chat/jaf-adapter"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { Apps } from "@xyne/vespa-ts/types"

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
    expectations: [],
    toolOutputs: [],
    images: [],
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
    lastReviewSummary: null,
    outstandingAnomalies: [],
    clarificationQuestions: [],
    lastReviewResult: null,
  },
  decisions: [],
  finalSynthesis: {
    requested: false,
    completed: false,
    suppressAssistantStreaming: false,
    streamedText: "",
    ackReceived: false,
  },
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
          runId: "run-1",
          traceId: "trace-1",
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
      undefined,
      context.turnCount
    )

    expect(context.allFragments).toHaveLength(1)
    expect(context.currentTurnArtifacts.fragments).toHaveLength(1)
    expect(context.turnFragments.get(1)).toHaveLength(1)
    expect(context.currentTurnArtifacts.images).toHaveLength(1)
    expect(context.currentTurnArtifacts.images[0].fileName).toBe(
      imageRef.fileName
    )
  })

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
    expect(prompt).toContain("Current Turn Tool Outputs")
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
    if (!execution || execution.status !== "success") {
      throw new Error("MCP tool did not execute successfully")
    }
    const contexts = (execution.metadata as any)?.contexts as MinimalAgentFragment[]
    expect(contexts).toHaveLength(1)
    expect(contexts[0].source.title).toContain("Connector 123")
    expect(contexts[0].content).toContain("MCP response text")
  })
})
