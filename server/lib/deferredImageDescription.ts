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
    process.env.IMAGE_DESCRIBE_CONCURRENCY || "8",
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

/**
 * Runs fn with an AbortSignal; on timeout aborts the signal so the underlying
 * request can cancel, then rejects with a timeout Error.
 */
function withAbortTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    const controller = new AbortController()
    return fn(controller.signal)
  }
  const controller = new AbortController()
  const { signal } = controller
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const t = setTimeout(() => {
      if (settled) return
      settled = true
      controller.abort()
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
    fn(signal).then(
      (v) => {
        if (settled) return
        settled = true
        clearTimeout(t)
        resolve(v)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(t)
        reject(err)
      },
    )
  })
}

/** LLM / pipeline signals: drop file and chunk rows (not indexed). */
function isRejectedImageDescription(raw: string): boolean {
  if (raw == null) return true
  const s = raw.trim()
  if (!s) return true
  return (
    s === "No description returned." ||
    s === "Image is not worth describing."
  )
}

export type DescribeImageFn = (
  buffer: Buffer,
  imageName: string,
  signal?: AbortSignal,
) => Promise<string>

export type DeferredImageDescriptionOptions = {
  hashDescriptions?: Map<string, string>
  concurrency?: number
  describeTimeoutMs?: number
  describeRetries?: number
  describeImage?: DescribeImageFn
  placeholderText?: string
}

/**
 * Queue image paths during extraction (deduped by hash), then run parallel
 * single-image LLM calls and map results back onto image chunk arrays.
 * Rejected descriptions drop files from disk and rows via stripRejectedImageRows.
 */
export class DeferredImageDescriptionBatch {
  private readonly hashDescriptions: Map<string, string>
  private readonly pendingPathByHash = new Map<string, string>()
  /** Every on-disk file for a hash (duplicate visuals → multiple paths). */
  private readonly savedPathsByHash = new Map<string, string[]>()
  private readonly rejectedHashes = new Set<string>()
  private readonly concurrency: number
  private readonly describeTimeoutMs: number
  private readonly describeRetries: number
  private readonly describeImage: DescribeImageFn
  private readonly placeholderText: string

  constructor(opts: DeferredImageDescriptionOptions = {}) {
    this.hashDescriptions = opts.hashDescriptions ?? new Map<string, string>()
    this.concurrency = resolveConcurrency(opts.concurrency)
    this.describeTimeoutMs = resolveTimeoutMs(opts.describeTimeoutMs)
    this.describeRetries = resolveRetries(opts.describeRetries)
    this.describeImage =
      opts.describeImage ??
      ((buffer, imageName, signal) =>
        describeImageWithllm(buffer, imageName, undefined, signal))
    this.placeholderText = opts.placeholderText ?? DEFAULT_PLACEHOLDER
  }

  private noteSavedPathForHash(imageHash: string, absoluteImagePath: string) {
    let list = this.savedPathsByHash.get(imageHash)
    if (!list) {
      list = []
      this.savedPathsByHash.set(imageHash, list)
    }
    if (!list.includes(absoluteImagePath)) list.push(absoluteImagePath)
  }

  private async deleteSavedFilesForHash(hash: string): Promise<void> {
    const paths = this.savedPathsByHash.get(hash)
    if (!paths?.length) return
    await Promise.all(
      paths.map((p) =>
        fs.unlink(p).catch((err) => {
          Logger.debug(
            `deferredImageDescription: unlink failed ${p}: ${err instanceof Error ? err.message : err}`,
          )
        }),
      ),
    )
  }

  /**
   * Call after the image file exists on disk. Returns text to push to image_chunks now.
   * Queues at most one path per hash when describeEnabled (for a single LLM call).
   */
  registerImagePathForLaterDescribe(
    imageHash: string,
    absoluteImagePath: string,
    describeEnabled: boolean,
  ): string {
    this.noteSavedPathForHash(imageHash, absoluteImagePath)

    const cached = this.hashDescriptions.get(imageHash)
    if (cached !== undefined) return cached
    if (!describeEnabled) return this.placeholderText
    if (!this.pendingPathByHash.has(imageHash)) {
      this.pendingPathByHash.set(imageHash, absoluteImagePath)
    }
    return this.placeholderText
  }

  /**
   * Run queued describe calls (concurrency-limited). No-op if describeEnabled is false.
   * Rejected hashes: files removed from disk; not written to hashDescriptions.
   */
  async flushDescribeQueue(describeEnabled: boolean): Promise<void> {
    if (!describeEnabled || this.pendingPathByHash.size === 0) return
    const limit = pLimit(this.concurrency)
    await Promise.all(
      [...this.pendingPathByHash.entries()].map(([hash, filePath]) =>
        limit(async () => {
          if (this.hashDescriptions.has(hash)) return
          let rawDescription = "No description returned."
          try {
            const buf = await fs.readFile(filePath)
            let lastErr: unknown
            for (let attempt = 0; attempt <= this.describeRetries; attempt++) {
              try {
                rawDescription = await withAbortTimeout(
                  (signal) =>
                    this.describeImage(
                      buf,
                      path.basename(filePath),
                      signal,
                    ),
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
              Logger.warn(
                `describeImage failed (deferred) for hash ${hash.slice(0, 8)}: ${lastErr instanceof Error ? lastErr.message : lastErr}`,
              )
              rawDescription = "No description returned."
            }
          } catch (e) {
            Logger.warn(
              `describeImage read/process failed for hash ${hash.slice(0, 8)}: ${e instanceof Error ? e.message : e}`,
            )
            rawDescription = "No description returned."
          }

          if (isRejectedImageDescription(rawDescription)) {
            this.rejectedHashes.add(hash)
            await this.deleteSavedFilesForHash(hash)
            Logger.info(
              `Dropping useless image(s) for hash ${hash.slice(0, 12)}… (${rawDescription.trim() || "empty"})`,
            )
            return
          }

          this.hashDescriptions.set(
            hash,
            rawDescription.trim(),
          )
        }),
      ),
    )
    this.pendingPathByHash.clear()
  }

  /**
   * Deletes every file recorded in savedPathsByHash, then clears savedPathsByHash,
   * pendingPathByHash, and rejectedHashes. Use when extraction fails before a
   * successful return so temporary images are not left on disk.
   */
  async disposeTrackedImageFiles(): Promise<void> {
    const hashes = [...this.savedPathsByHash.keys()]
    await Promise.all(hashes.map((h) => this.deleteSavedFilesForHash(h)))
    this.savedPathsByHash.clear()
    this.pendingPathByHash.clear()
    this.rejectedHashes.clear()
  }

  /**
   * Remove image chunk rows whose content hash was rejected after flushDescribeQueue.
   */
  stripRejectedImageRows(
    image_chunks: string[],
    image_chunk_pos: number[],
    chunkIndexToImageHash: Map<number, string>,
    image_chunks_map?: unknown[],
  ): void {
    if (this.rejectedHashes.size === 0) return

    let writeIdx = 0

    for (let readIdx = 0; readIdx < image_chunks.length; readIdx++) {
      const seq = image_chunk_pos[readIdx]
      const h = chunkIndexToImageHash.get(seq)

      if (h !== undefined && this.rejectedHashes.has(h)) {
        chunkIndexToImageHash.delete(seq)
        continue
      }

      image_chunks[writeIdx] = image_chunks[readIdx]
      image_chunk_pos[writeIdx] = seq

      if (image_chunks_map) {
        image_chunks_map[writeIdx] = image_chunks_map[readIdx]
      }

      writeIdx++
    }

    image_chunks.length = writeIdx
    image_chunk_pos.length = writeIdx
    if (image_chunks_map) image_chunks_map.length = writeIdx
  }

  /**
   * Replace placeholder entries in image_chunks using hashDescriptions +
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
