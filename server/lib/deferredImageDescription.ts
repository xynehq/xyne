import crypto from "crypto"
import { promises as fs } from "fs"
import path from "path"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import pLimit from "p-limit"
import { describeImageWithllm } from "./describeImageWithllm"

/** Stable content key for deduping image bytes across chunkers. */
export function md5ImageBuffer(buffer: Buffer): string {
  return crypto.createHash("md5").update(new Uint8Array(buffer)).digest("hex")
}

const Logger = getLogger(Subsystem.Integrations).child({
  module: "deferredImageDescription",
})

const DEFAULT_PLACEHOLDER = "This is an image."

function resolveConcurrency(explicit?: number): number {
  if (explicit != null && explicit > 0) return explicit
  const fromEnv = parseInt(
    process.env.IMAGE_DESCRIBE_CONCURRENCY ||
      "8",
    10,
  )
  return Math.max(1, Number.isFinite(fromEnv) ? fromEnv : 8)
}

function resolveTimeoutMs(explicit?: number): number {
  if (explicit != null && explicit > 0) return explicit
  const fromEnv = parseInt(
    process.env.IMAGE_DESCRIBE_TIMEOUT_MS || "120000",
    10,
  )
  return Math.max(1000, Number.isFinite(fromEnv) ? fromEnv : 120_000)
}

function resolveRetries(explicit?: number): number {
  if (explicit != null && explicit >= 0) return explicit
  const fromEnv = parseInt(process.env.IMAGE_DESCRIBE_RETRIES || "2", 10)
  return Math.max(0, Number.isFinite(fromEnv) ? fromEnv : 2)
}

function promiseWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (err) => {
        clearTimeout(t)
        reject(err)
      },
    )
  })
}

export type DescribeImageFn = (
  buffer: Buffer,
  imageName: string,
) => Promise<string>

export type DeferredImageDescriptionOptions = {
  /** Defaults to sharedImageDescriptionByHash */
  hashDescriptions?: Map<string, string>
  concurrency?: number
  /** Per LLM call; default from IMAGE_DESCRIBE_TIMEOUT_MS or 60s */
  describeTimeoutMs?: number
  /** Extra attempts after the first; default from IMAGE_DESCRIBE_RETRIES or 2 */
  describeRetries?: number
  describeImage?: DescribeImageFn
  /** While waiting for flush; default "This is an image." */
  placeholderText?: string
}

/**
 * Queue image paths during extraction (deduped by hash), then run parallel
 * single-image LLM calls and map results back onto image chunk arrays.
 * Use one instance per document / extraction pass.
 */
export class DeferredImageDescriptionBatch {
  private readonly hashDescriptions: Map<string, string>
  private readonly pendingPathByHash = new Map<string, string>()
  private readonly concurrency: number
  private readonly describeTimeoutMs: number
  private readonly describeRetries: number
  private readonly describeImage: DescribeImageFn
  private readonly placeholderText: string

  constructor(opts: DeferredImageDescriptionOptions = {}) {
    this.hashDescriptions = opts.hashDescriptions ?? new Map()
    this.concurrency = resolveConcurrency(opts.concurrency)
    this.describeTimeoutMs = resolveTimeoutMs(opts.describeTimeoutMs)
    this.describeRetries = resolveRetries(opts.describeRetries)
    this.describeImage = opts.describeImage ?? describeImageWithllm
    this.placeholderText = opts.placeholderText ?? DEFAULT_PLACEHOLDER
  }

  /**
   * Call after the image file exists on disk. Returns text to push to image_chunks now.
   * Queues at most one path per hash when describeEnabled.
   */
  registerImagePathForLaterDescribe(
    imageHash: string,
    absoluteImagePath: string,
    describeEnabled: boolean,
  ): string {
    const cached = this.hashDescriptions.get(imageHash)
    if (cached !== undefined) return cached
    if (!describeEnabled) return this.placeholderText
    if (!this.pendingPathByHash.has(imageHash)) {
      this.pendingPathByHash.set(imageHash, absoluteImagePath)
    }
    return this.placeholderText
  }

  private normalizeDescription(raw: string): string {
    if (raw == null) return this.placeholderText
    const s = raw.trim()
    if (
      !s ||
      s === "No description returned." ||
      s === "Image is not worth describing."
    ) {
      return this.placeholderText
    }
    return s
  }

  /**
   * Run queued describe calls (concurrency-limited). No-op if describeEnabled is false.
   */
  async flushDescribeQueue(describeEnabled: boolean): Promise<void> {
    if (!describeEnabled || this.pendingPathByHash.size === 0) return
    const limit = pLimit(this.concurrency)
    await Promise.all(
      [...this.pendingPathByHash.entries()].map(([hash, filePath]) =>
        limit(async () => {
          if (this.hashDescriptions.has(hash)) return
          let description = this.placeholderText
          try {
            const buf = await fs.readFile(filePath)
            let lastErr: unknown
            for (let attempt = 0; attempt <= this.describeRetries; attempt++) {
              try {
                description = await promiseWithTimeout(
                  this.describeImage(buf, path.basename(filePath)),
                  this.describeTimeoutMs,
                  `describeImage hash=${hash.slice(0, 8)}`,
                )
                lastErr = undefined
                break
              } catch (e) {
                lastErr = e
                if (attempt < this.describeRetries) {
                  Logger.warn(
                    `describeImage retry ${attempt + 1}/${this.describeRetries} for hash ${hash.slice(0, 8)}: ${e instanceof Error ? e.message : e}`,
                  )
                }
              }
            }
            if (lastErr != null) {
              throw lastErr
            }
          } catch (e) {
            Logger.warn(
              `describeImage failed (deferred) for hash ${hash.slice(0, 8)}: ${e instanceof Error ? e.message : e}`,
            )
            description = this.placeholderText
          }
          this.hashDescriptions.set(
            hash,
            this.normalizeDescription(description),
          )
        }),
      ),
    )
    this.pendingPathByHash.clear()
  }

  /**
   * Replace placeholder / pending entries in image_chunks using hashDescriptions +
   * chunkIndex → content hash (same chunk_index as image_chunk_pos entries).
   */
  applyResolvedDescriptions(
    image_chunks: string[],
    image_chunk_pos: number[],
    chunkIndexToImageHash: Map<number, string>,
  ): void {
    for (let i = 0; i < image_chunks.length; i++) {
      const seq = image_chunk_pos[i]
      const h = chunkIndexToImageHash.get(seq)
      if (h === undefined) continue
      const d = this.hashDescriptions.get(h)
      if (d !== undefined) image_chunks[i] = d
    }
  }
}
