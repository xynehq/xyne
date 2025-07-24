import { WebClient } from "@slack/web-api"

export async function sendMessageWithRetry(
  client: WebClient,
  channel: string,
  text: string,
  options: {
    thread_ts?: string
    blocks?: any[]
  } = {},
) {
  const maxRetries = 3
  let retryCount = 0

  while (retryCount < maxRetries) {
    try {
      return await client.chat.postMessage({
        channel,
        text,
        ...options,
      })
    } catch (error: any) {
      retryCount++
      if (error.data?.retry_after) {
        await new Promise((r) => setTimeout(r, error.data.retry_after * 1000))
      } else {
        await new Promise((r) => setTimeout(r, 1000 * retryCount))
      }
    }
  }
  throw new Error("Failed to send message after multiple retries")
}

export function splitTextIntoChunks(
  text: string,
  maxChunkSize = 2900,
): string[] {
  const paragraphs = text.split("\n\n")
  const chunks: string[] = []
  let currentChunk = ""

  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length + 2 > maxChunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk)
      }
      currentChunk = paragraph
    } else {
      if (currentChunk) {
        currentChunk += "\n\n" + paragraph
      } else {
        currentChunk = paragraph
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk)
  }

  return chunks
}
