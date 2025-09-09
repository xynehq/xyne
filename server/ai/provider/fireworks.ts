import { type Message } from "@aws-sdk/client-bedrock-runtime"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders } from "@/ai/types"
import BaseProvider from "@/ai/provider/base"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
const Logger = getLogger(Subsystem.AI)

import type { ChatMessage, Fireworks, MessageRole } from "./fireworksClient"

export class FireworksProvider extends BaseProvider {
  constructor(client: Fireworks) {
    super(client, AIProviders.Fireworks)
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    try {
      const response = await (this.client as Fireworks).complete(
        [
          {
            role: "system",
            content: modelParams.systemPrompt,
          },
          ...messages.map((v) => ({
            content: v.content ? v.content[0].text! : "",
            role: v.role! as "user" | "assistant",
          })),
        ],
        {
          model: modelParams.modelId,
          temperature: modelParams.temperature,
          top_p: modelParams.topP,
          max_tokens: modelParams.maxTokens,
          stream: false,
          tools: params.tools
            ? params.tools.map((t) => ({
                type: 'function',
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters || { type: 'object', properties: {} },
                },
              }))
            : undefined,
          tool_choice: params.tools ? (params.tool_choice ?? 'auto') : undefined,
        },
      )

      const cost = 0 // Explicitly setting 0 as cost
      const fc = response.choices?.[0]?.message?.function_call
      const toolCalls = fc
        ? [
            {
              id: '',
              type: 'function' as const,
              function: { name: fc.name || '', arguments: fc.arguments || '{}' },
            },
          ]
        : []
      return {
        text: response.choices[0].message?.content || "",
        cost,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      }
    } catch (error) {
      throw new Error("Failed to get response from Fireworks")
    }
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    try {
      const messagesList: ChatMessage[] = [
        {
          role: "system" as MessageRole,
          content: modelParams.systemPrompt!,
        },
        ...messages.map((v) => ({
          content: v.content ? v.content[0].text! : "",
          role: (v.role || "user") as MessageRole,
        })),
      ]

      for await (const evt of (this.client as Fireworks).streamComplete(
        messagesList,
        {
          model: modelParams.modelId,
          temperature: modelParams.temperature,
          top_p: modelParams.topP,
          // max_tokens: modelParams.maxTokens,
          tools: params.tools
            ? params.tools.map((t) => ({
                type: 'function',
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters || { type: 'object', properties: {} },
                },
              }))
            : undefined,
          tool_choice: params.tools ? (params.tool_choice ?? 'auto') : undefined,
        },
      )) {
        if ((evt as any).type === 'tool_call') {
          const tc = evt as { type: 'tool_call'; name: string; arguments: string }
          yield {
            tool_calls: [
              {
                id: '',
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments || '{}' },
              },
            ],
          }
        } else if ((evt as any).type === 'text') {
          const t = evt as { type: 'text'; text: string }
          yield { text: t.text, cost: 0 }
        }
      }
    } catch (error) {
      Logger.error(error, "Error in converseStream of Together")
      throw error
    }
  }
}
