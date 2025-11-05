import { promises as fsPromises } from "fs"
import * as path from "path"
import { PDFDocument } from "pdf-lib"
import { getLogger } from "../logger"
import { Subsystem, type ChunkMetadata } from "../types"
import type { ProcessingResult } from "../services/fileProcessor"
import config from "@/config"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "chunkByOCR",
})

const DEFAULT_MAX_CHUNK_BYTES = 1024
const DEFAULT_IMAGE_DIR = "downloads/xyne_images_db"
const DEFAULT_LAYOUT_PARSING_BASE_URL = "http://localhost:8000"
const DEFAULT_LAYOUT_PARSING_FILE_TYPE = 0
const DEFAULT_LAYOUT_PARSING_VISUALIZE = false
const DEFAULT_LAYOUT_PARSING_TIMEOUT_MS = 300000
const LAYOUT_PARSING_API_PATH = "/v2/models/layout-parsing/infer"
const DEFAULT_MAX_PAGES_PER_LAYOUT_REQUEST = 100
const TEXT_CHUNK_OVERLAP_CHARS = 32

// Configuration constants
const LAYOUT_PARSING_BASE_URL = process.env.LAYOUT_PARSING_BASE_URL || DEFAULT_LAYOUT_PARSING_BASE_URL
const LAYOUT_PARSING_TIMEOUT_MS = process.env.LAYOUT_PARSING_TIMEOUT_MS 
  ? Number.parseInt(process.env.LAYOUT_PARSING_TIMEOUT_MS, 10) 
  : DEFAULT_LAYOUT_PARSING_TIMEOUT_MS

const LOCAL_STATUS_ENDPOINT = "http://localhost:8081/instance_status"
const DEFAULT_STATUS_ENDPOINT = config.paddleStatusEndpoint || LOCAL_STATUS_ENDPOINT
const DEFAULT_POLL_INTERVAL_MS = 300
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_THRESHOLD_FOR_CONCURRENCY = 1
const STATUS_FETCH_TIMEOUT_MS = 2_000
const STATUS_FETCH_MAX_RETRIES = 3
const BACKOFF_BASE_MS = 500
const BACKOFF_FACTOR = 2
const BACKOFF_MAX_MS = 8_000
const BACKOFF_JITTER_RATIO = 0.2  

type LayoutParsingBlock = {
  block_label?: string
  block_content?: string
  block_bbox?: number[]
}

type LayoutParsingMarkdown = {
  text?: string
  isStart?: boolean
  isEnd?: boolean
  images?: Record<string, string>
}

type LayoutParsingResult = {
  prunedResult?: {
    parsing_res_list?: LayoutParsingBlock[]
  }
  markdown?: LayoutParsingMarkdown
}

type LayoutParsingApiEnvelope = {
  outputs?: Array<{
    data?: string[]
  }>
}

type LayoutParsingApiPayload = {
  layoutParsingResults: LayoutParsingResult[]
  dataInfo?: unknown
}

type TritonRequestPayload = {
  inputs: Array<{
    name: string
    shape: number[]
    datatype: string
    data: string[]
  }>
  outputs: Array<{
    name: string
  }>
}

type ImageLookupEntry = {
  base64: string
  filePath: string
}

type ImageMetadata = {
  fileName?: string
  bboxKey?: string | null
  pageIndex: number
}

type ImageBufferMap = Record<number, Buffer>
type ImageMetadataMap = Record<number, ImageMetadata>

type OcrBlock = {
  block_label: string
  block_content: string
  block_bbox: number[]
  image_index?: number
}

type OcrResponse = Record<string, OcrBlock[]>

type GlobalSeq = {
  value: number
}

type PdfPageBatch = {
  buffer: Buffer
  startPage: number
  endPage: number
}

export interface PdfOcrBatch {
  id: string
  fileName: string
  startPage: number
  endPage: number
  pdfBuffer: Buffer
}

export interface DispatchOptions {
  statusEndpoint?: string
  pollIntervalMs?: number
  requestTimeoutMs?: number
  maxRetries?: number
  thresholdForConcurrency?: number
  signal?: AbortSignal
  logger?: Pick<Console, "info" | "warn" | "error">
  metrics?: {
    incr(name: string, tags?: Record<string, string>): void
    observe(name: string, value: number, tags?: Record<string, string>): void
  }
  sendBatch?: (
    batch: PdfOcrBatch,
    options: SendPdfBatchOptions,
  ) => Promise<void>
}

export interface DispatchReport {
  total: number
  succeeded: number
  failed: number
  startedAt: number
  endedAt: number
  perItem: Array<{
    id: string
    status: "ok" | "failed"
    attempts: number
    latencyMs: number
    error?: string
  }>
}

type BatchDispatchResult = DispatchReport["perItem"][number]

type InstanceStatusPayload = {
  active_instances?: unknown
  configured_instances?: unknown
  idle_instances?: unknown
  last_updated?: unknown
}



const noopLogger: Pick<Console, "info" | "warn" | "error"> = {
  info() {},
  warn() {},
  error() {},
}

const noopMetrics = {
  incr() {},
  observe() {},
}

type SendPdfBatchOptions = {
  timeoutMs: number
}

const TABLE_TAG = "(?:html|body|table|thead|tbody|tfoot|tr|th|td)";

// convert table structure to TSV
const convertTableToTsv = (html: string): string => {
  return html
    .replace(/<\/t[dh]\s*>/gi, "\t")  // </td>, </th> -> tab
    .replace(/<\/tr\s*>/gi, "\n")     // </tr> -> newline
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(new RegExp(`</?\\s*${TABLE_TAG}\\b[^>]*>`, "gi"), "") // Remove table tags
    .replace(/&(nbsp|#160);/gi, " ")
    .replace(/[ \f\r]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Placeholder implementation for integrating with the OCR service.
async function sendPdfOcrBatch(
  batch: PdfOcrBatch,
  { timeoutMs }: SendPdfBatchOptions,
): Promise<void> {
  const baseUrl = LAYOUT_PARSING_BASE_URL.replace(/\/+$/, '')
  const apiUrl = baseUrl + '/' + LAYOUT_PARSING_API_PATH.replace(/^\/+/, '')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // TODO: adjust payload to match OCR batch contract.
        id: batch.id,
        fileName: batch.fileName,
        startPage: batch.startPage,
        endPage: batch.endPage,
        pdfBase64: batch.pdfBuffer.toString("base64"),
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const responseText = await response.text().catch(() => "")
      throw new Error(
        `OCR batch request failed (${response.status}): ${responseText.slice(0, 200)}`,
      )
    }

  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error("OCR batch request aborted due to timeout")
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function isValidStatusNumber(raw: unknown): boolean {
  if (typeof raw === "number") {
    return Number.isFinite(raw)
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
      return false
    }
    const parsed = Number(trimmed)
    return Number.isFinite(parsed)
  }

  return false
}

function extractNumber(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed.length > 0) {
      const parsed = Number(trimmed)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }

  return 0
}

function sanitizeIdleValue(raw: unknown): number {
  const numericValue = extractNumber(raw)
  if (numericValue <= 0) {
    return 0
  }
  return Math.floor(numericValue)
}

function createAbortError(): Error {
  const error = new Error("aborted")
  error.name = "AbortError"
  return error
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "aborted")
  )
}

function applyBackoffJitter(durationMs: number): number {
  const jitter =
    1 + (Math.random() * 2 - 1) * Math.max(0, Math.min(1, BACKOFF_JITTER_RATIO))
  return Math.min(BACKOFF_MAX_MS, Math.round(durationMs * jitter))
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) {
      throw createAbortError()
    }
    return
  }

  if (signal?.aborted) {
    throw createAbortError()
  }

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const abortHandler = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (signal) {
        signal.removeEventListener("abort", abortHandler)
      }
      reject(createAbortError())
    }

    timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", abortHandler)
      }
      timer = null
      resolve()
    }, ms)

    if (signal) {
      signal.addEventListener("abort", abortHandler)
    }
  })
}

async function fetchIdleInstances(
  endpoint: string,
  logger: Pick<Console, "info" | "warn" | "error">,
  metrics: DispatchOptions["metrics"],
): Promise<number> {
  let attempt = 0
  let lastError: unknown

  while (attempt < STATUS_FETCH_MAX_RETRIES) {
    attempt += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), STATUS_FETCH_TIMEOUT_MS)

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        signal: controller.signal,
      })

      clearTimeout(timer)

      if (!response.ok) {
        throw new Error(`unexpected status ${response.status}`)
      }

      const payload = (await response.json()) as InstanceStatusPayload
      const idle = sanitizeIdleValue(payload.idle_instances)
      const active = isValidStatusNumber(payload.active_instances) 
        ? extractNumber(payload.active_instances) 
        : undefined
      const configured = isValidStatusNumber(payload.configured_instances)
        ? extractNumber(payload.configured_instances)
        : undefined
      const lastUpdated = isValidStatusNumber(payload.last_updated)
        ? extractNumber(payload.last_updated)
        : undefined

      metrics?.observe("ocr_dispatch.instances.idle", idle)
      if (active !== undefined) {
        metrics?.observe("ocr_dispatch.instances.active", active)
      }
      if (configured !== undefined) {
        metrics?.observe("ocr_dispatch.instances.configured", configured)
      }
      if (lastUpdated !== undefined) {
        metrics?.observe("ocr_dispatch.instances.last_updated", lastUpdated)
      }

      // Success - return the idle count
      if (attempt > 1) {
        logger.info("Successfully fetched OCR instance status after retry", {
          attempt,
          idle,
          endpoint,
        })
      }

      return idle
    } catch (error) {
      lastError = error
      clearTimeout(timer)
      
      const errorMessage = error instanceof Error ? error.message : String(error)
      
      if (attempt < STATUS_FETCH_MAX_RETRIES) {
        const backoffMs = computeBackoffMs(attempt)
        logger.warn(
          `Failed to fetch OCR instance status (attempt ${attempt}/${STATUS_FETCH_MAX_RETRIES}), retrying in ${backoffMs}ms`,
          {
            error: errorMessage,
            endpoint,
            attempt,
            backoffMs,
          },
        )
        metrics?.incr("ocr_dispatch.status_fetch_retry")
        
        await sleep(backoffMs)
      } else {
        // Max retries exceeded
        logger.error(
          `Failed to fetch OCR instance status after ${STATUS_FETCH_MAX_RETRIES} attempts`,
          {
            error: errorMessage,
            endpoint,
            attempts: STATUS_FETCH_MAX_RETRIES,
          },
        )
        metrics?.incr("ocr_dispatch.status_fetch_error")
        
        throw new Error(
          `Instance status server unreachable after ${STATUS_FETCH_MAX_RETRIES} attempts: ${errorMessage}`,
        )
      }
    }
  }

  // This should never be reached, but TypeScript needs it
  const finalMessage =
    lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error")
  throw new Error(
    `Instance status server unreachable after ${STATUS_FETCH_MAX_RETRIES} attempts: ${finalMessage}`,
  )
}

function computeBackoffMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1)
  const baseDelay = BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, exponent)
  return applyBackoffJitter(baseDelay)
}

async function processBatch(
  batch: PdfOcrBatch,
  options: {
    requestTimeoutMs: number
    maxRetries: number
    logger: Pick<Console, "info" | "warn" | "error">
    metrics: DispatchOptions["metrics"]
    signal?: AbortSignal
    sendBatch: (
      batch: PdfOcrBatch,
      sendOptions: SendPdfBatchOptions,
    ) => Promise<void>
  },
): Promise<BatchDispatchResult> {
  const {
    requestTimeoutMs,
    maxRetries,
    logger,
    metrics = noopMetrics,
    signal,
    sendBatch,
  } = options

  const totalAttemptsAllowed = Math.max(0, maxRetries) + 1
  let attempt = 0
  let lastError: unknown

  while (attempt < totalAttemptsAllowed) {
    if (signal?.aborted) {
      return {
        id: batch.id,
        status: "failed",
        attempts: attempt,
        latencyMs: 0,
        error: "aborted",
      }
    }

    attempt += 1
    const attemptStartedAt = Date.now()

    try {
      await sendBatch(batch, { timeoutMs: requestTimeoutMs })
      const latencyMs = Date.now() - attemptStartedAt
      logger.info(
        `[batch=${batch.id}] attempt=${attempt} latencyMs=${latencyMs} ok`,
      )
      metrics.observe("ocr_dispatch.latency_ms", latencyMs, {
        status: "ok",
      })
      metrics.incr("ocr_dispatch.attempts", { status: "ok" })
      return {
        id: batch.id,
        status: "ok",
        attempts: attempt,
        latencyMs,
      }
    } catch (error) {
      const latencyMs = Date.now() - attemptStartedAt
      lastError = error
      const errorMessage = error instanceof Error ? error.message : String(error)

      logger.warn(
        `[batch=${batch.id}] attempt=${attempt} latencyMs=${latencyMs} error=${errorMessage}`,
      )
      metrics.observe("ocr_dispatch.latency_ms", latencyMs, {
        status: "failed",
      })
      metrics.incr("ocr_dispatch.attempts", { status: "failed" })

      if (attempt >= totalAttemptsAllowed) {
        return {
          id: batch.id,
          status: "failed",
          attempts: attempt,
          latencyMs,
          error: errorMessage,
        }
      }

      const backoffMs = computeBackoffMs(attempt)
      logger.info(
        `[batch=${batch.id}] attempt=${attempt} error=${errorMessage} backoffMs=${backoffMs}`,
      )

      try {
        await sleep(backoffMs, signal)
      } catch (abortError) {
        if (isAbortError(abortError)) {
          return {
            id: batch.id,
            status: "failed",
            attempts: attempt,
            latencyMs,
            error: "aborted",
          }
        }
        throw abortError
      }
    }
  }

  const finalMessage =
    lastError instanceof Error ? lastError.message : String(lastError ?? "")
  return {
    id: batch.id,
    status: "failed",
    attempts: totalAttemptsAllowed,
    latencyMs: 0,
    error: finalMessage || "failed",
  }
}

type InFlightState = {
  batch: PdfOcrBatch
  promise: Promise<BatchDispatchResult>
  done: boolean
  result?: BatchDispatchResult
}

function createInFlightState(
  batch: PdfOcrBatch,
  options: {
    requestTimeoutMs: number
    maxRetries: number
    logger: Pick<Console, "info" | "warn" | "error">
    metrics: DispatchOptions["metrics"]
    signal?: AbortSignal
    sendBatch: (
      batch: PdfOcrBatch,
      sendOptions: SendPdfBatchOptions,
    ) => Promise<void>
  },
): InFlightState {
  const state: InFlightState = {
    batch,
    promise: Promise.resolve({} as BatchDispatchResult),
    done: false,
  }

  state.promise = processBatch(batch, options)
    .then((result) => {
      state.done = true
      state.result = result
      return result
    })
    .catch((error) => {
      state.done = true
      const errorMessage = error instanceof Error ? error.message : String(error)
      const fallback: BatchDispatchResult = {
        id: batch.id,
        status: "failed",
        attempts: 0,
        latencyMs: 0,
        error: errorMessage,
      }
      state.result = fallback
      return fallback
    })

  return state
}

async function waitForAll(
  inFlight: InFlightState[],
): Promise<InFlightState[]> {
  if (inFlight.length === 0) {
    return []
  }

  await Promise.allSettled(inFlight.map((state) => state.promise))
  return inFlight
}

function recordOutcome(
  result: BatchDispatchResult,
  perItem: DispatchReport["perItem"],
  counters: { succeeded: number; failed: number },
): void {
  perItem.push(result)
  if (result.status === "ok") {
    counters.succeeded += 1
  } else {
    counters.failed += 1
  }
}

async function runSequentialDispatch(
  batches: PdfOcrBatch[],
  options: {
    requestTimeoutMs: number
    maxRetries: number
    statusEndpoint: string
    logger: Pick<Console, "info" | "warn" | "error">
    metrics: DispatchOptions["metrics"]
    signal?: AbortSignal
    sendBatch: (
      batch: PdfOcrBatch,
      sendOptions: SendPdfBatchOptions,
    ) => Promise<void>
  },
  perItem: DispatchReport["perItem"],
  counters: { succeeded: number; failed: number },
): Promise<void> {
  const { logger, statusEndpoint, signal, sendBatch } = options

  const idle = await fetchIdleInstances(statusEndpoint, logger, options.metrics)
  logger.info(
    `[cycle=sequential] idle=${idle} remaining=${batches.length} inflight=0 dispatching=1`,
  )

  for (const batch of batches) {
    if (signal?.aborted) {
      recordOutcome(
        {
          id: batch.id,
          status: "failed",
          attempts: 0,
          latencyMs: 0,
          error: "aborted",
        },
        perItem,
        counters,
      )
      continue
    }

    const result = await processBatch(batch, {
      ...options,
      sendBatch,
    })
    recordOutcome(result, perItem, counters)
  }
}

async function runConcurrentDispatch(
  batches: PdfOcrBatch[],
  options: {
    requestTimeoutMs: number
    maxRetries: number
    statusEndpoint: string
    pollIntervalMs: number
    logger: Pick<Console, "info" | "warn" | "error">
    metrics: DispatchOptions["metrics"]
    signal?: AbortSignal
    sendBatch: (
      batch: PdfOcrBatch,
      sendOptions: SendPdfBatchOptions,
    ) => Promise<void>
  },
  perItem: DispatchReport["perItem"],
  counters: { succeeded: number; failed: number },
): Promise<void> {
  const {
    requestTimeoutMs,
    maxRetries,
    statusEndpoint,
    pollIntervalMs,
    logger,
    metrics,
    signal,
    sendBatch,
  } = options

  let inFlight: InFlightState[] = []
  const pendingQueue: PdfOcrBatch[] = [...batches]
  let cycle = 0
  let aborted = signal?.aborted ?? false

  const onAbort = () => {
    if (!aborted) {
      aborted = true
      logger.warn("Dispatch aborted by signal; draining in-flight tasks")
    }
  }

  signal?.addEventListener("abort", onAbort)

  try {
    while (pendingQueue.length > 0 || inFlight.length > 0) {
      cycle += 1

      let idle = 0
      if (!aborted) {
        idle = await fetchIdleInstances(statusEndpoint, logger, metrics)
      }

      const remaining = pendingQueue.length
      let toDispatch = 0
      if (!aborted && remaining > 0) {
        toDispatch = idle > 0 ? Math.min(idle/2, remaining) : 1
      }

      logger.info(
        `[cycle=${cycle}] idle=${idle} remaining=${remaining} inflight=${inFlight.length} dispatching=${toDispatch}${aborted ? " aborted=true" : ""}`,
      )

      for (let index = 0; index < toDispatch; index += 1) {
        const nextBatch = pendingQueue.shift()
        if (!nextBatch) {
          break
        }
        const state = createInFlightState(nextBatch, {
          requestTimeoutMs,
          maxRetries,
          logger,
          metrics,
          signal,
          sendBatch,
        })
        inFlight.push(state)
      }

      if (inFlight.length === 0) {
        if (aborted) {
          while (pendingQueue.length > 0) {
            const batch = pendingQueue.shift()
            if (!batch) {
              continue
            }
            recordOutcome(
              {
                id: batch.id,
                status: "failed",
                attempts: 0,
                latencyMs: 0,
                error: "aborted",
              },
              perItem,
              counters,
            )
          }
        }
        break
      }

      const completedStates = await waitForAll(inFlight)
      if (completedStates.length > 0) {
        for (const state of completedStates) {
          if (state.result) {
            recordOutcome(state.result, perItem, counters)
          }
        }
        inFlight = inFlight.filter((state) => !state.done)
      }

      if (aborted) {
        while (pendingQueue.length > 0) {
          const batch = pendingQueue.shift()
          if (!batch) {
            continue
          }
          recordOutcome(
            {
              id: batch.id,
              status: "failed",
              attempts: 0,
              latencyMs: 0,
              error: "aborted",
            },
            perItem,
            counters,
          )
        }
      }

      if (
        (pendingQueue.length > 0 || inFlight.length > 0) &&
        !aborted &&
        pollIntervalMs > 0
      ) {
        try {
          await sleep(pollIntervalMs, signal)
        } catch (error) {
          if (isAbortError(error)) {
            aborted = true
          } else {
            throw error
          }
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

export async function dispatchOCRBatches(
  batches: PdfOcrBatch[],
  opts: DispatchOptions = {},
): Promise<DispatchReport> {
  const startedAt = Date.now()
  const total = batches.length

  if (total === 0) {
    return {
      total: 0,
      succeeded: 0,
      failed: 0,
      startedAt,
      endedAt: startedAt,
      perItem: [],
    }
  }

  const {
    statusEndpoint = DEFAULT_STATUS_ENDPOINT,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    thresholdForConcurrency = DEFAULT_THRESHOLD_FOR_CONCURRENCY,
    signal,
    logger: providedLogger,
    metrics: providedMetrics,
    sendBatch: providedSendBatch,
  } = opts

  const logger = providedLogger ?? Logger ?? noopLogger
  const metrics = providedMetrics ?? noopMetrics
  const sendBatch =
    providedSendBatch ??
    ((batch: PdfOcrBatch, options: SendPdfBatchOptions) =>
      sendPdfOcrBatch(batch, options))

  const perItem: DispatchReport["perItem"] = []
  const counters = { succeeded: 0, failed: 0 }

  const dispatchOptions = {
    requestTimeoutMs,
    maxRetries,
    statusEndpoint,
    pollIntervalMs,
    logger,
    metrics,
    signal,
    sendBatch,
  }

  if (total <= thresholdForConcurrency) {
    await runSequentialDispatch(batches, dispatchOptions, perItem, counters)
  } else {
    await runConcurrentDispatch(batches, dispatchOptions, perItem, counters)
  }

  const endedAt = Date.now()

  return {
    total,
    succeeded: counters.succeeded,
    failed: counters.failed,
    startedAt,
    endedAt,
    perItem,
  }
}

function looksLikePdf(buffer: Buffer, fileName: string): boolean {
  if (fileName.toLowerCase().endsWith(".pdf")) {
    return true
  }
  if (buffer.length < 4) {
    return false
  }
  return buffer.subarray(0, 4).toString("utf8") === "%PDF"
}

function getByteLength(str: string): number {
  return Buffer.byteLength(str, "utf8")
}

function splitText(text: string, maxBytes: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+|\S+/g) ?? []
  const chunks: string[] = []
  let currentChunk: string[] = []
  let currentBytes = 0

  for (const sentence of sentences) {
    const sentenceBytes = getByteLength(sentence) + 1

    if (currentBytes + sentenceBytes > maxBytes) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.join(" "))
      }
      currentChunk = [sentence]
      currentBytes = sentenceBytes
    } else {
      currentChunk.push(sentence)
      currentBytes += sentenceBytes
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(" "))
  }

  return chunks
}

function trimChunkToByteLimit(content: string, byteLimit: number): string {
  if (getByteLength(content) <= byteLimit) {
    return content
  }

  let endIndex = content.length

  while (
    endIndex > 0 &&
    getByteLength(content.slice(0, endIndex)) > byteLimit
  ) {
    endIndex -= 1
  }

  return content.slice(0, endIndex)
}

function detectImageExtension(buffer: Buffer): string {
  if (buffer.length >= 4) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "jpg"
    }
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return "png"
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return "gif"
    }
    if (
      buffer.slice(0, 4).toString("ascii") === "RIFF" &&
      buffer.slice(8, 12).toString("ascii") === "WEBP"
    ) {
      return "webp"
    }
  }
  return "jpg"
}

function sanitizeFileName(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9._-]/g, "_")
  return sanitized || "image"
}

function ensureUniqueFileName(name: string, usedNames: Set<string>): string {
  if (!usedNames.has(name)) {
    usedNames.add(name)
    return name
  }

  const parsed = path.parse(name)
  let counter = 1

  while (true) {
    const candidate = `${parsed.name}_${counter}${parsed.ext}`
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate)
      return candidate
    }
    counter += 1
  }
}

function normalizeBBox(bbox?: number[]): string | null {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return null
  }
  try {
    return bbox.map((value) => Math.round(Number(value))).join("_")
  } catch {
    return null
  }
}

function parseBBoxKeyFromImagePath(imagePath: string): string | null {
  if (!imagePath) {
    return null
  }
  const cleaned = imagePath.replace(/\\/g, "/")
  const fileName = cleaned.split("/").pop()
  if (!fileName) {
    return null
  }
  const numbers = fileName.match(/\d+/g)
  if (!numbers || numbers.length < 4) {
    return null
  }
  return numbers.slice(-4).join("_")
}

function buildImageLookup(
  images: Record<string, string>,
): Map<string, ImageLookupEntry> {
  const lookup = new Map<string, ImageLookupEntry>()

  for (const [imgPath, base64Data] of Object.entries(images)) {
    if (!base64Data) {
      continue
    }
    const bboxKey = parseBBoxKeyFromImagePath(imgPath)
    if (!bboxKey) {
      continue
    }
    if (!lookup.has(bboxKey)) {
      lookup.set(bboxKey, {
        base64: base64Data,
        filePath: imgPath,
      })
    }
  }

  return lookup
}

function transformBlockContent(label: string, content: string): string {
  switch (label) {
    case "header":
    case "doc_title":
      return content ? `# ${content}` : content
    case "paragraph_title":
      return content ? `## ${content}` : content
    case "formula":
      return content ? `$$${content}$$` : content
    case "figure_title":
      return content
        ? `<div style="text-align: center;">${content}</div>`
        : content
    default:
      return content
  }
}

function normalizeBlockContent(block: OcrBlock): string {
  const content = block.block_content ?? ""
  if (!content.trim()) {
    return ""
  }

  if (block.block_label === "table") {
    return convertTableToTsv(content)
  }

  if (block.block_label === "figure_title") {
    return content.trim()
  }

  return content.replace(/\s+/g, " ").trim()
}

async function callLayoutParsingApi(
  buffer: Buffer,
  fileName: string,
): Promise<LayoutParsingApiPayload> {
  const baseUrl = (
    process.env.LAYOUT_PARSING_BASE_URL || DEFAULT_LAYOUT_PARSING_BASE_URL
  ).replace(/\/+$/, "")

  const apiUrl = baseUrl + "/" + LAYOUT_PARSING_API_PATH.replace(/^\/+/, "")
  const fileType = DEFAULT_LAYOUT_PARSING_FILE_TYPE
  const visualize = DEFAULT_LAYOUT_PARSING_VISUALIZE
  const timeoutMs = LAYOUT_PARSING_TIMEOUT_MS

  Logger.info("Calling layout parsing API", {
    apiUrl,
    fileName,
    fileSize: buffer.length,
  })

  const inputPayload = {
    file: buffer.toString("base64"),
    fileType,
    visualize,
  }

  const requestPayload: TritonRequestPayload = {
    inputs: [
      {
        name: "input",
        shape: [1, 1],
        datatype: "BYTES",
        data: [JSON.stringify(inputPayload)],
      },
    ],
    outputs: [
      {
        name: "output",
      },
    ],
  }

  const controller = new AbortController()
  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal,
    })

    if (!response.ok) {
      const responseText = await response.text().catch(() => "")
      throw new Error(
        `Layout parsing API request failed (${response.status}): ${responseText.slice(0, 200)}`,
      )
    }
    Logger.info("Layout parsing API request succeeded, parsing response")
    const envelope = (await response.json()) as LayoutParsingApiEnvelope

    const outputPayload = envelope.outputs?.[0]?.data?.[0]
    if (!outputPayload) {
      throw new Error("Layout parsing API payload missing expected output data")
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(outputPayload)
    } catch (error) {
      throw new Error(
        `Failed to JSON.parse layout parsing payload: ${(error as Error).message}`,
      )
    }

    const result = (parsed as { result?: LayoutParsingApiPayload }).result
    if (!result) {
      throw new Error("Layout parsing API response missing result field")
    }

    return result
  } catch (error) {
    // Log the layout parsing API failure with context
    Logger.error(
      error,
      `Layout parsing API call failed for file: ${fileName}`,
      {
        fileName,
        fileSize: buffer.length,
        apiUrl,
      },
    )

    // Re-throw with enhanced error message for better debugging
    if (error instanceof Error) {
      throw new Error(
        `Layout parsing API failed for "${fileName}": ${error.message}`,
      )
    } else {
      throw new Error(
        `Layout parsing API failed for "${fileName}": Unknown error occurred`,
      )
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function transformLayoutParsingResults(
  layoutParsingResults: LayoutParsingResult[],
): {
  ocrResponse: OcrResponse
  images: ImageBufferMap
  imageMetadata: ImageMetadataMap
} {
  const ocrResponse: OcrResponse = {}
  const images: ImageBufferMap = {}
  const imageMetadata: ImageMetadataMap = {}
  let nextImageIndex = 0

  layoutParsingResults.forEach((layout, pageIndex) => {
    const parsingResList = layout.prunedResult?.parsing_res_list ?? []
    const markdownImages = layout.markdown?.images ?? {}
    const imageLookup = buildImageLookup(markdownImages)
    const usedImagePaths = new Set<string>()
    const transformedBlocks: OcrBlock[] = []

    for (const rawBlock of parsingResList) {
      const blockLabel = rawBlock.block_label ?? "text"
      const rawContent = rawBlock.block_content ?? ""
      const transformedContent = transformBlockContent(blockLabel, rawContent)
      const blockBBox = Array.isArray(rawBlock.block_bbox)
        ? [...rawBlock.block_bbox]
        : []

      const transformedBlock: OcrBlock = {
        block_label: blockLabel,
        block_content: transformedContent,
        block_bbox: blockBBox,
      }

      if (blockLabel === "image") {
        const bboxKey = normalizeBBox(blockBBox)
        const matchedImage = bboxKey ? imageLookup.get(bboxKey) : undefined

        if (matchedImage && !usedImagePaths.has(matchedImage.filePath)) {
          try {
            const imageBuffer = Buffer.from(matchedImage.base64, "base64")
            const imageIndex = nextImageIndex
            nextImageIndex += 1

            transformedBlock.image_index = imageIndex
            images[imageIndex] = imageBuffer
            imageMetadata[imageIndex] = {
              fileName: path.basename(matchedImage.filePath),
              bboxKey,
              pageIndex,
            }
            usedImagePaths.add(matchedImage.filePath)
          } catch (error) {
            Logger.error("Failed to decode image from layout parsing result", {
              error: (error as Error).message,
              pageIndex,
              bboxKey,
            })
          }
        } else {
          Logger.debug("No matching image found for block", {
            pageIndex,
            bboxKey,
          })
        }
      }

      transformedBlocks.push(transformedBlock)
    }

    ocrResponse[String(pageIndex)] = transformedBlocks
  })

  return { ocrResponse, images, imageMetadata }
}

async function splitPdfIntoBatches(
  buffer: Buffer,
  maxPagesPerBatch: number = DEFAULT_MAX_PAGES_PER_LAYOUT_REQUEST,
  preloadedPdf?: PDFDocument,
): Promise<PdfPageBatch[]> {
  const sourcePdf = preloadedPdf ?? (await PDFDocument.load(buffer))
  const totalPages = sourcePdf.getPageCount()

  if (totalPages <= maxPagesPerBatch) {
    return [
      {
        buffer,
        startPage: 1,
        endPage: totalPages,
      },
    ]
  }

  Logger.info("Splitting large PDF into batches", {
    totalPages,
    maxPagesPerBatch,
    estimatedBatches: Math.ceil(totalPages / maxPagesPerBatch),
  })

  const batches: PdfPageBatch[] = []

  for (
    let startPage = 0;
    startPage < totalPages;
    startPage += maxPagesPerBatch
  ) {
    const endPage = Math.min(startPage + maxPagesPerBatch, totalPages)
    const pageCount = endPage - startPage
    const startPageNumber = startPage + 1
    const endPageNumber = endPage

    // Create new PDF with subset of pages
    const newPdf = await PDFDocument.create()
    const pageIndices: number[] = []
    for (let i = 0; i < pageCount; i++) {
      pageIndices.push(startPage + i)
    }

    const copiedPages = await newPdf.copyPages(sourcePdf, pageIndices)
    for (const page of copiedPages) {
      newPdf.addPage(page)
    }

    const pdfBytes = await newPdf.save()
    batches.push({
      buffer: Buffer.from(pdfBytes),
      startPage: startPageNumber,
      endPage: endPageNumber,
    })

    Logger.info("Created PDF batch", {
      batchIndex: batches.length,
      startPage: startPageNumber,
      endPage: endPageNumber,
      pagesInBatch: pageCount,
      batchSizeBytes: pdfBytes.length,
    })
  }

  return batches
}

function mergeLayoutParsingResults(
  results: LayoutParsingApiPayload[],
): LayoutParsingApiPayload {
  const allLayoutResults: LayoutParsingResult[] = []

  for (const result of results) {
    const layoutResults = result.layoutParsingResults ?? []

    // Adjust page indices to maintain correct ordering across batches
    const adjustedResults = layoutResults.map((layout, localPageIndex) => ({
      ...layout,
      // We don't need to modify the layout structure itself since
      // transformLayoutParsingResults handles page indexing correctly
    }))

    allLayoutResults.push(...adjustedResults)
  }

  return {
    layoutParsingResults: allLayoutResults,
    dataInfo: results[0]?.dataInfo,
  }
}

async function processPdfBatchesWithDispatcher(
  batches: PdfPageBatch[],
  fileName: string,
): Promise<LayoutParsingApiPayload[]> {
  if (batches.length === 0) {
    return []
  }

  if (batches.length === 1) {
    const singleBatch = batches[0]
    Logger.info("Processing single PDF batch via OCR pipeline", {
      fileName,
      startPage: singleBatch.startPage,
      endPage: singleBatch.endPage,
      pagesInBatch: singleBatch.endPage - singleBatch.startPage + 1,
    })

    const result = await callLayoutParsingApi(
      singleBatch.buffer,
      `${fileName}_pages_${singleBatch.startPage}-${singleBatch.endPage}`,
    )

    Logger.info("Completed single PDF batch", {
      fileName,
      layoutResultsCount: result.layoutParsingResults?.length ?? 0,
    })

    return [result]
  }

  Logger.info("Dispatching PDF batches via OCR dispatcher", {
    fileName,
    totalBatches: batches.length,
  })

  const resultsByBatchId = new Map<string, LayoutParsingApiPayload>()
  const dispatchBatches: PdfOcrBatch[] = batches.map((batch, index) => ({
    id: `${fileName}_batch_${index + 1}`,
    fileName,
    startPage: batch.startPage,
    endPage: batch.endPage,
    pdfBuffer: batch.buffer,
  }))

  const dispatchOptions: DispatchOptions = {
    logger: Logger,
    sendBatch: async (batch) => {
      const label = `${batch.fileName}_pages_${batch.startPage}-${batch.endPage}`
      Logger.info("Sending PDF batch to layout parsing API", {
        batchId: batch.id,
        fileName: batch.fileName,
        startPage: batch.startPage,
        endPage: batch.endPage,
        pagesInBatch: batch.endPage - batch.startPage + 1,
      })
      const result = await callLayoutParsingApi(batch.pdfBuffer, label)
      resultsByBatchId.set(batch.id, result)
      Logger.info("Completed PDF batch", {
        batchId: batch.id,
        layoutResultsCount: result.layoutParsingResults?.length ?? 0,
      })
    },
  }

  const report = await dispatchOCRBatches(dispatchBatches, dispatchOptions)

  if (report.failed > 0) {
    throw new Error(
      `Failed to process ${report.failed} PDF batch(es) via OCR dispatcher`,
    )
  }

  return dispatchBatches.map((batch) => {
    const batchResult = resultsByBatchId.get(batch.id)
    if (!batchResult) {
      throw new Error(`Missing OCR result for batch ${batch.id}`)
    }
    return batchResult
  })
}

export async function chunkByOCRFromBuffer(
  buffer: Buffer,
  fileName: string,
  docId: string,
): Promise<ProcessingResult> {
  const maxPagesPerRequest = DEFAULT_MAX_PAGES_PER_LAYOUT_REQUEST

  let finalApiResult: LayoutParsingApiPayload

  if (looksLikePdf(buffer, fileName)) {
    try {
      const srcPdf = await PDFDocument.load(buffer)
      const totalPages = srcPdf.getPageCount()

      Logger.info("Analyzed PDF for batching", {
        fileName,
        totalPages,
        maxPagesPerRequest,
      })

      if (totalPages > maxPagesPerRequest) {
        const batches = await splitPdfIntoBatches(
          buffer,
          maxPagesPerRequest,
          srcPdf,
        )
        Logger.info("Processing PDF in batches", {
          fileName,
          totalPages,
          batches: batches.length,
        })

        const batchResults = await processPdfBatchesWithDispatcher(
          batches,
          fileName,
        )

        finalApiResult = mergeLayoutParsingResults(batchResults)
        Logger.info("Merged batch results", {
          totalBatches: batches.length,
          layoutResultsCount: finalApiResult.layoutParsingResults?.length || 0,
        })
      } else {
        finalApiResult = await callLayoutParsingApi(buffer, fileName)
      }
    } catch (error) {
      Logger.warn(
        "Failed to analyze PDF for batching, processing as single file",
        {
          fileName,
          error: (error as Error).message,
        },
      )
      finalApiResult = await callLayoutParsingApi(buffer, fileName)
    }
  } else {
    // Not a PDF, process normally
    finalApiResult = await callLayoutParsingApi(buffer, fileName)
  }

  Logger.info("API result received", {
    layoutResultsCount: finalApiResult.layoutParsingResults?.length || 0,
  })

  const layoutResults = finalApiResult.layoutParsingResults ?? []
  if (layoutResults.length === 0) {
    Logger.warn("Layout parsing API returned no results", { fileName })
  }

  const { ocrResponse, images, imageMetadata } =
    transformLayoutParsingResults(layoutResults)
  Logger.debug("Transformed layout results", {
    ocrResponsePages: Object.keys(ocrResponse).length,
    imagesCount: Object.keys(images).length,
    imageMetadataCount: Object.keys(imageMetadata).length,
  })

  return chunkByOCR(docId, ocrResponse, images, imageMetadata)
}

export async function chunkByOCR(
  docId: string,
  ocrResponse: OcrResponse,
  images: ImageBufferMap,
  imageMetadata: ImageMetadataMap = {},
): Promise<ProcessingResult> {
  const chunks: string[] = []
  const chunks_map: ChunkMetadata[] = []
  const image_chunks: string[] = []
  const image_chunks_map: ChunkMetadata[] = []

  const globalSeq: GlobalSeq = { value: 0 }
  const chunkSizeLimit = DEFAULT_MAX_CHUNK_BYTES

  let currentTextBuffer = ""
  let currentBlockLabels: string[] = []
  let currentPageNumbers: Set<number> = new Set()
  let lastTextChunk: string | null = null

  const imageBaseDir = path.resolve(DEFAULT_IMAGE_DIR)
  const docImageDir = path.join(imageBaseDir, docId)
  await fsPromises.mkdir(docImageDir, { recursive: true })
  const savedImages = new Set<number>()
  const usedFileNames = new Set<string>()

  const addChunk = (preservePageNumbers: boolean = false) => {
    if (!currentTextBuffer.trim()) {
      currentTextBuffer = ""
      currentBlockLabels = []
      if (!preservePageNumbers) {
        currentPageNumbers.clear()
      }
      return
    }

    const subChunks = splitText(currentTextBuffer, chunkSizeLimit)

    for (let index = 0; index < subChunks.length; index += 1) {
      let chunkContent = subChunks[index]
      if (index > 0) {
        chunkContent = `(continued) ${chunkContent}`
      }

      if (TEXT_CHUNK_OVERLAP_CHARS > 0 && lastTextChunk) {
        const overlap = lastTextChunk.slice(-TEXT_CHUNK_OVERLAP_CHARS)
        if (overlap && !chunkContent.startsWith(overlap)) {
          const needsSeparator =
            !/\s$/.test(overlap) &&
            chunkContent.length > 0 &&
            !/^\s/.test(chunkContent)
          chunkContent = `${overlap}${needsSeparator ? " " : ""}${chunkContent}`
        }
      }

      chunkContent = trimChunkToByteLimit(chunkContent, chunkSizeLimit)

      const pageNumbersArray = Array.from(currentPageNumbers).sort(
        (a, b) => a - b,
      )
      const blockLabelsArray = Array.from(new Set(currentBlockLabels))

      chunks.push(chunkContent)
      chunks_map.push({
        chunk_index: globalSeq.value,
        page_numbers: pageNumbersArray,
        block_labels: blockLabelsArray,
      })

      globalSeq.value += 1
      lastTextChunk = chunkContent
    }

    currentTextBuffer = ""
    currentBlockLabels = []
    if (!preservePageNumbers) {
      currentPageNumbers.clear()
    }
  }

  const pageKeys = Object.keys(ocrResponse)
    .map((key) => Number.parseInt(key, 10))
    .filter((value) => !Number.isNaN(value))
    .sort((a, b) => a - b)

  for (const pageNumber of pageKeys) {
    const blocks = ocrResponse[String(pageNumber)] ?? []

    for (const block of blocks) {
      if (block.block_label === "image") {
        if (typeof block.image_index !== "number") {
          Logger.warn("Image block missing image_index", {
            docId,
            pageNumber,
          })
          continue
        }

        const imageBuffer = images[block.image_index]
        if (!imageBuffer) {
          Logger.warn("No image buffer found for index", {
            docId,
            pageNumber,
            imageIndex: block.image_index,
          })
          continue
        }

        const metadata = imageMetadata[block.image_index] ?? {
          bboxKey: normalizeBBox(block.block_bbox),
          pageIndex: pageNumber,
        }

        // const fileName = deriveImageFileName(
        //   metadata.fileName,
        //   metadata.bboxKey ?? normalizeBBox(block.block_bbox),
        //   imageBuffer,
        //   block.image_index,
        //   metadata.pageIndex ?? pageNumber,
        // )
        // Only process images that have content/description
        const description = block.block_content?.trim()
        if (!description) {
          Logger.debug("Skipping image with no description", {
            docId,
            pageNumber,
            imageIndex: block.image_index,
          })
          continue
        }

        const extension = detectImageExtension(imageBuffer)
        const fileName = globalSeq.value.toString() + "." + extension

        const uniqueFileName = ensureUniqueFileName(fileName, usedFileNames)
        const imagePath = path.join(docImageDir, uniqueFileName)

        if (!savedImages.has(block.image_index)) {
          try {
            await fsPromises.writeFile(imagePath, imageBuffer)
            savedImages.add(block.image_index)
            Logger.info("Saved OCR image", {
              docId,
              pageNumber,
              imageIndex: block.image_index,
              imagePath,
            })
          } catch (error) {
            Logger.error("Failed to save OCR image", {
              docId,
              pageNumber,
              imageIndex: block.image_index,
              error: (error as Error).message,
            })
          }
        }

        image_chunks.push(description)
        image_chunks_map.push({
          chunk_index: globalSeq.value,
          page_numbers: [pageNumber],
          block_labels: ["image"],
        })
        globalSeq.value += 1

        currentTextBuffer += `${currentTextBuffer ? " " : ""}[IMG#${block.image_index}]`
        currentPageNumbers.add(pageNumber)
      } else {
        const normalizedText = normalizeBlockContent(block)
        if (!normalizedText) {
          continue
        }

        const projectedSize =
          getByteLength(currentTextBuffer) +
          (currentTextBuffer ? 1 : 0) +
          getByteLength(normalizedText)

        if (projectedSize > chunkSizeLimit) {
          addChunk(false) // Don't preserve page numbers - start fresh
        }

        currentTextBuffer += (currentTextBuffer ? " " : "") + normalizedText
        currentBlockLabels.push(block.block_label)
        currentPageNumbers.add(pageNumber)
      }
    }
  }

  if (currentTextBuffer.trim()) {
    Logger.debug("Adding final text chunk")
    addChunk(false) // Don't preserve page numbers for final chunk
  }

  const chunks_pos = chunks_map.map((metadata) => metadata.chunk_index)
  const image_chunks_pos = image_chunks_map.map(
    (metadata) => metadata.chunk_index,
  )

  Logger.info("Processing completed", {
    totalTextChunks: chunks.length,
    totalImageChunks: image_chunks.length,
    totalChunksMetadata: chunks_map.length,
    totalImageChunksMetadata: image_chunks_map.length,
    finalGlobalSeq: globalSeq.value,
  })

  return {
    chunks,
    chunks_pos,
    image_chunks,
    image_chunks_pos,
    chunks_map,
    image_chunks_map,
  }
}
