/**
 * Test file for OCR Dispatcher Logic
 * 
 * This test suite verifies the dispatch logic implementation in chunkByOCR.ts
 * It mocks the instance status endpoint and PDF processing to demonstrate
 * how batches are processed under various scenarios.
 */

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test"
import { promises as fsPromises } from "fs"
import * as path from "path"
import { PDFDocument } from "pdf-lib"
import type { PdfOcrBatch, DispatchOptions, DispatchReport } from "../lib/chunkByOCR"
import { dispatchOCRBatches } from "../lib/chunkByOCR"

// ============================================================================
// TEST CONFIGURATION
// ============================================================================

const PAGES_PER_BATCH = 100
const MAX_BATCHES_TO_TEST = 100

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function createMockBatches(
  pdfPath: string,
  pagesPerBatch: number,
  maxBatches: number,
): Promise<PdfOcrBatch[]> {
  const pdfBuffer = await fsPromises.readFile(pdfPath)
  const pdfDocument = await PDFDocument.load(pdfBuffer)
  const totalPages = pdfDocument.getPageCount()
  const pdfFileName = path.basename(pdfPath)

  const batches: PdfOcrBatch[] = []
  
  for (let startPage = 0; startPage < totalPages && batches.length < maxBatches; startPage += pagesPerBatch) {
    const endPage = Math.min(startPage + pagesPerBatch, totalPages)
    const pageCount = endPage - startPage

    const newPdf = await PDFDocument.create()
    const pageIndices: number[] = []
    for (let i = 0; i < pageCount; i++) {
      pageIndices.push(startPage + i)
    }

    const copiedPages = await newPdf.copyPages(pdfDocument, pageIndices)
    for (const page of copiedPages) {
      newPdf.addPage(page)
    }

    const pdfBytes = await newPdf.save()
    
    batches.push({
      id: `batch-${batches.length + 1}`,
      fileName: pdfFileName,
      startPage: startPage + 1,
      endPage: endPage,
      pdfBuffer: Buffer.from(pdfBytes),
    })
  }

  return batches
}

// ============================================================================
// MOCK INSTANCE STATUS ENDPOINT
// ============================================================================

type MockStatusConfig = {
  idleSequence: number[]
  label: string
  serverDown?: boolean
}

function createMockFetch(config: MockStatusConfig) {
  let statusCallCount = 0
  const originalFetch = globalThis.fetch

  return {
    install: () => {
      globalThis.fetch = async (input, init) => {
        if (typeof input === "string" && input.includes("/instance_status")) {
          statusCallCount += 1
          
          if (config.serverDown) {
            throw new Error("ECONNREFUSED: Connection refused - instance status server is down")
          }

          const idle =
            config.idleSequence[
              statusCallCount < config.idleSequence.length
                ? statusCallCount - 1
                : config.idleSequence.length - 1
            ] ?? 0

          return new Response(
            JSON.stringify({
              active_instances: Math.max(0, 10 - idle),
              configured_instances: 10,
              idle_instances: idle,
              last_updated: Date.now(),
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          )
        }

        throw new Error(
          `[ocrDispatcher.test] Unexpected fetch target: ${String(input)}`,
        )
      }
    },
    restore: () => {
      globalThis.fetch = originalFetch
    },
    getCallCount: () => statusCallCount,
  }
}

// ============================================================================
// MOCK BATCH PROCESSOR
// ============================================================================

type BatchProcessingStats = {
  totalDispatched: number
  totalCompleted: number
  totalFailed: number
  batchTimings: Array<{
    id: string
    startTime: number
    endTime: number
    duration: number
  }>
}

function createMockBatchProcessor() {
  const stats: BatchProcessingStats = {
    totalDispatched: 0,
    totalCompleted: 0,
    totalFailed: 0,
    batchTimings: [],
  }

  const sendBatch = async (
    batch: PdfOcrBatch,
    options: { timeoutMs: number },
  ): Promise<void> => {
    stats.totalDispatched += 1
    const startTime = Date.now()

    // Simulate processing time (30-80ms)
    const processingTime = 30 + Math.random() * 50
    await sleep(processingTime)

    // Simulate occasional failures (5% chance)
    if (Math.random() < 0.05) {
      stats.totalFailed += 1
      throw new Error(`Simulated processing failure for ${batch.id}`)
    }

    const endTime = Date.now()
    stats.totalCompleted += 1
    stats.batchTimings.push({
      id: batch.id,
      startTime,
      endTime,
      duration: endTime - startTime,
    })
  }

  return { sendBatch, stats }
}

// ============================================================================
// MOCK LOGGER
// ============================================================================

function createTestLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }
}

// ============================================================================
// MOCK METRICS COLLECTOR
// ============================================================================

type MetricsData = {
  counters: Record<string, number>
  observations: Array<{
    name: string
    value: number
    tags?: Record<string, string>
  }>
}

function createMetricsCollector() {
  const data: MetricsData = {
    counters: {},
    observations: [],
  }

  return {
    incr: mock((name: string, tags?: Record<string, string>) => {
      const key = tags ? `${name}:${JSON.stringify(tags)}` : name
      data.counters[key] = (data.counters[key] || 0) + 1
    }),
    observe: mock((name: string, value: number, tags?: Record<string, string>) => {
      data.observations.push({ name, value, tags })
    }),
    getData: () => data,
  }
}

// ============================================================================
// TEST SCENARIOS
// ============================================================================

type TestScenario = {
  name: string
  description: string
  idleSequence: number[]
  thresholdForConcurrency: number
  pollIntervalMs: number
  maxRetries: number
  serverDown?: boolean
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe("OCR Dispatcher", () => {
  let mockBatches: PdfOcrBatch[]
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    // Create minimal mock batches for testing
    mockBatches = [
      {
        id: "batch-1",
        fileName: "test.pdf",
        startPage: 1,
        endPage: 10,
        pdfBuffer: Buffer.from("mock-pdf-data-1"),
      },
      {
        id: "batch-2",
        fileName: "test.pdf",
        startPage: 11,
        endPage: 20,
        pdfBuffer: Buffer.from("mock-pdf-data-2"),
      },
      {
        id: "batch-3",
        fileName: "test.pdf",
        startPage: 21,
        endPage: 30,
        pdfBuffer: Buffer.from("mock-pdf-data-3"),
      },
    ]
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("should process batches sequentially when below concurrency threshold", async () => {
    const mockFetch = createMockFetch({
      idleSequence: [5],
      label: "Sequential Processing",
    })
    const mockProcessor = createMockBatchProcessor()
    const logger = createTestLogger()
    const metrics = createMetricsCollector()

    mockFetch.install()

    try {
      const options: DispatchOptions = {
        logger,
        metrics,
        sendBatch: mockProcessor.sendBatch,
        thresholdForConcurrency: 100, // High threshold to force sequential
        pollIntervalMs: 50,
        maxRetries: 2,
      }

      const report: DispatchReport = await dispatchOCRBatches(mockBatches, options)

      expect(report.total).toBe(3)
      expect(report.succeeded).toBeGreaterThanOrEqual(2)
      expect(mockProcessor.stats.totalDispatched).toBeGreaterThanOrEqual(2)
    } finally {
      mockFetch.restore()
    }
  })

  test("should process batches concurrently with high idle capacity", async () => {
    const mockFetch = createMockFetch({
      idleSequence: [8, 8, 8, 8, 8],
      label: "High Idle Capacity",
    })
    const mockProcessor = createMockBatchProcessor()
    const logger = createTestLogger()
    const metrics = createMetricsCollector()

    mockFetch.install()

    try {
      const options: DispatchOptions = {
        logger,
        metrics,
        sendBatch: mockProcessor.sendBatch,
        thresholdForConcurrency: 1,
        pollIntervalMs: 50,
        maxRetries: 2,
      }

      const report: DispatchReport = await dispatchOCRBatches(mockBatches, options)

      expect(report.total).toBe(3)
      expect(report.succeeded).toBeGreaterThanOrEqual(2)
      expect(mockFetch.getCallCount()).toBeGreaterThan(0)
    } finally {
      mockFetch.restore()
    }
  })

  test("should handle low idle capacity gracefully", async () => {
    const mockFetch = createMockFetch({
      idleSequence: [1, 1, 1, 1, 1],
      label: "Low Idle Capacity",
    })
    const mockProcessor = createMockBatchProcessor()
    const logger = createTestLogger()
    const metrics = createMetricsCollector()

    mockFetch.install()

    try {
      const options: DispatchOptions = {
        logger,
        metrics,
        sendBatch: mockProcessor.sendBatch,
        thresholdForConcurrency: 1,
        pollIntervalMs: 50,
        maxRetries: 2,
      }

      const report: DispatchReport = await dispatchOCRBatches(mockBatches, options)

      expect(report.total).toBe(3)
      expect(mockProcessor.stats.totalDispatched).toBeGreaterThanOrEqual(2)
    } finally {
      mockFetch.restore()
    }
  })

  test("should handle no idle capacity scenario", async () => {
    const mockFetch = createMockFetch({
      idleSequence: [0, 0, 0, 1, 2],
      label: "No Idle Capacity",
    })
    const mockProcessor = createMockBatchProcessor()
    const logger = createTestLogger()
    const metrics = createMetricsCollector()

    mockFetch.install()

    try {
      const options: DispatchOptions = {
        logger,
        metrics,
        sendBatch: mockProcessor.sendBatch,
        thresholdForConcurrency: 1,
        pollIntervalMs: 50,
        maxRetries: 2,
      }

      const report: DispatchReport = await dispatchOCRBatches(mockBatches, options)

      expect(report.total).toBe(3)
      expect(mockFetch.getCallCount()).toBeGreaterThan(0)
    } finally {
      mockFetch.restore()
    }
  })

  test("should adapt to fluctuating capacity", async () => {
    const mockFetch = createMockFetch({
      idleSequence: [5, 8, 3, 1, 0, 2, 6, 4],
      label: "Fluctuating Capacity",
    })
    const mockProcessor = createMockBatchProcessor()
    const logger = createTestLogger()
    const metrics = createMetricsCollector()

    mockFetch.install()

    try {
      const options: DispatchOptions = {
        logger,
        metrics,
        sendBatch: mockProcessor.sendBatch,
        thresholdForConcurrency: 1,
        pollIntervalMs: 50,
        maxRetries: 2,
      }

      const report: DispatchReport = await dispatchOCRBatches(mockBatches, options)

      expect(report.total).toBe(3)
      expect(mockProcessor.stats.totalDispatched).toBeGreaterThanOrEqual(2)
    } finally {
      mockFetch.restore()
    }
  })

  test("should handle instance server being down", async () => {
    const mockFetch = createMockFetch({
      idleSequence: [],
      label: "Server Down",
      serverDown: true,
    })
    const mockProcessor = createMockBatchProcessor()
    const logger = createTestLogger()
    const metrics = createMetricsCollector()

    mockFetch.install()

    try {
      const options: DispatchOptions = {
        logger,
        metrics,
        sendBatch: mockProcessor.sendBatch,
        thresholdForConcurrency: 1,
        pollIntervalMs: 50,
        maxRetries: 2,
      }

      // Expect the function to throw an error when server is down
      await expect(async () => {
        await dispatchOCRBatches(mockBatches, options)
      }).toThrow()

      // Verify that error logging occurred
      expect(logger.error).toHaveBeenCalled()
    } finally {
      mockFetch.restore()
    }
  })

  test("should track metrics correctly", async () => {
    const mockFetch = createMockFetch({
      idleSequence: [5, 5, 5],
      label: "Metrics Test",
    })
    const mockProcessor = createMockBatchProcessor()
    const logger = createTestLogger()
    const metrics = createMetricsCollector()

    mockFetch.install()

    try {
      const options: DispatchOptions = {
        logger,
        metrics,
        sendBatch: mockProcessor.sendBatch,
        thresholdForConcurrency: 1,
        pollIntervalMs: 50,
        maxRetries: 3,
      }

      const report: DispatchReport = await dispatchOCRBatches(mockBatches, options)

      const metricsData = metrics.getData()
      
      expect(report.total).toBe(3)
      expect(metrics.incr).toHaveBeenCalled()
      expect(metrics.observe).toHaveBeenCalled()
    } finally {
      mockFetch.restore()
    }
  })

  test("should provide detailed per-item results", async () => {
    const mockFetch = createMockFetch({
      idleSequence: [5, 5, 5],
      label: "Per-Item Results",
    })
    const mockProcessor = createMockBatchProcessor()
    const logger = createTestLogger()
    const metrics = createMetricsCollector()

    mockFetch.install()

    try {
      const options: DispatchOptions = {
        logger,
        metrics,
        sendBatch: mockProcessor.sendBatch,
        thresholdForConcurrency: 1,
        pollIntervalMs: 50,
        maxRetries: 2,
      }

      const report: DispatchReport = await dispatchOCRBatches(mockBatches, options)

      expect(report.perItem).toBeDefined()
      expect(report.perItem.length).toBe(3)
      
      for (const item of report.perItem) {
        expect(item.id).toBeDefined()
        expect(item.status).toMatch(/ok|failed/)
        expect(item.attempts).toBeGreaterThan(0)
        expect(item.latencyMs).toBeGreaterThanOrEqual(0)
      }
    } finally {
      mockFetch.restore()
    }
  })
})
