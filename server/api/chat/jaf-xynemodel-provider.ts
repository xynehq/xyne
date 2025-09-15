import type {
  Agent as JAFAgent,
  Message as JAFMessage,
  ModelProvider as JAFModelProvider,
  RunConfig as JAFRunConfig,
  RunState as JAFRunState,
} from "@xynehq/jaf"
import { getTextContent } from "@xynehq/jaf"

import { type ModelParams, Models } from "@/ai/types"

import { generateToolSelectionOutput, getProviderByModel } from "@/ai/provider"
import { buildToolsOverview } from "@/api/chat/jaf-adapter"

// Map JAF messages to Xyne provider messages
// Xyne provider expects `Message[]` from Bedrock types: { role, content: [{ text }] }
import type { Message as XyneMessage } from "@aws-sdk/client-bedrock-runtime"

// Coerce a string model to a Xyne Models enum value if possible; otherwise fallback
function resolveXyneModelOrDefault(modelId: string, fallback: Models): Models {
  const all = Object.values(Models)
  // @ts-expect-error runtime check only
  if (all.includes(modelId)) return modelId as Models
  return fallback
}

function mapJAFToXyneMessages(history: readonly JAFMessage[]): XyneMessage[] {
  const mapped: XyneMessage[] = []
  for (const m of history) {
    const content = getTextContent(m.content)
    if (m.role === "user" || m.role === "assistant") {
      mapped.push({ role: m.role as any, content: [{ text: content }] })
    } else if (m.role === "tool") {
      // Xyne providers don't have a tool role; include tool output as assistant content
      // so the model can see the tool results in context.
      mapped.push({ role: "assistant" as any, content: [{ text: content }] })
    }
  }
  return mapped
}

export type MakeXyneJAFProviderOptions<Ctx> = {
  // Optional policy: decide if we should use tools for this turn
  shouldPlanTool?: (
    state: Readonly<JAFRunState<Ctx>>,
    agent: Readonly<JAFAgent<Ctx, any>>,
  ) => boolean
}

export function makeXyneJAFProvider<
  Ctx extends { userCtx?: string; agentPrompt?: string; userMessage?: string },
>(opts: MakeXyneJAFProviderOptions<Ctx> = {}): JAFModelProvider<Ctx> {
  return {
    async getCompletion(
      state: Readonly<JAFRunState<Ctx>>,
      agent: Readonly<JAFAgent<Ctx, any>>,
      config: Readonly<JAFRunConfig<Ctx>>,
    ) {
      const modelName = (config.modelOverride ?? agent.modelConfig?.name) || ""
      if (!modelName) {
        throw new Error(`Model not specified for agent ${agent.name}`)
      }

      const xyneModel = resolveXyneModelOrDefault(modelName, Models.Gpt_4o_mini)

      const lastMsg = state.messages[state.messages.length - 1]
      const hasTools = (agent.tools?.length || 0) > 0
      const shouldPlanTool =
        typeof opts.shouldPlanTool === "function"
          ? opts.shouldPlanTool(state, agent)
          : hasTools && lastMsg?.role === "user"

      // 1) Tool planning path: prompt-driven selection using Xyne’s tool selector
      if (shouldPlanTool) {
        try {
          const userQuery =
            getTextContent(lastMsg?.content || "") ||
            state.context?.userMessage ||
            ""
          const toolListStr = buildToolsOverview(
            agent.tools ? [...agent.tools] : [],
          )

          const params: ModelParams = {
            modelId: xyneModel,
            stream: false,
            json: true,
            userCtx: state.context?.userCtx,
            agentPrompt: state.context?.agentPrompt,
          }

          const selection = await generateToolSelectionOutput(
            userQuery,
            state.context?.userCtx || "",
            toolListStr,
            "",
            params,
            state.context?.agentPrompt,
          )

          if (
            selection?.tool &&
            agent.tools?.some((t) => t.schema.name === selection.tool)
          ) {
            // Return an OpenAI-compatible tool call response for JAF engine
            const callId = `xyne_tool_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
            return {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: callId,
                    type: "function" as const,
                    function: {
                      name: selection.tool,
                      arguments: JSON.stringify(selection.arguments || {}),
                    },
                  },
                ],
              },
            }
          }
        } catch (err) {
          // Fall through to direct answer
        }
      }

      // 2) Direct answer path: call Xyne provider with full conversation + agent instructions
      const messages: XyneMessage[] = mapJAFToXyneMessages(state.messages)
      const params: ModelParams = {
        modelId: xyneModel,
        stream: false,
        json: Boolean(agent.outputCodec),
        userCtx: state.context?.userCtx,
        agentPrompt: state.context?.agentPrompt,
      }

      // Use the agent’s instructions(state) as system prompt
      params.systemPrompt = agent.instructions(state)

      const provider = getProviderByModel(params.modelId)
      const { text } = await provider.converse(messages, params)

      return {
        message: {
          content: text ?? "",
        },
      }
    },
  }
}
