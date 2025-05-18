import type { SSEStreamingApi } from "hono/streaming"

// Map to store active streams: Key = "chatId", Value = SSEStreamingApi instance
export const activeStreams = new Map<string, SSEStreamingApi>()
