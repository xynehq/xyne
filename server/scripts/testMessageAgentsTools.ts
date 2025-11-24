import {
  beforeToolExecutionHook,
  afterToolExecutionHook,
  extractExpectedResults,
} from "../api/chat/message-agents"
import type {
  AgentRunContext,
  ToolExecutionRecord,
} from "../api/chat/agent-schemas"

const sampleExpectedBlock = `
<expected_results>
[
  {
    "toolName": "searchGlobal",
    "goal": "find recent ARR updates",
    "successCriteria": ["documents mention ARR", "documents are Q4"],
    "failureSignals": ["no ARR keyword"],
    "stopCondition": "after 2 failed attempts"
  }
]
</expected_results>
`

async function simulateToolLifecycle() {
  const expectations = extractExpectedResults(sampleExpectedBlock)
  console.log("Parsed expected results:", expectations)

  const context = createMockContext()
  const toolArgs = { query: "Q4 ARR updates", limit: 5 }

  await beforeToolExecutionHook("searchGlobal", toolArgs, context)

  await afterToolExecutionHook(
    "searchGlobal",
    {
      status: "success",
      data: [
        {
          id: "doc1",
          content: "Found 3 ARR updates.",
          source: { docId: "doc1" } as any,
          confidence: 0.9,
        },
      ],
    },
    {
      toolCall: { id: "mock_call_1", name: "searchGlobal" } as any,
      args: toolArgs,
      state: { context },
      agentName: "xyne-agent",
      executionTime: 512,
      status: "success",
    },
    context.message.text,
    [],
    new Set<string>(),
    expectations[0]?.expectation,
    async (payload) => {
      console.log("Reasoning event:", payload)
    },
    1
  )

  console.log(
    "Tool history with expectations:",
    context.toolCallHistory.map((record: ToolExecutionRecord) => ({
      toolName: record.toolName,
      expectedResults: record.expectedResults,
      status: record.status,
    }))
  )
}

function createMockContext(): AgentRunContext {
  return {
    user: {
      email: "tester@xyne.dev",
      workspaceId: "workspace_123",
      id: "1",
    },
    chat: {
      externalId: "chat_mock",
      metadata: {},
    },
    message: {
      text: "How is ARR tracking for Q4?",
      attachments: [],
      timestamp: new Date().toISOString(),
    },
    plan: null,
    currentSubTask: null,
    userContext: "Mock user context",
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
    tokenUsage: {
      input: 0,
      output: 0,
    },
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
      lastReviewResult: null,
      outstandingAnomalies: [],
      clarificationQuestions: [],
    },
    decisions: [],
    finalSynthesis: {
      requested: false,
      completed: false,
      suppressAssistantStreaming: false,
      streamedText: "",
      ackReceived: false,
    },
  }
}

simulateToolLifecycle()
  .then(() => {
    console.log("Simulation complete.")
  })
  .catch((error) => {
    console.error("Simulation failed:", error)
    process.exitCode = 1
  })
