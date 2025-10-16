import type { Context } from "hono"
import { transcriptionService } from "@/services/transcription"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"

const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Api).child({ module: "transcription-ws" })

/**
 * WebSocket handler for receiving audio chunks from clients during calls
 */
export const createTranscriptionWebSocket = (c: Context) => {
  const callId = c.req.query("callId")
  const payload = c.get(JwtPayloadKey)

  if (!callId) {
    throw new Error("Missing callId parameter")
  }

  if (!payload || !payload.sub) {
    throw new Error("Authentication required")
  }

  const userEmail = payload.sub
  const userId = payload.userId || payload.sub
  const userName = payload.userName || payload.name || payload.sub || "Unknown"

  return {
    async onMessage(event: any, ws: any) {
      try {
        if (event.data instanceof ArrayBuffer) {
          const audioData = new Float32Array(event.data)

          if (audioData.length > 0) {
            await transcriptionService.addAudioChunk(
              callId,
              userId,
              userName,
              audioData,
            )
          }
        } else if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data)
            if (message.type === "ping") {
              ws.send(JSON.stringify({ type: "pong" }))
            }
          } catch (err) {
            // Ignore non-JSON messages
          }
        }
      } catch (error) {
        Logger.error(error, "Error processing audio chunk")
      }
    },

    onError(event: any, ws: any) {
      Logger.error(`WebSocket error for call ${callId}`)
    },
  }
}
