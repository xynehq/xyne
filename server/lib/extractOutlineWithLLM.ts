import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { VertexAI } from "@google-cloud/vertexai"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "extractOutlineWithllm",
})

export const extractOutlineWithllm = async (
  textContext: string,
): Promise<string | undefined> => {
  const prompt = `You are an expert document analyzer. Below is the extracted text from the beginning of a document. 
Please extract the Table of Contents or Document Outline. 
ONLY output a valid markdown list representing the outline. Do NOT add any conversational filler, intro, or concluding remarks.
IMPORTANT: If page numbers are visible in the text (e.g., "Page X of Y" markers or page numbers next to headings), include them in each outline entry using the format "- Chapter/Section Title (Page X)". 
If no outline is present, output "NO_OUTLINE".

--- DOCUMENT START ---
${textContext}
--- DOCUMENT END ---`

  // 1. Try LiteLLM/OpenAI via AI SDK
  const liteLlmBaseUrl =
    process.env.LITELLM_BASE_URL || process.env.OPENAI_API_BASE
  const liteLlmApiKey =
    process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY
  const liteLlmModel =
    process.env.LITELLM_FAST_MODEL ||
    process.env.LITELLM_BEST_MODEL ||
    "gpt-4o-mini"

  if (liteLlmBaseUrl && liteLlmApiKey) {
    try {
      Logger.debug(
        "Using raw LiteLLM/OpenAI compatible endpoint for outline extraction",
      )
      const endpoint = liteLlmBaseUrl.endsWith("/v1")
        ? liteLlmBaseUrl + "/chat/completions"
        : liteLlmBaseUrl + "/v1/chat/completions"
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${liteLlmApiKey}`,
        },
        body: JSON.stringify({
          model: liteLlmModel,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        }),
      })
      const data = await response.json()

      let text = data?.choices?.[0]?.message?.content

      // Fallback for custom schemas (like Nemotron output array)
      if (!text && data?.output && Array.isArray(data.output)) {
        const msg = data.output.find(
          (o: any) => o.type === "message" || o.role === "assistant",
        )
        if (msg && msg.content && Array.isArray(msg.content)) {
          const txtMsg = msg.content.find(
            (c: any) => c.type === "output_text" || c.text,
          )
          if (txtMsg) text = txtMsg.text
        }
      }

      if (text && !text.includes("NO_OUTLINE") && text.length > 10)
        return text.trim()
      return undefined
    } catch (err) {
      Logger.warn(err, "LiteLLM/OpenAIChat outline extraction failed")
    }
  }

  // 2. Fallback to Vertex AI if available
  const projectId =
    process.env.VERTEX_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT_ID
  if (projectId) {
    try {
      Logger.debug("Using Vertex AI for outline extraction")
      const location = process.env.VERTEX_REGION || "us-central1"
      const modelId =
        process.env.VERTEX_AI_MODEL_PDF_PROCESSING || "gemini-2.5-flash"
      const vertex = new VertexAI({ project: projectId, location })
      const model = vertex.getGenerativeModel({
        model: modelId,
        generationConfig: { maxOutputTokens: 2048, temperature: 0.1 },
      })
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      })
      const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text
      if (text && !text.includes("NO_OUTLINE") && text.length > 10)
        return text.trim()
      return undefined
    } catch (err) {
      Logger.warn(err, "Vertex AI outline extraction failed")
    }
  }

  // 3. Last fallback: Ollama local endpoint
  if (process.env.LLM_API_ENDPOINT) {
    try {
      Logger.debug("Using raw LLM_API_ENDPOINT for outline extraction")
      const response = await fetch(process.env.LLM_API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.LLM_MODEL_NAME || "gemma2",
          prompt,
          stream: false,
        }),
      })
      const data = await response.json()
      const text = data?.response || undefined
      if (text && !text.includes("NO_OUTLINE") && text.length > 10)
        return text.trim()
      return undefined
    } catch (err) {
      Logger.warn(err, "Raw LLM_API_ENDPOINT outline extraction failed")
    }
  }

  Logger.debug(
    "No LLM configured or all extractions failed for Document Outline fallback",
  )
  return undefined
}
