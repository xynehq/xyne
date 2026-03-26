/**
 * Streaming Handler
 * 
 * SSE streaming utilities and test endpoint
 */

import type { Context } from "hono"

/**
 * Test endpoint for SSE streaming
 * Useful for debugging connection issues
 */
export async function streamHandler(c: Context) {
  const stream = new ReadableStream({
    start(controller) {
      let count = 0
      const maxCount = 10

      const interval = setInterval(() => {
        count++
        
        // Send test event
        controller.enqueue(
          new TextEncoder().encode(
            `event: TEST\ndata: ${JSON.stringify({ count, timestamp: Date.now() })}\n\n`
          )
        )

        // End after maxCount
        if (count >= maxCount) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: COMPLETE\ndata: ${JSON.stringify({ done: true })}\n\n`
            )
          )
          clearInterval(interval)
          controller.close()
        }
      }, 500)

      // Clean up on cancel
      return () => {
        clearInterval(interval)
      }
    },

    cancel() {
      console.log("Stream cancelled by client")
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  })
}
