/**
 * Chat Handler
 *
 * HTTP handler for chat requests
 * Bridges Hono to ChatOrchestrator
 */

import type { Context } from "hono"
import type { ChatRequest } from "../../models"
import { getGlobalOrchestrator } from "../../core/orchestrator/orchestrator-factory"
import { toSSEEvent } from "../../shared/events"

export async function chatHandler(c: Context) {
  console.log("CHAT_handler")
  const startTime = Date.now()

  try {
    // Parse request body
    const body = await c.req.json<ChatRequest>()

    // Extract JWT payload (set by auth middleware)
    const jwtPayload = c.get("jwtPayload")

    // Get orchestrator
    const orchestrator = getGlobalOrchestrator()
    // Set up SSE stream
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Process request through orchestrator
          for await (const event of orchestrator.process(body, jwtPayload)) {
            // Convert to SSE format
            const sseEvent = toSSEEvent(event)

            // Send event
            controller.enqueue(
              new TextEncoder().encode(
                `event: ${sseEvent.event}\ndata: ${sseEvent.data}\n\n`,
              ),
            )

            // Stop if complete or error
            if (event.type === "complete" || event.type === "error") {
              controller.close()
              break
            }
          }
        } catch (error) {
          // Send error event
          const errorEvent = {
            event: "ERROR",
            data: JSON.stringify({
              error: {
                code: "STREAM_ERROR",
                message: error instanceof Error ? error.message : String(error),
                recoverable: false,
              },
            }),
          }

          controller.enqueue(
            new TextEncoder().encode(
              `event: ${errorEvent.event}\ndata: ${errorEvent.data}\n\n`,
            ),
          )
          controller.close()
        }
      },

      cancel() {
        // Handle client disconnect
        console.log("Client disconnected")
      },
    })

    // Return SSE response
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  } catch (error) {
    // Return JSON error for non-streaming errors
    return c.json(
      {
        error: {
          code: "REQUEST_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      400,
    )
  }
}
