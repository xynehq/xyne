import { afterEach, describe, expect, test } from "bun:test"

import { Models } from "@/ai/types"

const originalTocModel = process.env.TOC_LLM_MODEL

async function loadConfigForTest() {
  const module = await import(
    `../config.ts?tocModelTest=${Date.now()}-${Math.random()}`
  )
  return module.default
}

afterEach(() => {
  if (originalTocModel === undefined) {
    delete process.env.TOC_LLM_MODEL
  } else {
    process.env.TOC_LLM_MODEL = originalTocModel
  }
})

describe("config tocLlmModel", () => {
  test("defaults to glm-flash-experimental when env is unset", async () => {
    delete process.env.TOC_LLM_MODEL

    const config = await loadConfigForTest()

    expect(config.tocLlmModel).toBe(Models.GLM_FLASH)
    expect(config.tocLlmModelRaw).toBe("")
  })

  test("accepts the requested glm-fast-experimental alias", async () => {
    process.env.TOC_LLM_MODEL = "glm-fast-experimental"

    const config = await loadConfigForTest()

    expect(config.tocLlmModel).toBe(Models.GLM_FLASH)
    expect(config.tocLlmModelRaw).toBe("glm-fast-experimental")
  })

  test("uses a valid explicit TOC model from env", async () => {
    process.env.TOC_LLM_MODEL = Models.Gpt_4o_mini

    const config = await loadConfigForTest()

    expect(config.tocLlmModel).toBe(Models.Gpt_4o_mini)
    expect(config.tocLlmModelRaw).toBe(Models.Gpt_4o_mini)
  })
})
