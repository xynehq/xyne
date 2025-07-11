import { AIProviders, Models, type Cost } from "./types"

export const modelDetailsMap: Record<
  string,
  { name: string; cost: { onDemand: Cost; batch?: Cost } }
> = {
  [Models.Llama_3_2_1B]: {
    name: "Llama 3.2 Instruct (1B)",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.0001,
        pricePerThousandOutputTokens: 0.0001,
      },
      batch: {
        pricePerThousandInputTokens: 0.00005,
        pricePerThousandOutputTokens: 0.00005,
      },
    },
  },
  [Models.Llama_3_2_3B]: {
    name: "Llama 3.2 Instruct (3B)",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00015,
        pricePerThousandOutputTokens: 0.00015,
      },
      batch: {
        pricePerThousandInputTokens: 0.000075,
        pricePerThousandOutputTokens: 0.000075,
      },
    },
  },
  [Models.Llama_3_1_8B]: {
    name: "Llama 3.1 Instruct (8B)",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00022,
        pricePerThousandOutputTokens: 0.00022,
      },
      batch: {
        pricePerThousandInputTokens: 0.00011,
        pricePerThousandOutputTokens: 0.00011,
      },
    },
  },
  [Models.Llama_3_1_70B]: {
    name: "Llama 3.1 Instruct (70B)",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00099,
        pricePerThousandOutputTokens: 0.00099,
      },
      batch: {
        pricePerThousandInputTokens: 0.0005,
        pricePerThousandOutputTokens: 0.0005,
      },
    },
  },
  [Models.Llama_3_1_405B]: {
    name: "Llama 3.1 Instruct (405B)",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00532,
        pricePerThousandOutputTokens: 0.016,
      },
      batch: {
        pricePerThousandInputTokens: 0.00266,
        pricePerThousandOutputTokens: 0.008,
      },
    },
  },
  [Models.Gpt_4o]: {
    name: "GPT-4o",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.0025,
        pricePerThousandOutputTokens: 0.01,
      },
      batch: {
        pricePerThousandInputTokens: 0.00125,
        pricePerThousandOutputTokens: 0.005,
      },
    },
  },
  [Models.Gpt_4o_mini]: {
    name: "GPT-4o Mini",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00015,
        pricePerThousandOutputTokens: 0.0006,
      },
      batch: {
        pricePerThousandInputTokens: 0.000075,
        pricePerThousandOutputTokens: 0.0003,
      },
    },
  },

  [Models.Gpt_4]: {
    name: "GPT-4",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.03,
        pricePerThousandOutputTokens: 0.06,
      },
      batch: {
        pricePerThousandInputTokens: 0.015,
        pricePerThousandOutputTokens: 0.03,
      },
    },
  },
  [Models.CohereCmdRPlus]: {
    name: "Command R+",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.0025,
        pricePerThousandOutputTokens: 0.01,
      },
    },
  },
  [Models.CohereCmdR]: {
    name: "Command R",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00015,
        pricePerThousandOutputTokens: 0.0006,
      },
    },
  },
  [Models.Claude_3_7_Sonnet]: {
    name: "Claude 3.7 Sonnet",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.003,
        pricePerThousandOutputTokens: 0.015,
      },
      batch: {
        pricePerThousandInputTokens: 0,
        pricePerThousandOutputTokens: 0,
      },
    },
  },
  [Models.Claude_3_5_SonnetV2]: {
    name: "Claude 3.5 Sonnet v2",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.003,
        pricePerThousandOutputTokens: 0.015,
      },
      batch: {
        pricePerThousandInputTokens: 0.0015,
        pricePerThousandOutputTokens: 0.0075,
      },
    },
  },
  [Models.Claude_3_5_Sonnet]: {
    name: "Claude 3.5 Sonnet",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.003,
        pricePerThousandOutputTokens: 0.015,
      },
      batch: {
        pricePerThousandInputTokens: 0.0015,
        pricePerThousandOutputTokens: 0.0075,
      },
    },
  },
  [Models.Claude_Opus_4]: {
    name: "Claude Opus 4",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.015,
        pricePerThousandOutputTokens: 0.075,
      },
    },
  },
  [Models.Claude_Sonnet_4]: {
    name: "Claude Sonnet 4",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.003,
        pricePerThousandOutputTokens: 0.015,
      },
    },
  },
  [Models.Claude_3_5_Haiku]: {
    name: "Claude 3.5 Haiku",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.001,
        pricePerThousandOutputTokens: 0.005,
      },
      batch: {
        pricePerThousandInputTokens: 0.0005,
        pricePerThousandOutputTokens: 0.0025,
      },
    },
  },
  [Models.DeepSeek_R1]: {
    name: "Deepseek R1 (v1:0)",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00135,
        pricePerThousandOutputTokens: 0.0054,
      },
    },
  },
  [Models.Amazon_Nova_Micro]: {
    name: "Amazon Nova Micro",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.000035,
        pricePerThousandOutputTokens: 0.00014,
      },
      batch: {
        pricePerThousandInputTokens: 0.0000175,
        pricePerThousandOutputTokens: 0.00007,
      },
    },
  },
  [Models.Amazon_Nova_Lite]: {
    name: "Amazon Nova Lite",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.00006,
        pricePerThousandOutputTokens: 0.00024,
      },
      batch: {
        pricePerThousandInputTokens: 0.00003,
        pricePerThousandOutputTokens: 0.00012,
      },
    },
  },
  [Models.Amazon_Nova_Pro]: {
    name: "Amazon Nova Pro",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.0008,
        pricePerThousandOutputTokens: 0.0032,
      },
      batch: {
        pricePerThousandInputTokens: 0.0004,
        pricePerThousandOutputTokens: 0.0016,
      },
    },
  },
  [Models.Mistral_Large]: {
    name: "Mistral Large (24.02)",
    cost: {
      onDemand: {
        pricePerThousandInputTokens: 0.004,
        pricePerThousandOutputTokens: 0.012,
      },
    },
  },
}

export const ModelToProviderMap: Record<Models, AIProviders> = {
  [Models.Claude_3_Haiku]: AIProviders.OpenAI,
  [Models.Claude_3_Opus]: AIProviders.OpenAI,
  [Models.GPT_4o]: AIProviders.OpenAI,
  [Models.GPT_4o_Mini]: AIProviders.OpenAI,
  [Models.GPT_4_1]: AIProviders.OpenAI,
  [Models.O1_Preview]: AIProviders.OpenAI,
  [Models.O1_Mini]: AIProviders.OpenAI,
  [Models.Azure_GPT_4o]: AIProviders.AzureOpenAI,
  [Models.Azure_GPT_4o_Mini]: AIProviders.AzureOpenAI,
  [Models.Azure_GPT_4_Turbo]: AIProviders.AzureOpenAI,
  [Models.Azure_GPT_35_Turbo]: AIProviders.AzureOpenAI,
  [Models.Gemini_2_5_Flash]: AIProviders.GoogleAI,
  [Models.Gemini_2_5_Flash_Preview]: AIProviders.GoogleAI,
  [Models.Gemini_2_5_Pro_Preview]: AIProviders.GoogleAI,
  [Models.Gemini_2_0_Flash_Exp]: AIProviders.GoogleAI,
  [Models.Gemini_1_5_Pro]: AIProviders.GoogleAI,
  [Models.Gemini_1_5_Flash]: AIProviders.GoogleAI,
  [Models.Vertex_Claude_Sonnet_4]: AIProviders.VertexAI,
  [Models.Vertex_Claude_3_5_Sonnet_V2]: AIProviders.VertexAI,
  [Models.Vertex_Claude_3_5_Sonnet]: AIProviders.VertexAI,
  [Models.Vertex_Claude_3_5_Haiku]: AIProviders.VertexAI,
  [Models.Vertex_Claude_3_Opus]: AIProviders.VertexAI,
  [Models.Vertex_Claude_3_Haiku]: AIProviders.VertexAI,
  [Models.Vertex_Gemini_2_0_Flash]: AIProviders.VertexAI,
  [Models.Vertex_Gemini_1_5_Pro]: AIProviders.VertexAI,
  [Models.Vertex_Gemini_1_5_Flash]: AIProviders.VertexAI,
  [Models.OpenRouter_Claude_3_5_Sonnet]: AIProviders.OpenRouter,
  [Models.OpenRouter_Claude_3_5_Haiku]: AIProviders.OpenRouter,
  [Models.OpenRouter_Claude_3_Opus]: AIProviders.OpenRouter,
  [Models.OpenRouter_GPT_4o]: AIProviders.OpenRouter,
  [Models.OpenRouter_GPT_4o_Mini]: AIProviders.OpenRouter,
  [Models.OpenRouter_O1_Preview]: AIProviders.OpenRouter,
  [Models.OpenRouter_O1_Mini]: AIProviders.OpenRouter,
  [Models.OpenRouter_Gemini_2_0_Flash]: AIProviders.OpenRouter,
  [Models.OpenRouter_Gemini_1_5_Pro]: AIProviders.OpenRouter,
  [Models.OpenRouter_Llama_3_1_405B]: AIProviders.OpenRouter,
  [Models.OpenRouter_Llama_3_1_70B]: AIProviders.OpenRouter,
  [Models.OpenRouter_Qwen_2_5_72B]: AIProviders.OpenRouter,
  [Models.OpenRouter_DeepSeek_V3]: AIProviders.OpenRouter,
  [Models.Llama_3_2_1B]: AIProviders.AwsBedrock,
  [Models.Llama_3_2_3B]: AIProviders.AwsBedrock,
  [Models.Llama_3_1_70B]: AIProviders.AwsBedrock,
  [Models.Llama_3_1_8B]: AIProviders.AwsBedrock,
  [Models.Llama_3_1_405B]: AIProviders.AwsBedrock,
  [Models.Gpt_4]: AIProviders.OpenAI,
  [Models.CohereCmdRPlus]: AIProviders.AwsBedrock,
  [Models.CohereCmdR]: AIProviders.AwsBedrock,
  [Models.Claude_3_5_SonnetV2]: AIProviders.AwsBedrock,
  [Models.Claude_3_7_Sonnet]: AIProviders.AwsBedrock,
  [Models.Claude_3_5_Sonnet]: AIProviders.AwsBedrock,
  [Models.Claude_3_5_Haiku]: AIProviders.AwsBedrock,
  [Models.Claude_Opus_4]: AIProviders.AwsBedrock,
  [Models.Claude_Sonnet_4]: AIProviders.AwsBedrock,
  [Models.Amazon_Nova_Micro]: AIProviders.AwsBedrock,
  [Models.Amazon_Nova_Lite]: AIProviders.AwsBedrock,
  [Models.Amazon_Nova_Pro]: AIProviders.AwsBedrock,
  [Models.Mistral_Large]: AIProviders.AwsBedrock,
  [Models.DeepSeek_R1]: AIProviders.AwsBedrock,
}
