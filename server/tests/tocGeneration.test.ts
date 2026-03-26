import { describe, expect, mock, test } from "bun:test"

import {
  __tocGenerationInternals,
  enqueueTocGenerationJob,
} from "@/queue/toc-generation"

describe("enqueueTocGenerationJob", () => {
  test("uses a pg-boss-safe expiration below 24 hours", async () => {
    const send = mock(() => Promise.resolve("job-1"))
    const boss = {
      send,
    }

    const result = await enqueueTocGenerationJob(boss as any, {
      fileId: "file-1",
    })

    expect(result).toBe("job-1")
    expect(send).toHaveBeenCalledTimes(1)

    const [, , options] = send.mock.calls[0]!
    expect(options).toMatchObject({
      retryLimit: 2,
      retryDelay: 60,
      expireInSeconds: 43200,
    })
    expect(options).not.toHaveProperty("expireInHours")
  })

  test("clamps expiration to one day minus one second", () => {
    expect(__tocGenerationInternals.getTocQueueExpirationSeconds()).toBe(43200)
  })
})
