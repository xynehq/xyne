import pLimit from "p-limit"

const MAX_PARALLEL = parseInt(
  process.env.IMAGE_DESCRIBE_GLOBAL_CONCURRENCY || "5",
  10,
)

/**
 * Global limiter for image description LLM calls across the entire process.
 *
 * Problem: Each file processing batch creates its own pLimit(8), so with
 * multiple users/files we get 8×N parallel requests, exceeding the API limit.
 *
 * Solution: Single shared limiter ensures we never exceed the global limit
 * regardless of how many files are being processed concurrently.
 */
export const globalImageDescribeLimiter = pLimit(Math.max(1, MAX_PARALLEL))
