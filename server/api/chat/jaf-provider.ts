import { getProviderByModel } from "@/ai/provider"
import type { Message as ProviderMessage } from "@aws-sdk/client-bedrock-runtime"
import type { Agent as JAFAgent, ModelProvider as JAFModelProvider } from "@xynehq/jaf"
import { Models } from "@/ai/types"
import {
  resolveProviderType,
  jafToProviderMessages,
  zodSchemaToJsonSchema,
} from "./jaf-provider-utils"

export type MakeXyneJAFProviderOptions = {
  baseURL?: string
  apiKey?: string
}

export const makeXyneJAFProvider = <Ctx>(
  _opts: MakeXyneJAFProviderOptions = {},
): JAFModelProvider<Ctx> => {
  return {
    async getCompletion(state, agent, runCfg) {
      const model = runCfg.modelOverride ?? agent.modelConfig?.name
      if (!model) {
        throw new Error(`Model not specified for agent ${agent.name}`)
      }

      const provider = getProviderByModel(model as Models)
      const providerType = resolveProviderType(provider, model)
      const providerMessages: ProviderMessage[] = jafToProviderMessages(
        state.messages,
        providerType,
      )

      const tools = buildToolDefinitions(agent)
      const advRun = (state.context as { advancedConfig?: { run?: { parallelToolCalls: boolean; toolChoice: "auto" | "none" | "required" | undefined } } })?.advancedConfig?.run

      const providerOptions = {
        modelId: model as Models,
        stream: false,
        json: !!agent.outputCodec,
        temperature: agent.modelConfig?.temperature,
        max_new_tokens: agent.modelConfig?.maxTokens,
        systemPrompt: agent.instructions(state),
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? advRun?.toolChoice ?? "auto" : undefined,
        parallel_tool_calls: tools.length
          ? advRun?.parallelToolCalls ?? true
          : undefined,
      }

      const result = await provider.converse(providerMessages, providerOptions)

      const content = result.text || ""
      return {
        message: {
          content,
          ...(result.tool_calls && result.tool_calls.length
            ? { tool_calls: result.tool_calls }
            : {}),
        },
      }
    },
  }
}

type SchemaWithRawJson = {
  __xyne_raw_json_schema?: unknown
}

function buildToolDefinitions<Ctx, Out>(
  agent: Readonly<JAFAgent<Ctx, Out>>,
): Array<{
  name: string
  description: string
  parameters: unknown
}> {
  return (agent.tools || []).map((tool) => {
    const schemaParameters = tool.schema.parameters as SchemaWithRawJson
    const rawSchema = schemaParameters.__xyne_raw_json_schema

    return {
      name: tool.schema.name,
      description: tool.schema.description,
      parameters:
        rawSchema && typeof rawSchema === "object"
          ? rawSchema
          : zodSchemaToJsonSchema(tool.schema.parameters),
    }
  })
}
