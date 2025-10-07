import { Models, AIProviders, ModelDisplayNames } from "@/ai/types"
import config from "@/config"
import type { ModelConfiguration } from "@/shared/types"

export const MODEL_CONFIGURATIONS: Record<Models, ModelConfiguration> = {
  // AWS Bedrock - Claude Models
  [Models.Claude_3_5_Haiku]: {
    actualName: "anthropic.claude-3-5-haiku-20241022-v1:0",
    labelName: ModelDisplayNames.AWS_CLAUDE_3_5_HAIKU,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: false,
    description: "Designed for quick responses while ensuring solid reasoning.",
  },
  [Models.Claude_3_5_Sonnet]: {
    actualName: "anthropic.claude-3-5-sonnet-20240620-v1:0",
    labelName: ModelDisplayNames.AWS_CLAUDE_3_5_SONNET,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Designed for quick responses while ensuring solid reasoning.",
  },
  [Models.Claude_3_5_SonnetV2]: {
    actualName: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    labelName: ModelDisplayNames.AWS_CLAUDE_3_5_SONNET_V2,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Designed for quick responses while ensuring solid reasoning.",
  },
  [Models.Claude_3_7_Sonnet]: {
    actualName: "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    labelName: ModelDisplayNames.AWS_CLAUDE_3_7_SONNET,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description:
      "Advanced reasoning with enhanced performance and longer context.",
  },
  [Models.Claude_Opus_4]: {
    actualName: "us.anthropic.claude-opus-4-20250514-v1:0",
    labelName: ModelDisplayNames.AWS_CLAUDE_OPUS_4,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Ideal for in-depth research and thorough analysis.",
  },
  [Models.Claude_Sonnet_4]: {
    actualName: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    labelName: ModelDisplayNames.AWS_CLAUDE_SONNET_4,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Balanced for reasoning, long context windows.",
  },

  // AWS Bedrock - Meta Llama Models
  [Models.Llama_3_1_405B]: {
    actualName: "meta.llama3-1-405b-instruct-v1:0",
    labelName: ModelDisplayNames.AWS_LLAMA_3_1_405B,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },
  [Models.Llama_3_1_70B]: {
    actualName: "meta.llama3-1-70b-instruct-v1:0",
    labelName: ModelDisplayNames.AWS_LLAMA_3_1_70B,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },
  [Models.Llama_3_1_8B]: {
    actualName: "meta.llama3-1-8b-instruct-v1:0",
    labelName: ModelDisplayNames.AWS_LLAMA_3_1_8B,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: false,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.Llama_3_2_1B]: {
    actualName: "us.meta.llama3-2-1b-instruct-v1:0",
    labelName: ModelDisplayNames.AWS_LLAMA_3_2_1B,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: false,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.Llama_3_2_3B]: {
    actualName: "us.meta.llama3-2-3b-instruct-v1:0",
    labelName: ModelDisplayNames.AWS_LLAMA_3_2_3B,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: false,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },

  // AWS Bedrock - Amazon Nova Models
  [Models.Amazon_Nova_Micro]: {
    actualName: "amazon.nova-micro-v1:0",
    labelName: ModelDisplayNames.AWS_AMAZON_NOVA_MICRO,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: false,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.Amazon_Nova_Lite]: {
    actualName: "amazon.nova-lite-v1:0",
    labelName: ModelDisplayNames.AWS_AMAZON_NOVA_LITE,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: false,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.Amazon_Nova_Pro]: {
    actualName: "amazon.nova-pro-v1:0",
    labelName: ModelDisplayNames.AWS_AMAZON_NOVA_PRO,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Proficient in reasoning across text, visuals, and programming.",
  },

  // AWS Bedrock - Cohere Models
  [Models.CohereCmdR]: {
    actualName: "cohere.command-r-v1:0",
    labelName: ModelDisplayNames.AWS_COHERE_CMD_R,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },
  [Models.CohereCmdRPlus]: {
    actualName: "cohere.command-r-plus-v1:0",
    labelName: ModelDisplayNames.AWS_COHERE_CMD_R_PLUS,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },

  // AWS Bedrock - Other Models
  [Models.DeepSeek_R1]: {
    actualName: "us.deepseek.r1-v1:0",
    labelName: ModelDisplayNames.AWS_DEEPSEEK_R1,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Advanced reasoning model with deep analysis capabilities.",
  },
  [Models.Mistral_Large]: {
    actualName: "mistral.mistral-large-2402-v1:0",
    labelName: ModelDisplayNames.AWS_MISTRAL_LARGE,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },

  // OpenAI Models
  [Models.Gpt_4o]: {
    actualName: "gpt-4o",
    labelName: ModelDisplayNames.OPENAI_GPT_4O,
    provider: AIProviders.OpenAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },
  [Models.Gpt_4o_mini]: {
    actualName: "gpt-4o-mini",
    labelName: ModelDisplayNames.OPENAI_GPT_4O_MINI,
    provider: AIProviders.OpenAI,
    reasoning: true,
    websearch: true,
    deepResearch: false,
    description:
      "Great for programming, content generation, and logical structuring.",
  },
  [Models.Gpt_4]: {
    actualName: "gpt-4",
    labelName: ModelDisplayNames.OPENAI_GPT_4,
    provider: AIProviders.OpenAI,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },
  [Models.o3_Deep_Research]: {
    actualName: "o3-deep-research",
    labelName: ModelDisplayNames.OPENAI_o3_DEEP_RESEARCH,
    provider: AIProviders.OpenAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Advanced research model with deep analysis capabilities.",
  },
  [Models.o4_Mini_Deep_Research]: {
    actualName: "o4-mini-deep-research",
    labelName: ModelDisplayNames.OPENAI_o4_MINI_DEEP_RESEARCH,
    provider: AIProviders.OpenAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Advanced research model with deep analysis capabilities.",
  },

  // Google AI Models
  [Models.Gemini_2_5_Flash]: {
    actualName: "gemini-2.5-flash",
    labelName: ModelDisplayNames.GOOGLEAI_GEMINI_2_5_FLASH,
    provider: AIProviders.GoogleAI,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.Gemini_2_0_Flash_Thinking]: {
    actualName: "gemini-2.0-flash-thinking-exp",
    labelName: ModelDisplayNames.GOOGLEAI_GEMINI_2_0_FLASH_THINKING,
    provider: AIProviders.GoogleAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description:
      "Proficient in reasoning across text, visuals, and programming.",
  },

  // Vertex AI Claude Models
  // Vertex AI Claude Models
  [Models.Vertex_Claude_Sonnet_4]: {
    actualName: "claude-sonnet-4@20250514",
    labelName: ModelDisplayNames.VERTEX_CLAUDE_SONNET_4,
    provider: AIProviders.VertexAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Balanced for reasoning, long context windows.",
  },
  // [Models.Vertex_Claude_Opus_4_1]: {
  //   actualName: "claude-opus-4-1@20250805",
  //   labelName: ModelDisplayNames.VERTEX_CLAUDE_OPUS_4_1,
  //   provider: AIProviders.VertexAI,
  //   reasoning: true,
  //   websearch: true,
  //   deepResearch: true,
  // },
  // [Models.Vertex_Claude_Opus_4]: {
  //   actualName: "claude-opus-4@20250514",
  //   labelName: ModelDisplayNames.VERTEX_CLAUDE_OPUS_4,
  //   provider: AIProviders.VertexAI,
  //   reasoning: true,
  //   websearch: true,
  //   deepResearch: true,
  // },
  // [Models.Vertex_Claude_3_7_Sonnet]: {
  //   actualName: "claude-3-7-sonnet@20250219",
  //   labelName: ModelDisplayNames.VERTEX_CLAUDE_3_7_SONNET,
  //   provider: AIProviders.VertexAI,
  //   reasoning: true,
  //   websearch: true,
  //   deepResearch: true,
  //   description:
  //     "Advanced reasoning with enhanced performance and longer context.",
  // },
  // [Models.Vertex_Claude_3_5_Sonnet_V2]: {
  //   actualName: "claude-3-5-sonnet-v2@20241022",
  //   labelName: ModelDisplayNames.VERTEX_CLAUDE_3_5_SONNET_V2,
  //   provider: AIProviders.VertexAI,
  //   reasoning: true,
  //   websearch: true,
  //   deepResearch: true,
  // },
  // [Models.Vertex_Claude_3_5_Sonnet]: {
  //   actualName: "claude-3-5-sonnet-v2@20241022",
  //   labelName: ModelDisplayNames.VERTEX_CLAUDE_3_5_SONNET,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: true,
  //   description: "Designed for quick responses while ensuring solid reasoning.",
  // },
  // [Models.Vertex_Claude_3_5_Haiku]: {
  //   actualName: "claude-3-5-haiku@20241022",
  //   labelName: ModelDisplayNames.VERTEX_CLAUDE_3_5_HAIKU,
  //   provider: AIProviders.VertexAI,
  //   reasoning: true,
  //   websearch: true,
  //   deepResearch: false, // Haiku is lighter, less suitable for deep research
  // },
  // [Models.Vertex_Claude_3_Opus]: {
  //   actualName: "claude-3-opus@20240229",
  //   labelName: ModelDisplayNames.VERTEX_CLAUDE_3_OPUS,
  //   provider: AIProviders.VertexAI,
  //   reasoning: true,
  //   websearch: true,
  //   deepResearch: true,
  // },
  // [Models.Vertex_Claude_3_Haiku]: {
  //   actualName: "claude-3-haiku@20240307",
  //   labelName: ModelDisplayNames.VERTEX_CLAUDE_3_HAIKU,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: false, // Haiku is lighter, less suitable for deep research
  // },

  // Vertex AI Mistral Models
  // [Models.Vertex_Mistral_Large_2411]: {
  //   actualName: "mistral-large-2411",
  //   labelName: ModelDisplayNames.VERTEX_MISTRAL_LARGE_2411,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: true, // Large model suitable for comprehensive research
  // },
  // [Models.Vertex_Mistral_Small_2503]: {
  //   actualName: "mistral-small-2503",
  //   labelName: ModelDisplayNames.VERTEX_MISTRAL_SMALL_2503,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: false, // Small model, limited research capabilities
  // },
  // [Models.Vertex_Codestral_2501]: {
  //   actualName: "codestral-2501",
  //   labelName: ModelDisplayNames.VERTEX_CODESTRAL_2501,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: false, // Code-focused model, not optimized for research
  // },

  // Vertex AI Llama Models
  // [Models.Vertex_Llama_4_Maverick_17b]: {
  //   actualName: "llama-4-maverick-17b-128e-instruct-maas",
  //   labelName: ModelDisplayNames.VERTEX_LLAMA_4_MAVERICK_17B,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: true, // 17B model with good capabilities for research
  // },
  // [Models.Vertex_Llama_4_Scout_17b]: {
  //   actualName: "llama-4-scout-17b-16e-instruct-maas",
  //   labelName: ModelDisplayNames.VERTEX_LLAMA_4_SCOUT_17B,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: true, // 17B model with good capabilities for research
  // },

  // Vertex AI Gemini Models
  // [Models.Vertex_Gemini_2_0_Flash_001]: {
  //   actualName: "gemini-2.0-flash-001",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_2_0_FLASH_001,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: true, // Advanced Gemini 2.0 model with good research capabilities
  // },
  // [Models.Vertex_Gemini_2_0_Flash_Lite_001]: {
  //   actualName: "gemini-2.0-flash-lite-001",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_2_0_FLASH_LITE_001,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: true, // Lite version with reduced capabilities
  // },
  // [Models.Vertex_Gemini_2_0_Flash_Thinking_Exp_1219]: {
  //   actualName: "gemini-2.0-flash-thinking-exp-1219",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_2_0_FLASH_THINKING_EXP_1219,
  //   provider: AIProviders.VertexAI,
  //   reasoning: true,
  //   websearch: true,
  //   deepResearch: true, // Thinking models excel at deep research
  // },
  // [Models.Vertex_Gemini_2_0_Flash_Exp]: {
  //   actualName: "gemini-2.0-flash-exp",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_2_0_FLASH_EXP,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: true, // Experimental version with advanced capabilities
  // },
  // [Models.Vertex_Gemini_2_5_Pro_Exp_03_25]: {
  //   actualName: "gemini-2.5-pro-exp-03-25",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_2_5_PRO_EXP_03_25,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: true, // Pro experimental model with advanced research capabilities
  // },
  [Models.Vertex_Gemini_2_5_Pro]: {
    actualName: "gemini-2.5-pro",
    labelName: ModelDisplayNames.VERTEX_GEMINI_2_5_PRO,
    provider: AIProviders.VertexAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description:
      "Proficient in reasoning across text, visuals, and programming.",
  },
  [Models.Vertex_Gemini_2_5_Flash]: {
    actualName: "gemini-2.5-flash",
    labelName: ModelDisplayNames.VERTEX_GEMINI_2_5_FLASH,
    provider: AIProviders.VertexAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  // [Models.Vertex_Gemini_2_5_Flash_Lite_Preview]: {
  //   actualName: "gemini-2.5-flash-lite-preview-06-17",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_2_5_FLASH_LITE_PREVIEW,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: false, // Lite preview version with reduced capabilities
  // },
  // [Models.Vertex_Gemini_2_0_Flash_Thinking_Exp_01_21]: {
  //   actualName: "gemini-2.0-flash-thinking-exp-01-21",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_2_0_Flash_THINKING_EXP_01_21,
  //   provider: AIProviders.VertexAI,
  //   reasoning: true,
  //   websearch: true,
  //   deepResearch: true, // Thinking experimental model excels at deep research
  // },
  // [Models.Vertex_Gemini_Exp_1206]: {
  //   actualName: "gemini-exp-1206",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_EXP_1206,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: true, // Experimental model with advanced capabilities
  // },
  // [Models.Vertex_Gemini_1_5_Flash_002]: {
  //   actualName: "gemini-1.5-flash-002",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_1_5_FLASH_002,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: false, // Older 1.5 generation, less suitable for deep research
  // },
  // [Models.Vertex_Gemini_1_5_Flash_Exp_0827]: {
  //   actualName: "gemini-1.5-flash-exp-0827",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_1_5_FLASH_EXP_0827,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: false, // Older experimental version
  // },
  // [Models.Vertex_Gemini_1_5_Flash_8b_Exp_0827]: {
  //   actualName: "gemini-1.5-flash-8b-exp-0827",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_1_5_FLASH_8B_EXP_0827,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: false, // Smaller 8b version, limited research capabilities
  // },
  // [Models.Vertex_Gemini_1_5_Pro_002]: {
  //   actualName: "gemini-1.5-pro-002",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_1_5_PRO_002,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: true, // Pro model, good for research even if older generation
  // },
  // [Models.Vertex_Gemini_1_5_Pro_Exp_0827]: {
  //   actualName: "gemini-1.5-pro-exp-0827",
  //   labelName: ModelDisplayNames.VERTEX_GEMINI_1_5_PRO_EXP_0827,
  //   provider: AIProviders.VertexAI,
  //   reasoning: false,
  //   websearch: true,
  //   deepResearch: true, // Pro experimental, good research capabilities
  // },
}

// Model display name mappings - using the new enum-based approach
export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  // Build from ModelDisplayNames enum
  ...Object.fromEntries(
    Object.values(ModelDisplayNames)
      .map((displayName) => [
        // Find the corresponding actualName from MODEL_CONFIGURATIONS
        Object.values(MODEL_CONFIGURATIONS).find(
          (config) => config.labelName === displayName,
        )?.actualName || "",
        displayName,
      ])
      .filter(([key]) => key !== ""), // Remove empty keys
  ),
}

// Main function to get available models - moved from config.ts for centralization
export const getAvailableModels = (config: {
  AwsAccessKey?: string
  AwsSecretKey?: string
  OpenAIKey?: string
  OllamaModel?: string
  TogetherAIModel?: string
  TogetherApiKey?: string
  FireworksAIModel?: string
  FireworksApiKey?: string
  GeminiAIModel?: string
  GeminiApiKey?: string
  VertexAIModel?: string
  VertexProjectId?: string
  VertexRegion?: string
}) => {
  const availableModels: Array<{
    actualName: string
    labelName: string
    provider: string
    reasoning: boolean
    websearch: boolean
    deepResearch: boolean
    description: string
  }> = []

  // Priority (AWS > OpenAI > Ollama > Together > Fireworks > Gemini > Vertex)
  // Using if-else logic to ensure only ONE provider is active at a time
  if (config.AwsAccessKey && config.AwsSecretKey) {
    // Add only AWS Bedrock models
    Object.values(MODEL_CONFIGURATIONS)
      .filter((model) => model.provider === AIProviders.AwsBedrock)
      .forEach((model) => {
        availableModels.push({
          actualName: model.actualName ?? "",
          labelName: model.labelName,
          provider: "AWS Bedrock",
          reasoning: model.reasoning,
          websearch: model.websearch,
          deepResearch: model.deepResearch,
          description: model.description,
        })
      })
  } else if (config.OpenAIKey) {
    // Add only OpenAI models
    Object.values(MODEL_CONFIGURATIONS)
      .filter((model) => model.provider === AIProviders.OpenAI)
      .forEach((model) => {
        availableModels.push({
          actualName: model.actualName ?? "",
          labelName: model.labelName,
          provider: "OpenAI",
          reasoning: model.reasoning,
          websearch: model.websearch,
          deepResearch: model.deepResearch,
          description: model.description,
        })
      })
  } else if (config.OllamaModel) {
    // Add only Ollama model
    availableModels.push({
      actualName: config.OllamaModel,
      labelName: config.OllamaModel,
      provider: "Ollama",
      reasoning: false,
      websearch: true,
      deepResearch: false,
      description: "",
    })
  } else if (config.TogetherAIModel && config.TogetherApiKey) {
    // Add only Together AI model
    availableModels.push({
      actualName: config.TogetherAIModel,
      labelName: config.TogetherAIModel,
      provider: "Together AI",
      reasoning: false,
      websearch: true,
      deepResearch: false,
      description: "",
    })
  } else if (config.FireworksAIModel && config.FireworksApiKey) {
    // Add only Fireworks AI model
    availableModels.push({
      actualName: config.FireworksAIModel,
      labelName: config.FireworksAIModel,
      provider: "Fireworks AI",
      reasoning: false,
      websearch: true,
      deepResearch: false,
      description: "",
    })
  } else if (config.GeminiAIModel && config.GeminiApiKey) {
    // Add all Google AI models
    Object.values(MODEL_CONFIGURATIONS)
      .filter((model) => model.provider === AIProviders.GoogleAI)
      .forEach((model) => {
        availableModels.push({
          actualName: model.actualName ?? "",
          labelName: model.labelName,
          provider: "Google AI",
          reasoning: model.reasoning,
          websearch: model.websearch,
          deepResearch: model.deepResearch,
          description: model.description,
        })
      })
  } else if (config.VertexProjectId && config.VertexRegion) {
    // Add all Vertex AI models - no longer dependent on VERTEX_AI_MODEL being set
    Object.values(MODEL_CONFIGURATIONS)
      .filter((model) => model.provider === AIProviders.VertexAI)
      .forEach((model) => {
        availableModels.push({
          actualName: model.actualName ?? "",
          labelName: model.labelName,
          provider: "Vertex AI",
          reasoning: model.reasoning,
          websearch: model.websearch,
          deepResearch: model.deepResearch,
          description: model.description,
        })
      })
  }

  return availableModels
}

// Legacy function for backward compatibility (returns old format)
export const getAvailableModelsLegacy = (config: {
  AwsAccessKey?: string
  AwsSecretKey?: string
  OpenAIKey?: string
  OllamaModel?: string
  TogetherAIModel?: string
  TogetherApiKey?: string
  FireworksAIModel?: string
  FireworksApiKey?: string
  GeminiAIModel?: string
  GeminiApiKey?: string
  VertexAIModel?: string
  VertexProjectId?: string
  VertexRegion?: string
}) => {
  const newModels = getAvailableModels(config)
  return newModels.map(
    (model: {
      actualName: string
      labelName: string
      provider: string
      reasoning: boolean
      websearch: boolean
      deepResearch: boolean
    }) => ({
      label: model.labelName,
      provider: model.provider,
    }),
  )
}

// Function to determine the currently active provider based on configuration
export const getActiveProvider = (): AIProviders | null => {
  // Priority order: AWS > OpenAI > Ollama > Together > Fireworks > Gemini > Vertex
  if (config.AwsAccessKey && config.AwsSecretKey) {
    return AIProviders.AwsBedrock
  } else if (config.OpenAIKey) {
    return AIProviders.OpenAI
  } else if (config.OllamaModel) {
    return AIProviders.Ollama
  } else if (config.TogetherAIModel && config.TogetherApiKey) {
    return AIProviders.Together
  } else if (config.FireworksAIModel && config.FireworksApiKey) {
    return AIProviders.Fireworks
  } else if (config.GeminiAIModel && config.GeminiApiKey) {
    return AIProviders.GoogleAI
  } else if (config.VertexProjectId && config.VertexRegion) {
    return AIProviders.VertexAI
  }

  return null
}

// Function to convert friendly model label back to the correct provider-specific model enum
export const getModelValueFromLabel = (
  label: string,
): Models | string | null => {
  const activeProvider = getActiveProvider()

  if (!activeProvider) {
    return null
  }

  // First, try to find the model by matching labelName in MODEL_CONFIGURATIONS
  const modelEntry = Object.entries(MODEL_CONFIGURATIONS).find(
    ([modelKey, config]) => {
      const matches =
        config.labelName === label && config.provider === activeProvider
      return matches
    },
  )

  if (modelEntry) {
    return modelEntry[0] as Models
  } else {
  }

  // Handle special cases for dynamic models (Ollama, Together AI, etc.)
  switch (activeProvider) {
    case AIProviders.Ollama:
      if (config.OllamaModel && label === config.OllamaModel) {
        return config.OllamaModel
      }
      break
    case AIProviders.Together:
      if (config.TogetherAIModel && label === config.TogetherAIModel) {
        return config.TogetherAIModel
      }
      break
    case AIProviders.Fireworks:
      if (config.FireworksAIModel && label === config.FireworksAIModel) {
        return config.FireworksAIModel
      }
      break
    case AIProviders.GoogleAI:
      if (config.GeminiAIModel && label === config.GeminiAIModel) {
        return config.GeminiAIModel
      }
      break
    case AIProviders.VertexAI:
      if (config.VertexAIModel && label === config.VertexAIModel) {
        return config.VertexAIModel
      }
      break
  }

  return null
}


export const getActualNameFromEnum = (enumValue: string): string | null => {
  const modelConfig = MODEL_CONFIGURATIONS[enumValue as Models]
  return modelConfig?.actualName || null
}

// Legacy function to convert friendly model label back to actual model value (for backward compatibility)
export const getModelValueFromLabelLegacy = (
  label: string,
  config: {
    OllamaModel?: string
    TogetherAIModel?: string
    FireworksAIModel?: string
    GeminiAIModel?: string
    VertexAIModel?: string
  },
): string | null => {
  // Create reverse mapping from display names to actual model values
  const labelToValueMap: Record<string, string> = {}

  // Build the reverse mapping
  for (const [modelValue, displayName] of Object.entries(MODEL_DISPLAY_NAMES)) {
    labelToValueMap[displayName] = modelValue
  }

  // Check if the label exists in our mapping
  if (labelToValueMap[label]) {
    return labelToValueMap[label]
  }

  // For dynamic models (Ollama, Together AI, etc.) that might not be in MODEL_DISPLAY_NAMES
  // Check against configured model values directly
  if (
    config.OllamaModel &&
    (label === config.OllamaModel ||
      label === (MODEL_DISPLAY_NAMES[config.OllamaModel] || config.OllamaModel))
  ) {
    return config.OllamaModel
  }

  if (
    config.TogetherAIModel &&
    (label === config.TogetherAIModel ||
      label ===
        (MODEL_DISPLAY_NAMES[config.TogetherAIModel] || config.TogetherAIModel))
  ) {
    return config.TogetherAIModel
  }

  if (
    config.FireworksAIModel &&
    (label === config.FireworksAIModel ||
      label ===
        (MODEL_DISPLAY_NAMES[config.FireworksAIModel] ||
          config.FireworksAIModel))
  ) {
    return config.FireworksAIModel
  }

  if (
    config.GeminiAIModel &&
    (label === config.GeminiAIModel ||
      label ===
        (MODEL_DISPLAY_NAMES[config.GeminiAIModel] || config.GeminiAIModel))
  ) {
    return config.GeminiAIModel
  }

  if (
    config.VertexAIModel &&
    (label === config.VertexAIModel ||
      label ===
        (MODEL_DISPLAY_NAMES[config.VertexAIModel] || config.VertexAIModel))
  ) {
    return config.VertexAIModel
  }

  return null
}
