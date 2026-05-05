import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { z } from "zod"
import type { AgentRunContext, ImageMemoryEntry } from "@/api/chat/agent-schemas"
import type { Message, RunState, TraceEvent } from "@juspay-xyne-jaf/jaf"

const tempImageRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "xyne-jaf-generic-provider-"),
)
const imageDocId = "doc-local"
const imageDir = path.join(tempImageRoot, imageDocId)
const envKeysToRestore = [
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
  "ENABLE_IMAGES",
  "IMAGE_DIR",
  "ENCRYPTION_KEY",
  "SERVICE_ACCOUNT_ENCRYPTION_KEY",
] as const
const originalEnv = Object.fromEntries(
  envKeysToRestore.map((key) => [key, process.env[key]]),
) as Record<(typeof envKeysToRestore)[number], string | undefined>

process.env.LITELLM_BASE_URL = "https://litellm.test/v1"
process.env.LITELLM_API_KEY = "test-litellm-key"
process.env.ENABLE_IMAGES = "true"
process.env.IMAGE_DIR = tempImageRoot
process.env.ENCRYPTION_KEY ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

const {
  createRunId,
  createTraceId,
  run,
} = await import("@juspay-xyne-jaf/jaf")
const { Models } = await import("@/ai/types")
const { makeXyneGenericJAFProvider } = await import(
  "@/api/chat/jaf-generic-provider"
)

const originalFetch = global.fetch
const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlH0c8AAAAASUVORK5CYII="

type FetchMock = ReturnType<typeof mock>
type MockedFetchCall = [
  RequestInfo | URL,
  RequestInit & {
    body?: string
  },
]

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const createBaseContext = (
  overrides: Partial<AgentRunContext> = {},
): AgentRunContext => {
  const baseContext: AgentRunContext = {
    imageMemory: new Map<string, ImageMemoryEntry>(),
    message: {
      text: "Hello",
      attachments: [],
      timestamp: new Date().toISOString(),
    },
    currentSubTask: null,
    userContext: "",
    conversationHistoryMessages: [],
    clarifications: [],
    ambiguityResolved: false,
    review: {
      lastReviewTurn: null,
      reviewFrequency: 1,
      lastReviewedFragmentIndex: 0,
      outstandingAnomalies: [],
      clarificationQuestions: [],
      lastReviewResult: null,
      lockedByFinalSynthesis: false,
      lockedAtTurn: null,
      cachedPlanSummary: undefined,
      cachedContextSummary: undefined,
    },
    currentTurnArtifacts: {
      expectations: [],
      toolOutputs: [],
      syntheticDocs: [],
      executionToolsCalled: 0,
      todoWriteCalled: false,
      turnStartedAt: Date.now(),
    },
    plan: null,
    toolCallHistory: [],
    documentMemory: new Map(),
    currentTurnDocumentMemory: new Map(),
    failedTools: new Map(),
    turnRankedCount: new Map(),
    turnNewChunksCount: new Map(),
    enabledTools: new Set<string>(),
    user: {
      email: "test@xyne.ai",
      workspaceId: "workspace-1",
      id: "user-1",
      numericId: 1,
    },
    chat: {
      externalId: "chat-1",
      metadata: {},
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
    delegationEnabled: true,
    retryCount: 0,
    maxRetries: 3,
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

  return {
    ...baseContext,
    ...overrides,
  }
}

const createState = (
  model: string,
  options: {
    context?: AgentRunContext
    messages?: Message[]
    turnCount?: number
  } = {},
): RunState<AgentRunContext> => ({
  runId: createRunId("run-test"),
  traceId: createTraceId("trace-test"),
  messages: options.messages ?? [{ role: "user", content: "Hello" }],
  currentAgentName: "TestAgent",
  context: options.context ?? createBaseContext(),
  turnCount: options.turnCount ?? 1,
})

const createAgent = (
  model: string,
  executeByTool: Record<string, (args: any) => Promise<string>> = {},
) =>
  ({
    name: "TestAgent",
    instructions: () => "Use tools when needed.",
    tools: [
      {
        schema: {
          name: "searchGlobal",
          description: "Search globally",
          parameters: z.object({ query: z.string(), limit: z.number().optional() }),
        },
        execute:
          executeByTool.searchGlobal ??
          (async (args: any) =>
            JSON.stringify({
              source: "search",
              matched: true,
              query: args.query,
            })),
      },
      {
        schema: {
          name: "buildRecommendation",
          description: "Build final recommendation payload",
          parameters: z.object({
            merchantId: z.string(),
            proceed: z.boolean(),
          }),
        },
        execute:
          executeByTool.buildRecommendation ??
          (async (args: any) =>
            JSON.stringify({
              merchantId: args.merchantId,
              proceed: args.proceed,
            })),
      },
    ],
    modelConfig: { name: model },
  }) as any

const getRequestBodies = (fetchMock: FetchMock) =>
  (((fetchMock.mock.calls as unknown) as MockedFetchCall[]).map(([, init]) =>
    JSON.parse(String(init?.body)),
  ))

beforeAll(() => {
  fs.mkdirSync(imageDir, { recursive: true })
  fs.writeFileSync(
    path.join(imageDir, "1.png"),
    Buffer.from(onePixelPngBase64, "base64"),
  )
})

afterEach(() => {
  global.fetch = originalFetch
})

afterAll(() => {
  for (const key of envKeysToRestore) {
    const originalValue = originalEnv[key]
    if (originalValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalValue
    }
  }
  fs.rmSync(tempImageRoot, { recursive: true, force: true })
})

describe("makeXyneGenericJAFProvider", () => {
  test("routes LiteLLM models through JAF generic provider with Xyne request options", async () => {
    const fetchMock = mock(async () =>
      jsonResponse({
        id: "chatcmpl-test",
        model: "glm-flash-experimental",
        choices: [{ message: { role: "assistant", content: "Done." } }],
      }),
    )
    global.fetch = fetchMock as unknown as typeof fetch
    const legacyProvider = {
      getCompletion: mock(async () => {
        throw new Error("legacy provider should not be called")
      }),
    }
    const provider = makeXyneGenericJAFProvider<any>({
      legacyProvider,
    })
    const context = createBaseContext()
    ;(context as any).advancedConfig = {
      run: {
        toolChoice: "required",
        parallelToolCalls: false,
      },
    }

    const result = await provider.getCompletion(
      createState(Models.GLM_FLASH, { context }),
      createAgent(Models.GLM_FLASH),
      {
        agentRegistry: new Map(),
        modelProvider: provider,
        modelOverride: Models.GLM_FLASH,
      },
    )

    expect(result.message?.content).toBe("Done.")
    expect(legacyProvider.getCompletion).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = ((fetchMock.mock.calls as unknown) as MockedFetchCall[])[0]
    expect(String(url)).toBe("https://litellm.test/v1/chat/completions")

    const [body] = getRequestBodies(fetchMock)
    expect(body.model).toBe("glm-flash-experimental")
    expect(body.tool_choice).toBe("required")
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.tools[0].function.parameters.properties.query).toEqual({
      type: "string",
    })
  })

  test("falls back to the legacy provider for non generic-compatible models", async () => {
    const fetchMock = mock(async () => {
      throw new Error("generic provider should not fetch")
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const legacyProvider = {
      getCompletion: mock(async () => ({
        message: { content: "legacy fallback" },
      })),
    }
    const provider = makeXyneGenericJAFProvider<any>({
      legacyProvider,
    })

    const result = await provider.getCompletion(
      createState(Models.Claude_3_5_Haiku),
      createAgent(Models.Claude_3_5_Haiku),
      {
        agentRegistry: new Map(),
        modelProvider: provider,
        modelOverride: Models.Claude_3_5_Haiku,
      },
    )

    expect(result.message?.content).toBe("legacy fallback")
    expect(legacyProvider.getCompletion).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("preserves seeded synthetic tool context and handles a multi-turn XML tool loop like message-agents", async () => {
    let fetchCall = 0
    const fetchMock = mock(async () => {
      fetchCall += 1
      if (fetchCall === 1) {
        return jsonResponse({
          id: "chatcmpl-turn-1",
          model: "glm-flash-experimental",
          choices: [
            {
              message: {
                role: "assistant",
                content: `Need retrieval and final decision.

</think>
<tool_call>
<function=searchGlobal>
<parameter=query>merchant_123 credential status</parameter>
<parameter=limit>2</parameter>
</function>
</tool_call>
<tool_call>
<function=buildRecommendation>
<parameter=merchantId>merchant_123</parameter>
<parameter=proceed>true</parameter>
</function>
</tool_call>`,
              },
            },
          ],
        })
      }

      return jsonResponse({
        id: "chatcmpl-turn-2",
        model: "glm-flash-experimental",
        choices: [
          {
            message: {
              role: "assistant",
              content: `Use the seeded memory and tool outputs.

</think>
merchant_123 can proceed to the subscription flow immediately.`,
            },
          },
        ],
      })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const executedCalls: Array<{ tool: string; args: unknown }> = []
    const agent = createAgent(Models.GLM_FLASH, {
      searchGlobal: async (args) => {
        executedCalls.push({ tool: "searchGlobal", args })
        return JSON.stringify({
          source: "search",
          merchantId: "merchant_123",
          matched: true,
        })
      },
      buildRecommendation: async (args) => {
        executedCalls.push({ tool: "buildRecommendation", args })
        return JSON.stringify({
          merchantId: args.merchantId,
          proceed: args.proceed,
        })
      },
    })
    const provider = makeXyneGenericJAFProvider<AgentRunContext>()
    const eventTypes: string[] = []
    const toolRequestBatchSizes: number[] = []
    const seededState = createState(Models.GLM_FLASH, {
      context: createBaseContext(),
      messages: [
        { role: "user", content: "Check whether merchant_123 can proceed." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_seed_memory",
              type: "function",
              function: {
                name: "getChatMemory",
                arguments: '{"source":"memory"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_seed_memory",
          content:
            '{"status":"executed","result":"{\\"summary\\":\\"Seeded memory context\\"}","tool_name":"getChatMemory","message":"Memory context prepared."}',
        },
      ],
    })

    const result = await run(seededState, {
      agentRegistry: new Map([[agent.name, agent]]),
      modelProvider: provider,
      modelOverride: Models.GLM_FLASH,
      maxTurns: 4,
      onEvent: (event: TraceEvent) => {
        eventTypes.push(event.type)
        if (event.type === "tool_requests") {
          toolRequestBatchSizes.push(event.data.toolCalls.length)
        }
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [firstBody, secondBody] = getRequestBodies(fetchMock)

    expect(firstBody.messages).toEqual([
      { role: "system", content: "Use tools when needed." },
      { role: "user", content: "Check whether merchant_123 can proceed." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_seed_memory",
            type: "function",
            function: {
              name: "getChatMemory",
              arguments: '{"source":"memory"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_seed_memory",
        content:
          '{"status":"executed","result":"{\\"summary\\":\\"Seeded memory context\\"}","tool_name":"getChatMemory","message":"Memory context prepared."}',
      },
    ])
    expect(firstBody.tool_choice).toBe("auto")

    expect(secondBody.messages.map((message: { role: string }) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "tool",
    ])
    expect(secondBody.messages[4].tool_calls).toHaveLength(2)
    expect(secondBody.tool_choice).toBe("auto")

    expect(executedCalls).toEqual([
      {
        tool: "searchGlobal",
        args: { query: "merchant_123 credential status", limit: 2 },
      },
      {
        tool: "buildRecommendation",
        args: { merchantId: "merchant_123", proceed: true },
      },
    ])
    expect(toolRequestBatchSizes).toEqual([2])
    expect(eventTypes).toContain("tool_requests")
    expect(eventTypes).toContain("tool_results_to_llm")
    expect(result.outcome.status).toBe("completed")
    if (result.outcome.status === "completed") {
      expect(result.outcome.output).toBe(
        "merchant_123 can proceed to the subscription flow immediately.",
      )
      expect(result.outcome.output).not.toContain("<tool_call>")
    }
  })

  test("injects image-memory parts into the last user message while preserving seeded context", async () => {
    const fetchMock = mock(async () =>
      jsonResponse({
        id: "chatcmpl-image",
        model: "glm-flash-experimental",
        choices: [{ message: { role: "assistant", content: "I can see the image." } }],
      }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const imageMemory = new Map<string, ImageMemoryEntry>([
      [
        `${imageDocId}_1`,
        {
          fileName: `${imageDocId}_1`,
          vespaImageScore: 0.91,
          isUserAttachment: true,
          docId: imageDocId,
          lastMergedTurn: 1,
        },
      ],
    ])
    const context = createBaseContext({ imageMemory })
    const state = createState(Models.GLM_FLASH, {
      context,
      messages: [
        { role: "user", content: "Summarize the attachment and prior context." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_attachment_context",
              type: "function",
              function: {
                name: "getAttachmentContent",
                arguments: '{"source":"user_attachment"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_attachment_context",
          content:
            '{"status":"executed","result":"{\\"summary\\":\\"Attachment context prepared.\\"}","tool_name":"getAttachmentContent","message":"Attachment context prepared."}',
        },
      ],
    })
    const provider = makeXyneGenericJAFProvider<AgentRunContext>()

    const result = await provider.getCompletion(state, createAgent(Models.GLM_FLASH), {
      agentRegistry: new Map(),
      modelProvider: provider,
      modelOverride: Models.GLM_FLASH,
    })

    expect(result.message?.content).toBe("I can see the image.")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [body] = getRequestBodies(fetchMock)
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Summarize the attachment and prior context." },
        {
          type: "text",
          text: `Image reference [0_1] from document ${imageDocId}.`,
        },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${onePixelPngBase64}`,
          },
        },
      ],
    })
    expect(body.messages[2].tool_calls[0].function.name).toBe("getAttachmentContent")
    expect(body.messages[3].tool_call_id).toBe("call_attachment_context")
  })

  test("cancels generic provider fetches with the run stop signal", async () => {
    const controller = new AbortController()
    const fetchMock = mock(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted by stop signal"))
          })
          controller.abort()
        }),
    )
    global.fetch = fetchMock as unknown as typeof fetch
    const provider = makeXyneGenericJAFProvider<any>()

    await expect(
      provider.getCompletion(
        createState(Models.GLM_FLASH, {
          context: createBaseContext({ stopController: controller }),
        }),
        createAgent(Models.GLM_FLASH),
        {
          agentRegistry: new Map(),
          modelProvider: provider,
          modelOverride: Models.GLM_FLASH,
        },
      ),
    ).rejects.toThrow("aborted by stop signal")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = (fetchMock.mock.calls as MockedFetchCall[])[0]
    expect(init?.signal?.aborted).toBe(true)
  })
})
