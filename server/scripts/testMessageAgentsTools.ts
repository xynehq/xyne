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
      metadata: { contexts: [] },
      data: { result: "Found 3 ARR updates." },
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
    async () => {}
  )

  console.log(
    "Tool history with expectations:",
    context.toolCallHistory.map((record: ToolExecutionRecord) => ({
      toolName: record.toolName,
      expectedResults: record.expectedResults,
      resultSummary: record.resultSummary,
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
    contextFragments: [],
    seenDocuments: new Set<string>(),
    totalLatency: 0,
    totalCost: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    availableAgents: [],
    usedAgents: [],
    enabledTools: new Set<string>(),
    failedTools: new Map(),
    retryCount: 0,
    maxRetries: 3,
    review: {
      lastReviewTurn: null,
      reviewFrequency: 5,
      lastReviewSummary: null,
    },
    decisions: [],
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
