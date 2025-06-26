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

function buildGeminiImageParts(
  imagePaths: string[],
): { inlineData: { mimeType: string; data: string } }[] {
  const imageDir = path.resolve(
    os.homedir(),
    process.env.IMAGE_DIR || "Downloads/xyne_images_db",
  )
  return imagePaths
    .map((imgPath) => {
      // Check if the file already has an extension, if not add .png
      const fileName = path.extname(imgPath) ? imgPath : `${imgPath}.png`
      const absolutePath = path.join(imageDir, fileName)

      try {
        // Check if file exists before trying to read it
        if (!fs.existsSync(absolutePath)) {
          Logger.error(`Image file does not exist: ${absolutePath}`)
          throw new Error(`Image file not found: ${absolutePath}`)
        }

        const base64Data = fs.readFileSync(absolutePath, { encoding: "base64" })

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
    .filter(Boolean) // Remove any null/undefined entries
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
          ? buildGeminiImageParts(params.imageFileNames)
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