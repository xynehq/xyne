import { AIProviders, Models, type Cost } from "@/ai/types"
import { MODEL_CONFIGURATIONS } from "./modelConfig";
import { get } from "http";

const getActualModelName=(model:Models):string=>{
  return MODEL_CONFIGURATIONS[model]?.actualName || model;
}
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

  [Models.o3_Deep_Research]: {
    name: "o3 Deep Research",
    cost: {
      // TODO: get actual price
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
  [Models.o4_Mini_Deep_Research]: {
    name: "o4 Mini Deep Research",
    cost: {
      // TODO: get actual price
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
  // [getActualModelName(Models.Vertex_Claude_3_5_Sonnet)]: {
  //   name: "vertex-claude-3-5-sonnet",
  //   cost: {
  //     onDemand: {
  //       pricePerThousandInputTokens: 0.003,
  //       pricePerThousandOutputTokens: 0.015,
  //     },
  //   },
  // },
  // [getActualModelName(Models.Vertex_Claude_3_7_Sonnet)]: {
  //   name: "vertex-claude-3-7-sonnet",
  //   cost: {
  //     onDemand: {
  //       pricePerThousandInputTokens: 0.003,
  //       pricePerThousandOutputTokens: 0.015,
  //     },
  //   },
  // },
  [getActualModelName(Models.Vertex_Claude_Sonnet_4)]:{
    name:"vertex-claude-sonnet-4",
    cost:{
      onDemand:{
        pricePerThousandInputTokens: 0.003,
        pricePerThousandOutputTokens: 0.015,
      }
    }
  },
  [getActualModelName(Models.Vertex_Gemini_2_5_Flash)]:{
    name:"vertex-gemini-2-5-flash",
    cost:{
      onDemand:{
        pricePerThousandInputTokens: 0.0003,
        pricePerThousandOutputTokens: 0.0025,
      }
    }
  },
  [getActualModelName(Models.Vertex_Gemini_2_5_Pro)]:{
    name:"vertex-gemini-2-5-pro",
    cost:{
      onDemand:{
        pricePerThousandInputTokens:0.00125,
        pricePerThousandOutputTokens:0.01
      }
    }
  }

}

export const ModelToProviderMap: Record<Models, AIProviders> = {
  [Models.Llama_3_1_405B]: AIProviders.AwsBedrock,
  [Models.Llama_3_1_70B]: AIProviders.AwsBedrock,
  [Models.Llama_3_2_3B]: AIProviders.AwsBedrock,
  [Models.Llama_3_2_1B]: AIProviders.AwsBedrock,
  [Models.Llama_3_1_8B]: AIProviders.AwsBedrock,
  [Models.Gpt_4o]: AIProviders.OpenAI,
  [Models.Gpt_4o_mini]: AIProviders.OpenAI,
  [Models.Gpt_4]: AIProviders.OpenAI,
  [Models.o3_Deep_Research]: AIProviders.OpenAI,
  [Models.o4_Mini_Deep_Research]: AIProviders.OpenAI,
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
  [Models.Gemini_2_5_Flash]: AIProviders.GoogleAI,
  [Models.Gemini_2_0_Flash_Thinking]: AIProviders.GoogleAI,

  // Vertex AI Claude Models
  [Models.Vertex_Claude_Sonnet_4]: AIProviders.VertexAI,
  // [Models.Vertex_Claude_Opus_4_1]: AIProviders.VertexAI,
  // [Models.Vertex_Claude_Opus_4]: AIProviders.VertexAI,
  // [Models.Vertex_Claude_3_7_Sonnet]: AIProviders.VertexAI,
  // [Models.Vertex_Claude_3_5_Sonnet_V2]: AIProviders.VertexAI,
  // [Models.Vertex_Claude_3_5_Sonnet]: AIProviders.VertexAI,
  // [Models.Vertex_Claude_3_5_Haiku]: AIProviders.VertexAI,
  // [Models.Vertex_Claude_3_Opus]: AIProviders.VertexAI,
  // [Models.Vertex_Claude_3_Haiku]: AIProviders.VertexAI,

  // Vertex AI Mistral Models
  // [Models.Vertex_Mistral_Large_2411]: AIProviders.VertexAI,
  // [Models.Vertex_Mistral_Small_2503]: AIProviders.VertexAI,
  // [Models.Vertex_Codestral_2501]: AIProviders.VertexAI,

  // Vertex AI Llama Models
  // [Models.Vertex_Llama_4_Maverick_17b]: AIProviders.VertexAI,
  // [Models.Vertex_Llama_4_Scout_17b]: AIProviders.VertexAI,

  // Vertex AI Gemini Models
  // [Models.Vertex_Gemini_2_0_Flash_001]: AIProviders.VertexAI, // Flash 2.0
  // [Models.Vertex_Gemini_2_0_Flash_Lite_001]: AIProviders.VertexAI, // Flash Lite 2.0
  // [Models.Vertex_Gemini_2_0_Flash_Thinking_Exp_1219]: AIProviders.VertexAI,
  // [Models.Vertex_Gemini_2_0_Flash_Exp]: AIProviders.VertexAI,
  // [Models.Vertex_Gemini_2_5_Pro_Exp_03_25]: AIProviders.VertexAI,
  [Models.Vertex_Gemini_2_5_Pro]: AIProviders.VertexAI, // 2.5 Pro
  [Models.Vertex_Gemini_2_5_Flash]: AIProviders.VertexAI, // 2.5 Flash
  // [Models.Vertex_Gemini_2_5_Flash_Lite_Preview]: AIProviders.VertexAI,
  // [Models.Vertex_Gemini_2_0_Flash_Thinking_Exp_01_21]: AIProviders.VertexAI,
  // [Models.Vertex_Gemini_Exp_1206]: AIProviders.VertexAI,
  // [Models.Vertex_Gemini_1_5_Flash_002]: AIProviders.VertexAI,
  // [Models.Vertex_Gemini_1_5_Flash_Exp_0827]: AIProviders.VertexAI,
  // [Models.Vertex_Gemini_1_5_Flash_8b_Exp_0827]: AIProviders.VertexAI,
  // [Models.Vertex_Gemini_1_5_Pro_002]: AIProviders.VertexAI,
  // [Models.Vertex_Gemini_1_5_Pro_Exp_0827]: AIProviders.VertexAI,
}

export const isDeepResearchModel = (modelId: Models): boolean => {
  return (
    modelId === Models.o3_Deep_Research ||
    modelId === Models.o4_Mini_Deep_Research
  )
}
