import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import config from "@/config"
import { fetchModelConfigs } from "@/ai/fetchModels"
import { getModelConfiguration } from "@/ai/modelConfig"
import {
  getExternalModelConfigurations,
  resetExternalModelConfigurationsForTests,
} from "@/ai/modelCatalog"
import { AIProviders } from "@/ai/types"

const originalCatalogPath = process.env.LITELLM_MODEL_CONFIG_PATH
const originalFetch = global.fetch
const fetchPreconnect =
  typeof originalFetch?.preconnect === "function"
    ? originalFetch.preconnect.bind(originalFetch)
    : () => Promise.resolve()
const mutableConfig = config as typeof config & {
  modelList: string | undefined
  LiteLLMApiKey: string
  LiteLLMModelInfoUrl: string | undefined
}
const originalModelList = config.modelList
const originalLiteLLMApiKey = config.LiteLLMApiKey
const originalLiteLLMModelInfoUrl = config.LiteLLMModelInfoUrl

const writeCatalog = (contents: unknown) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyne-litellm-models-"))
  const file = path.join(dir, "litellm-models.json")
  fs.writeFileSync(
    file,
    typeof contents === "string" ? contents : JSON.stringify(contents),
  )
  return { dir, file }
}

const withPreconnect = (
  fn: (...args: Parameters<typeof fetch>) => Promise<Response>,
) => Object.assign(fn, { preconnect: fetchPreconnect }) as typeof fetch

afterEach(() => {
  if (originalCatalogPath === undefined) {
    delete process.env.LITELLM_MODEL_CONFIG_PATH
  } else {
    process.env.LITELLM_MODEL_CONFIG_PATH = originalCatalogPath
  }
  resetExternalModelConfigurationsForTests()
  global.fetch = originalFetch
  mutableConfig.modelList = originalModelList
  mutableConfig.LiteLLMApiKey = originalLiteLLMApiKey
  mutableConfig.LiteLLMModelInfoUrl = originalLiteLLMModelInfoUrl
})

describe("LiteLLM model catalog", () => {
  test("loads valid external LiteLLM model configs", () => {
    const { file } = writeCatalog([
      {
        id: "nemotron-cdac-120b",
        labelName: "Nemotron 120B",
        actualName: "nemotron-3-120b-a12b-bf16",
        provider: "LiteLLM",
        reasoning: true,
        websearch: false,
        deepResearch: false,
        description: "CDAC Airawat Nemotron model",
      },
    ])
    process.env.LITELLM_MODEL_CONFIG_PATH = file

    const configs = getExternalModelConfigurations()

    expect(configs["nemotron-cdac-120b"]).toEqual({
      actualName: "nemotron-3-120b-a12b-bf16",
      labelName: "Nemotron 120B",
      provider: AIProviders.LiteLLM,
      reasoning: true,
      websearch: false,
      deepResearch: false,
      description: "CDAC Airawat Nemotron model",
    })
  })

  test("falls back to no external models when env is unset", () => {
    delete process.env.LITELLM_MODEL_CONFIG_PATH

    expect(getExternalModelConfigurations()).toEqual({})
  })

  test("falls back to no external models when configured file is missing", () => {
    process.env.LITELLM_MODEL_CONFIG_PATH = path.join(
      os.tmpdir(),
      "missing-litellm-models.json",
    )

    expect(getExternalModelConfigurations()).toEqual({})
  })

  test("falls back to no external models for invalid JSON", () => {
    const { file } = writeCatalog("{")
    process.env.LITELLM_MODEL_CONFIG_PATH = file

    expect(getExternalModelConfigurations()).toEqual({})
  })

  test("merged model config resolves catalog id to provider actual name", () => {
    const { file } = writeCatalog([
      {
        id: "nemotron-cdac-120b",
        labelName: "Nemotron 120B",
        actualName: "nemotron-3-120b-a12b-bf16",
        provider: "LiteLLM",
        reasoning: true,
        websearch: false,
        deepResearch: false,
        description: "CDAC Airawat Nemotron model",
      },
    ])
    process.env.LITELLM_MODEL_CONFIG_PATH = file

    expect(getModelConfiguration("nemotron-cdac-120b")?.actualName).toBe(
      "nemotron-3-120b-a12b-bf16",
    )
  })

  test("LiteLLM model list uses catalog id and provider actual name", async () => {
    const { file } = writeCatalog([
      {
        id: "nemotron-cdac-120b",
        labelName: "Nemotron 120B",
        actualName: "nemotron-3-120b-a12b-bf16",
        provider: "LiteLLM",
        reasoning: true,
        websearch: false,
        deepResearch: false,
        description: "CDAC Airawat Nemotron model",
      },
    ])
    process.env.LITELLM_MODEL_CONFIG_PATH = file
    mutableConfig.modelList = "nemotron-cdac-120b"
    mutableConfig.LiteLLMApiKey = ""

    expect(await fetchModelConfigs()).toEqual([
      {
        id: "nemotron-cdac-120b",
        actualName: "nemotron-3-120b-a12b-bf16",
        labelName: "Nemotron 120B",
        provider: "LiteLLM",
        reasoning: true,
        websearch: false,
        deepResearch: false,
        description: "CDAC Airawat Nemotron model",
      },
    ])
  })

  test("model-info results and local JSON-only models are merged before allowlist filtering", async () => {
    const { file } = writeCatalog([
      {
        id: "nemotron-cdac-120b",
        labelName: "Nemotron 120B",
        actualName: "nemotron-3-120b-a12b-bf16",
        provider: "LiteLLM",
        reasoning: true,
        websearch: false,
        deepResearch: false,
        description: "CDAC Airawat Nemotron model",
      },
    ])
    process.env.LITELLM_MODEL_CONFIG_PATH = file
    mutableConfig.modelList = "api-hosted-model,nemotron-cdac-120b"
    mutableConfig.LiteLLMApiKey = "test-key"
    mutableConfig.LiteLLMModelInfoUrl = "https://litellm.example/model/info"
    global.fetch = withPreconnect(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                model_name: "api-hosted-model",
                litellm_params: {
                  model: "provider/api-hosted-model",
                },
                model_info: {
                  litellm_provider: "hosted_vllm",
                  reasoning: false,
                  websearch: true,
                  deep_research: false,
                  description: "Model from LiteLLM model-info",
                },
              },
            ],
          }),
        ),
      ))

    expect(await fetchModelConfigs()).toEqual([
      {
        id: "api-hosted-model",
        actualName: "provider/api-hosted-model",
        labelName: "api-hosted-model",
        provider: "LiteLLM",
        reasoning: false,
        websearch: true,
        deepResearch: false,
        description: "Model from LiteLLM model-info",
      },
      {
        id: "nemotron-cdac-120b",
        actualName: "nemotron-3-120b-a12b-bf16",
        labelName: "Nemotron 120B",
        provider: "LiteLLM",
        reasoning: true,
        websearch: false,
        deepResearch: false,
        description: "CDAC Airawat Nemotron model",
      },
    ])
  })
})
