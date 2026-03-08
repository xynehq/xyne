import { describe, expect, test } from "bun:test"
import type { AgentRunContext } from "@/api/chat/agent-schemas"
import {
  __finalAnswerSynthesisInternals,
  buildFinalSynthesisPayload,
} from "@/api/chat/final-answer-synthesis"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { Models } from "@/ai/types"
import { Apps } from "@xyne/vespa-ts/types"

const baseFragment: MinimalAgentFragment = {
  id: "doc-1",
  content: "Quarterly ARR grew 12% and pipeline coverage improved.",
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
  modelId: Models.Gpt_4o,
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

describe("final-answer-synthesis", () => {
  test("builds deterministic fragment previews from raw fragment content", () => {
    const preview = __finalAnswerSynthesisInternals.buildFragmentPreviewRecord(
      {
        ...baseFragment,
        content:
          "  Quarterly ARR grew 12%   and pipeline coverage improved.\n\nCustomers expanded seats. ",
        source: {
          ...baseFragment.source,
          createdAt: "2026-03-08T09:00:00.000Z",
        },
      },
      7,
    )

    expect(preview.fragmentIndex).toBe(7)
    expect(preview.docId).toBe("doc-1")
    expect(preview.title).toBe("ARR Summary")
    expect(preview.app).toBe(String(Apps.KnowledgeBase))
    expect(preview.previewText).toBe(
      "Quarterly ARR grew 12% and pipeline coverage improved. Customers expanded seats.",
    )
    expect(preview.timestamp).toBe("2026-03-08T09:00:00.000Z")
  })

  test("section payload keeps shared context and adds section-only instructions", () => {
    const context = createMockContext()
    context.dedicatedAgentSystemPrompt =
      "You are an enterprise agent. Always use verified workspace evidence."
    context.allFragments = [baseFragment]

    const payload = __finalAnswerSynthesisInternals.buildSectionAnswerPayload(
      context,
      [
        {
          sectionId: 1,
          title: "Summary",
          objective: "Summarize the ARR status.",
        },
        {
          sectionId: 2,
          title: "Evidence",
          objective: "Provide supporting evidence.",
        },
      ],
      {
        sectionId: 2,
        title: "Evidence",
        objective: "Provide supporting evidence.",
      },
      [{ fragmentIndex: 3, fragment: baseFragment }],
      ["3_doc-1_0"],
    )

    expect(payload.systemPrompt).toContain("Deliver only the assigned answer section")
    expect(payload.userMessage).toContain(
      "All Planned Sections (generated in parallel; a final ordered answer will be assembled later):",
    )
    expect(payload.userMessage).toContain("Assigned Section:\n2. Evidence")
    expect(payload.userMessage).toContain("Write only this section.")
    expect(payload.userMessage).toContain("index 3 {file context begins here...}")
    expect(payload.userMessage).toContain("Agent System Prompt Context:")
    expect(payload.imageFileNames).toEqual(["3_doc-1_0"])
  })

  test("switches to sectional mode when full final payload exceeds the model input budget", () => {
    const context = createMockContext()
    context.modelId = Models.Gpt_4
    context.allFragments = [
      {
        ...baseFragment,
        content: "A".repeat(40_000),
      },
    ]

    const payload = buildFinalSynthesisPayload(context)
    expect(payload.userMessage.length).toBeGreaterThan(0)

    const decision = __finalAnswerSynthesisInternals.decideSynthesisMode(
      context,
      Models.Gpt_4,
      {
        selected: [],
        total: 0,
        dropped: [],
        userAttachmentCount: 0,
      },
    )

    expect(decision.mode).toBe("sectional")
    expect(decision.estimatedInputTokens).toBeGreaterThan(decision.safeInputBudget)
  })
})
