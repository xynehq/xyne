import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  __modelInfoInternals,
  getEffectiveMaxOutputTokens,
  getModelTokenLimits,
} from "@/ai/fetchModels"
import { Models } from "@/ai/types"

describe("fetchModels normalization", () => {
  beforeEach(() => {
    __modelInfoInternals.resetModelInfoCacheForTests()
  })

  afterEach(() => {
    __modelInfoInternals.resetModelInfoCacheForTests()
  })

  test("normalizes duplicate model records conservatively", () => {
    const normalized = __modelInfoInternals.normalizeModelInfoRecords([
      {
        model_name: "kimi-latest",
        litellm_params: { model: "hosted_vllm/kimi-k2-5-dev" },
        model_info: {
          max_input_tokens: 262_000,
          max_output_tokens: 16_000,
        },
      },
      {
        model_name: "kimi-latest",
        litellm_params: { model: "hosted_vllm/kimi-k2-5-dev" },
        model_info: {
          max_input_tokens: 200_000,
          max_output_tokens: 8_000,
        },
      },
    ])

    const metadata = normalized.get("kimi-latest")
    expect(metadata?.maxInputTokens).toBe(200_000)
    expect(metadata?.maxOutputTokens).toBe(8_000)
    expect(metadata?.hasConflictingMaxInputTokens).toBe(true)
    expect(metadata?.hasConflictingMaxOutputTokens).toBe(true)
  })

  test("ignores null token limits when another duplicate has values", () => {
    const normalized = __modelInfoInternals.normalizeModelInfoRecords([
      {
        model_name: "glm-latest",
        litellm_params: { model: "openai/zai-org/GLM-5-Dev" },
        model_info: {
          max_input_tokens: null,
          max_output_tokens: null,
        },
      },
      {
        model_name: "glm-latest",
        litellm_params: { model: "openai/zai-org/GLM-5-Dev" },
        model_info: {
          max_input_tokens: 128_000,
          max_output_tokens: 12_000,
        },
      },
    ])

    const metadata = normalized.get("glm-latest")
    expect(metadata?.maxInputTokens).toBe(128_000)
    expect(metadata?.maxOutputTokens).toBe(12_000)
    expect(metadata?.hasConflictingMaxInputTokens).toBe(false)
    expect(metadata?.hasConflictingMaxOutputTokens).toBe(false)
  })

  test("resolves model token limits by enum id and actual provider model name", () => {
    __modelInfoInternals.setModelInfoCacheForTests([
      {
        model_name: Models.GLM_LATEST,
        litellm_params: { model: "openai/zai-org/GLM-5-Dev" },
        model_info: {
          max_input_tokens: 128_000,
          max_output_tokens: 32_000,
        },
      },
    ])

    expect(getModelTokenLimits(Models.GLM_LATEST)).toEqual({
      maxInputTokens: 128_000,
      maxOutputTokens: 32_000,
    })
    expect(getModelTokenLimits("openai/zai-org/GLM-5-Dev")).toEqual({
      maxInputTokens: 128_000,
      maxOutputTokens: 32_000,
    })
  })

  test("falls back to generic input default and preserves requested output when upstream output max is absent", () => {
    __modelInfoInternals.setModelInfoCacheForTests([
      {
        model_name: Models.KIMI_LATEST,
        litellm_params: { model: "hosted_vllm/kimi-k2-5-dev" },
        model_info: {
          max_input_tokens: null,
          max_output_tokens: null,
        },
      },
    ])

    expect(getModelTokenLimits(Models.KIMI_LATEST)).toEqual({
      maxInputTokens: 128_000,
      maxOutputTokens: undefined,
    })
    expect(getEffectiveMaxOutputTokens(Models.KIMI_LATEST, 1_500)).toBe(1_500)
  })

  test("clamps requested output tokens to the upstream model maximum", () => {
    __modelInfoInternals.setModelInfoCacheForTests([
      {
        model_name: Models.Claude_Sonnet_4,
        litellm_params: { model: "us.anthropic.claude-sonnet-4-20250514-v1:0" },
        model_info: {
          max_input_tokens: 200_000,
          max_output_tokens: 4_096,
        },
      },
    ])

    expect(getEffectiveMaxOutputTokens(Models.Claude_Sonnet_4, 8_000)).toBe(4_096)
    expect(getEffectiveMaxOutputTokens(Models.Claude_Sonnet_4, 2_000)).toBe(2_000)
  })
})
