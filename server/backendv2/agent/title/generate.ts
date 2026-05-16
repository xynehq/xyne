// Generates a short topical title for a conversation from the first user
// message. One-shot, non-streaming LiteLLM call — pi-mono is overkill here.
//
// Keep this lightweight: a few tokens, a small model, no session persistence.

import {
  getActualNameFromEnum,
  getModelConfiguration,
} from "@/ai/modelConfig"
import config from "@/config"

import { baseLogger, type Log } from "../log"

const Logger = baseLogger("backendv2/title")

const SYSTEM_PROMPT =
  "Generate a 3-6 word title for the following user message. " +
  "Output only the title — no quotes, no trailing punctuation, no emojis."

const sanitize = (raw: string): string => {
  let s = raw.trim()
  // Strip surrounding quotes the model occasionally adds despite the prompt.
  s = s.replace(/^["'`]+|["'`]+$/g, "").trim()
  // Drop trailing punctuation.
  s = s.replace(/[.!?:;]+$/u, "").trim()
  // Cap length so it fits cleanly in the topbar.
  if (s.length > 80) {
    s = `${s.slice(0, 77)}…`
  }
  return s
}

export async function generateTitle(
  text: string,
  logger: Log = Logger,
): Promise<string> {
  const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
    ? config.LiteLLMBaseUrl
    : `${config.LiteLLMBaseUrl ?? ""}/v1`
  const apiKey = config.LiteLLMApiKey ?? ""
  if (!baseUrl || !apiKey) {
    logger.warn("title: LiteLLM not configured; skipping")
    return ""
  }

  // Use defaultBestModel — same provider that ran the turn.
  const modelId = config.defaultBestModel
  const llmModelName = getActualNameFromEnum(modelId) ?? modelId
  const cfg = getModelConfiguration(modelId)
  if (!cfg) {
    logger.warn({ modelId }, "title: no model configuration; skipping")
    return ""
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: llmModelName,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        // Bigger budget — reasoning models consume some of the budget for
        // thinking before emitting any text.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        max_tokens: 512,
        temperature: 0.2,
        stream: false,
      }),
      // Bun's fetch defaults to a short idle timeout; reasoning models can
      // easily blow past 10s before emitting the title.
      signal: AbortSignal.timeout(60_000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      logger.warn(
        { status: res.status, body: text.slice(0, 300) },
        "title: LiteLLM rejected the request",
      )
      return ""
    }
    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null }
        // eslint-disable-next-line @typescript-eslint/naming-convention
        finish_reason?: string
      }>
    }
    const content = json.choices?.[0]?.message?.content ?? ""
    const finishReason = json.choices?.[0]?.finish_reason
    if (!content) {
      logger.warn(
        { finishReason, model: llmModelName },
        "title: model returned empty content",
      )
    }
    const cleaned = sanitize(content)
    return cleaned
  } catch (err) {
    logger.warn({ err }, "title: generation failed")
    return ""
  }
}
