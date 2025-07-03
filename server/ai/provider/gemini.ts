import { GoogleGenerativeAI, type Content } from "@google/generative-ai"
import BaseProvider from "@/ai/provider/base"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import { type ModelParams, type ConverseResponse, AIProviders } from "../types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import path from "path"
import fs from "fs"
import os from "os"
const Logger = getLogger(Subsystem.AI)

function findImageByName(directory: string, imageName: string) {
  const files = fs.readdirSync(directory)
  const match = files.find((file) => path.parse(file).name === imageName)
  if (!match) {
    throw new Error(`Image "${imageName}" not found`)
  }
  return path.join(directory, match)
}

async function buildGeminiImageParts(
  imagePaths: string[],
): Promise<{ inlineData: { mimeType: string; data: string } }[]> {
  const baseDir = path.resolve(
    process.env.IMAGE_DIR || "downloads/xyne_images_db",
  )

  const imagePromises = imagePaths.map(async (imgPath) => {
    // Check if the file already has an extension, if not add .png
    const match = imgPath.match(/^(.+)_([0-9]+)$/)
    if (!match) {
      Logger.error(`Invalid image path: ${imgPath}`)
      throw new Error(`Invalid image path: ${imgPath}`)
    }

    // Validate that the docId doesn't contain path traversal characters
    const docId = match[1]
    if (docId.includes("..") || docId.includes("/") || docId.includes("\\")) {
      Logger.error(`Invalid docId containing path traversal: ${docId}`)
      throw new Error(`Invalid docId: ${docId}`)
    }

    const imageDir = path.join(baseDir, docId)
    const absolutePath = findImageByName(imageDir, match[2])

    // Ensure the resolved path is within baseDir
    const resolvedPath = path.resolve(imageDir)
    if (!resolvedPath.startsWith(baseDir)) {
      Logger.error(`Path traversal attempt detected: ${imageDir}`)
      throw new Error(`Invalid path: ${imageDir}`)
    }

    try {
      // Check if file exists before trying to read it
      await fs.promises.access(absolutePath, fs.constants.F_OK)
      const base64Data = await fs.promises.readFile(absolutePath, {
        encoding: "base64",
      })

      return {
        inlineData: {
          mimeType: "image/png",
          data: base64Data,
        },
      }
    } catch (error) {
      Logger.error(
        `Failed to read image file ${absolutePath}: ${error instanceof Error ? error.message : error}`,
      )
      throw error
    }
  })

  const results = await Promise.all(imagePromises)
  return results.filter(Boolean) // Remove any null/undefined entries
}

export class GeminiAIProvider extends BaseProvider {
  constructor(client: GoogleGenerativeAI) {
    super(client, AIProviders.GoogleAI)
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    try {
      const geminiModel = await (
        this.client as GoogleGenerativeAI
      ).getGenerativeModel({
        model: modelParams.modelId,
      })
      const response = await geminiModel
        .startChat({
          history: messages.map((v) => {
            const role = v.role! as "user" | "model" | "function" | "system" // Ensure role is typed correctly
            const part = v.content ? v.content[0].text! : "" // Ensure safe access with a default fallback

            return {
              role,
              parts: [{ text: part }], // Wrap text in an array of objects, assuming Part has a text field
            }
          }),
          systemInstruction: {
            role: "system",
            parts: [{ text: modelParams.systemPrompt }],
          },
          generationConfig: {
            maxOutputTokens: modelParams.maxTokens,
            temperature: modelParams.temperature,
            responseMimeType: "application/json",
          },
        })
        .sendMessage(messages[0].content ? messages[0].content[0].text! : "")
      const cost = 0
      return {
        text: response.response.text() || "",
        cost: cost,
      }
    } catch (err) {
      Logger.error("Converse Error : ", err)
      throw new Error(`Failed to get response from Gemini ${err}`)
    }
  }
  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)
    try {
      const geminiModel = await (
        this.client as GoogleGenerativeAI
      ).getGenerativeModel({
        model: modelParams.modelId,
      })

      // Build image parts if they exist
      const imageParts =
        params.imageFileNames && params.imageFileNames.length > 0
          ? await buildGeminiImageParts(params.imageFileNames)
          : []

      const chatComponent = geminiModel.startChat({
        history: messages.map((v) => ({
          role: v.role === "assistant" ? "model" : (v.role as "user" | "model"),
          parts: [{ text: v.content ? v.content[0].text! : "" }],
        })),
        systemInstruction: {
          role: "system",
          parts: [{ text: modelParams.systemPrompt }], // Wrap text in an array
        },
        generationConfig: {
          maxOutputTokens: modelParams.maxTokens,
          temperature: modelParams.temperature,
          responseMimeType: "application/json",
        },
      })

      const latestMessage =
        messages[messages.length - 1]?.content?.[0]?.text || ""
      const streamResponse = await chatComponent.sendMessageStream([
        { text: latestMessage },
        ...imageParts,
      ])

      for await (const chunk of streamResponse.stream) {
        const text = chunk.text()

        if (text) {
          yield {
            text: text,
            cost: 0,
          }
        }
      }
    } catch (error) {
      Logger.error("Streaming Error : ", error)
      throw new Error(`Failed to get response from Gemini: ${error}`)
    }
  }
}
