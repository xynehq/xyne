import { afterEach, describe, expect, mock, test } from "bun:test"
import { z } from "zod"

process.env.LITELLM_BASE_URL = "https://litellm.test/v1"
process.env.LITELLM_API_KEY = "test-litellm-key"
process.env.ENCRYPTION_KEY ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

const {
  createRunId,
  createTraceId,
  run,
} = await import("@xynehq/jaf")
const { Models } = await import("@/ai/types")
const { makeXyneGenericJAFProvider } = await import(
  "@/api/chat/jaf-generic-provider"
)

const originalFetch = global.fetch

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const createState = (model: string, context: Record<string, unknown> = {}) => ({
  runId: createRunId("run-test"),
  traceId: createTraceId("trace-test"),
  messages: [{ role: "user" as const, content: "Hello" }],
  currentAgentName: "TestAgent",
  context,
  turnCount: 0,
})

const createAgent = (
  model: string,
  execute: (args: unknown) => Promise<string> = async () => "tool result",
) => ({
  name: "TestAgent",
  instructions: () => "Use tools when needed.",
  tools: [
    {
      schema: {
        name: "searchGlobal",
        description: "Search globally",
        parameters: z.object({ query: z.string(), limit: z.number().optional() }),
      },
      execute,
    },
  ],
  modelConfig: { name: model },
}) as any

afterEach(() => {
  global.fetch = originalFetch
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
    const context = {
      advancedConfig: {
        run: {
          toolChoice: "required",
          parallelToolCalls: false,
        },
      },
    }

    const result = await provider.getCompletion(
      createState(Models.GLM_FLASH, context),
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
    const [url, init] = (fetchMock.mock.calls as any[])[0]
    expect(String(url)).toBe("https://litellm.test/v1/chat/completions")
    const body = JSON.parse(String(init?.body))
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

  test("runs a mocked XML tool-call loop without leaking tool markup", async () => {
    let fetchCall = 0
    const fetchMock = mock(async () => {
      fetchCall += 1
      if (fetchCall === 1) {
        return jsonResponse({
          id: "chatcmpl-tool",
          model: "glm-flash-experimental",
          choices: [
            {
              message: {
                role: "assistant",
                content: `Need search.

</think>
<tool_call>
<function=searchGlobal>
<parameter=query>platform credential</parameter>
<parameter=limit>1</parameter>
</function>
</tool_call>`,
              },
            },
          ],
        })
      }

      return jsonResponse({
        id: "chatcmpl-final",
        model: "glm-flash-experimental",
        choices: [
          {
            message: {
              role: "assistant",
              content: `Use tool result.

</think>
The credential exists, so subscription can proceed.`,
            },
          },
        ],
      })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const executedArgs: unknown[] = []
    const agent = createAgent(Models.GLM_FLASH, async (args: unknown) => {
      executedArgs.push(args)
      return JSON.stringify({ credentialGenerated: true })
    })
    const provider = makeXyneGenericJAFProvider<any>()

    const result = await run(createState(Models.GLM_FLASH), {
      agentRegistry: new Map([[agent.name, agent]]),
      modelProvider: provider,
      modelOverride: Models.GLM_FLASH,
      maxTurns: 4,
    })

    expect(executedArgs).toEqual([{ query: "platform credential", limit: 1 }])
    expect(result.outcome.status).toBe("completed")
    if (result.outcome.status === "completed") {
      expect(result.outcome.output).toBe(
        "The credential exists, so subscription can proceed.",
      )
      expect(result.outcome.output).not.toContain("<tool_call>")
    }
    const finalAssistantMessage = result.finalState.messages.at(-1)
    expect(finalAssistantMessage?.content).not.toContain("<tool_call>")
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
        createState(Models.GLM_FLASH, { stopController: controller }),
        createAgent(Models.GLM_FLASH),
        {
          agentRegistry: new Map(),
          modelProvider: provider,
          modelOverride: Models.GLM_FLASH,
        },
      ),
    ).rejects.toThrow("aborted by stop signal")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = (fetchMock.mock.calls as any[])[0]
    expect(init?.signal?.aborted).toBe(true)
  })
})
