import { type Context } from "hono"
import { z } from "zod"
import { streamSSE } from "hono/streaming"
import { generatePromptFromRequirements } from "@/ai/provider"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import { getErrorMessage } from "@/utils"
import { ChatSSEvents } from "@/shared/types"
import type { Models } from "@/ai/types"

const loggerWithChild = getLoggerWithChild(Subsystem.AgentApi)
const { JwtPayloadKey } = config

// Schema for prompt generation request
export const generatePromptSchema = z.object({
  requirements: z.string().min(1, "Requirements are required"),
  modelId: z.string().optional(),
})

export type GeneratePromptPayload = z.infer<typeof generatePromptSchema>

export const GeneratePromptApi = async (c: Context) => {
  let email = ""
  try {
    const { sub, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
    email = sub

    // Get requirements from query parameters for EventSource compatibility
    const requirements = c.req.query("requirements")
    const modelId = c.req.query("modelId")

    if (!requirements) {
      throw new HTTPException(400, {
        message: "Requirements parameter is required",
      })
    }

    const validatedBody = { requirements, modelId }

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceExternalId,
      email,
    )
    if (
      !userAndWorkspace ||
      !userAndWorkspace.user ||
      !userAndWorkspace.workspace
    ) {
      throw new HTTPException(404, { message: "User or workspace not found" })
    }

    loggerWithChild({ email }).info("Starting prompt generation stream")

    return streamSSE(c, async (stream) => {
      try {
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            status: "generating",
          }),
        })

        const iterator = generatePromptFromRequirements(
          validatedBody.requirements,
          {
            modelId: modelId as Models,
            json: false,
            stream: true,
          },
        )

        let fullPrompt = ""
        for await (const chunk of iterator) {
          if (chunk.text) {
            fullPrompt += chunk.text
            await stream.writeSSE({
              event: ChatSSEvents.ResponseUpdate,
              data: chunk.text,
            })
          }
        }

        await stream.writeSSE({
          event: ChatSSEvents.End,
          data: JSON.stringify({
            fullPrompt,
            status: "completed",
          }),
        })

        loggerWithChild({ email }).info("Prompt generation completed")
      } catch (error) {
        const errMessage = getErrorMessage(error)
        loggerWithChild({ email }).error(error, "Error in prompt generation")

        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: JSON.stringify({
            error: errMessage,
          }),
        })
      }
    })
  } catch (error) {
    const errMessage = getErrorMessage(error)
    loggerWithChild({ email }).error(error, "Error in GeneratePromptApi")
    throw new HTTPException(500, { message: errMessage })
  }
}
