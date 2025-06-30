import fs from "fs"
import path from "path"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { v4 as uuidv4 } from "uuid"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "describeImageUtil",
})

async function callLLMWithPayload(payload: object): Promise<string> {
  const endpoint =
    process.env.LLM_API_ENDPOINT || "http://localhost:11434/api/generate"

  try {
    Logger.debug(`Calling LLM API at: ${endpoint}`)

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    if (!response.body) {
      throw new Error("No response body received from LLM API")
    }

    // Handle streaming response by reading the response body
    const responseText = await response.text()

    if (!responseText.trim()) {
      throw new Error("Empty response received from LLM API")
    }

    return responseText
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new Error(
        `Network error connecting to LLM API at ${endpoint}: ${error.message}`,
      )
    }

    if (error instanceof Error) {
      throw new Error(`LLM API request failed: ${error.message}`)
    }

    throw new Error(`Unknown error calling LLM API: ${String(error)}`)
  }
}

export const describeImageWithllm = async (
  image: Buffer,
  providedTempDir?: string,
  prompt?: string,
): Promise<string> => {
  try {
    const base64Image = image.toString("base64")

    const payload = {
      model: process.env.LLM_MODEL_NAME || "gemma3:12b",
      prompt:
        prompt ||
        "If the image contains a meaningful object, diagram, or visual content worth describing, provide only a concise and detailed description. Otherwise, if the image appears to be a logo, icon, background, watermark, or contains no significant content, respond exactly with: Image is not worth describing.",
      images: [base64Image],
      temperature: 0.2,
      num_predict: 512,
    }

    Logger.debug("Sending image description request to LLM API")
    const responseText = await callLLMWithPayload(payload)

    let fullResponse = ""
    const lines = responseText.trim().split("\n")

    for (const line of lines) {
      if (line.trim()) {
        try {
          const jsonObj = JSON.parse(line)
          if (jsonObj.response) {
            fullResponse += jsonObj.response
          }
          if (jsonObj.done) {
            break
          }
        } catch (parseError) {
          Logger.warn(`Failed to parse JSON line: ${line}`, parseError)
          // Continue processing other lines
        }
      }
    }

    const result = fullResponse.trim() || "No description returned."
    Logger.debug(`LLM API response: ${result.substring(0, 100)}...`)

    return result
  } catch (err) {
    Logger.error(err, "Error calling LLM API for image description")
    return "No description returned."
  }
}

// Utility function to create and cleanup temp directory
export const withTempDirectory = async <T>(
  callback: (tempDir: string) => Promise<T>,
): Promise<T> => {
  const tempDir = path.resolve(__dirname, "../../tmp", `session_${uuidv4()}`)

  try {
    // Create temp directory
    await fs.promises.mkdir(tempDir, { recursive: true })
    Logger.debug(`Created temp directory: ${tempDir}`)

    // Execute callback with temp directory
    return await callback(tempDir)
  } finally {
    // Clean up temp directory and all its contents
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true })
      Logger.debug(`Cleaned up temp directory: ${tempDir}`)
    } catch (cleanupError) {
      Logger.error(cleanupError, `Error cleaning up temp directory: ${tempDir}`)
    }
  }
}
