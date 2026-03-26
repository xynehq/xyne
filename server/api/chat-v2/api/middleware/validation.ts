/**
 * Validation Middleware
 * 
 * Validates incoming chat request structure
 */

import type { Context, Next } from "hono"

export async function validationMiddleware(c: Context, next: Next) {
  try {
    const body = await c.req.json()

    // Validate required fields
    if (!body.message || typeof body.message !== "string") {
      return c.json(
        { error: "Bad Request", message: "message is required and must be a string" },
        400
      )
    }

    if (body.message.length > 10000) {
      return c.json(
        { error: "Bad Request", message: "message exceeds maximum length of 10000" },
        400
      )
    }

    // Validate optional fields
    if (body.attachments && !Array.isArray(body.attachments)) {
      return c.json(
        { error: "Bad Request", message: "attachments must be an array" },
        400
      )
    }

    if (body.modelConfig && typeof body.modelConfig !== "object") {
      return c.json(
        { error: "Bad Request", message: "modelConfig must be an object" },
        400
      )
    }

    await next()
  } catch (error) {
    return c.json(
      { error: "Bad Request", message: "Invalid JSON body" },
      400
    )
  }
}
