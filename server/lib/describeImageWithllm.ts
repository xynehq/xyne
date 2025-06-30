import fs from "fs"
import path from "path"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { v4 as uuidv4 } from "uuid"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "describeImageUtil",
})

import { spawn } from "child_process"

function callLLMWithCurlFromFile(jsonFilePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const curlArgs = [
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      `@${jsonFilePath}`,
      process.env.LLM_API_ENDPOINT || "http://192.168.33.73:11434/api/generate",
    ]

    const child = spawn("curl", curlArgs)

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (data) => (stdout += data.toString()))
    child.stderr.on("data", (data) => (stderr += data.toString()))

    child.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`curl failed with code ${code}: ${stderr}`))
    })
  })
}

export const describeImageWithllm = async (
  image: Buffer,
  providedTempDir?: string,
): Promise<string> => {
  const tempDir = providedTempDir || path.resolve(__dirname, "../../tmp")
  let jsonPayloadPath

  try {
    // Only create temp directory if it doesn't exist and no external tempDir provided
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    const base64Image = image.toString("base64")

    const curlPayload = JSON.stringify({
      model: process.env.LLM_MODEL_NAME || "gemma3:12b",
      prompt:
        "If the image contains a meaningful object, diagram, or visual content worth describing, provide only a concise and detailed description. Otherwise, if the image appears to be a logo, icon, background, watermark, or contains no significant content, respond exactly with: Image is not worth describing.",
      images: [base64Image],
      temperature: 0.2,
      num_predict: 512,
    })

    jsonPayloadPath = path.join(tempDir, `${uuidv4()}.json`)
    fs.writeFileSync(jsonPayloadPath, curlPayload)

    const responseText = await callLLMWithCurlFromFile(jsonPayloadPath)

    let fullResponse = ""
    const lines = responseText.trim().split("\n")
    for (const line of lines) {
      if (line.trim()) {
        const jsonObj = JSON.parse(line)
        if (jsonObj.response) {
          fullResponse += jsonObj.response
        }
        if (jsonObj.done) {
          break
        }
      }
    }

    return fullResponse.trim() || "No description returned."
  } catch (err) {
    Logger.error(err, "Error calling Ollama API")
    return "No description returned."
  } finally {
    if (jsonPayloadPath && fs.existsSync(jsonPayloadPath)) {
      fs.unlinkSync(jsonPayloadPath)
    }
  }
}

// Utility function to create and cleanup temp directory
export const withTempDirectory = async <T>(
  callback: (tempDir: string) => Promise<T>,
): Promise<T> => {
  const tempDir = path.resolve(__dirname, "../../tmp", `session_${uuidv4()}`)

  try {
    // Create temp directory
    fs.mkdirSync(tempDir, { recursive: true })
    Logger.debug(`Created temp directory: ${tempDir}`)

    // Execute callback with temp directory
    return await callback(tempDir)
  } finally {
    // Clean up temp directory and all its contents
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
        Logger.debug(`Cleaned up temp directory: ${tempDir}`)
      }
    } catch (cleanupError) {
      Logger.error(cleanupError, `Error cleaning up temp directory: ${tempDir}`)
    }
  }
}