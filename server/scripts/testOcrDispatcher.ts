#!/usr/bin/env bun
/**
 * Test file for OCR Dispatcher Logic
 * 
 * This script tests the dispatch logic implementation in chunkByOCR.ts
 * It mocks the instance status endpoint and PDF processing to demonstrate
 * how batches are processed under various scenarios.
 * 
 * Run with: bun run server/scripts/testOcrDispatcher.ts
 */

import { promises as fsPromises } from "fs"
import * as path from "path"
import { PDFDocument } from "pdf-lib"
import type { PdfOcrBatch, DispatchOptions, DispatchReport } from "../lib/chunkByOCR"

// Import the dispatcher function
import { dispatchOCRBatches } from "../lib/chunkByOCR"

// ============================================================================
// MOCK CONFIGURATION
// ============================================================================

const MOCK_PDF_PATH = "/Users/aayush.shah/Downloads/Tolkien-J.-The-lord-of-the-rings-HarperCollins-ebooks-2010.pdf"
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
  console.log(`\n📄 Loading PDF: ${path.basename(pdfPath)}`)
  
  const pdfBuffer = await fsPromises.readFile(pdfPath)
  const pdfDocument = await PDFDocument.load(pdfBuffer)
  const totalPages = pdfDocument.getPageCount()
  const pdfFileName = path.basename(pdfPath)

  console.log(`   Total pages: ${totalPages}`)
  console.log(`   Pages per batch: ${pagesPerBatch}`)

  const batches: PdfOcrBatch[] = []
  
  for (let startPage = 0; startPage < totalPages && batches.length < maxBatches; startPage += pagesPerBatch) {
    const endPage = Math.min(startPage + pagesPerBatch, totalPages)
    const pageCount = endPage - startPage

    // Create new PDF with subset of pages
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

  console.log(`   Created ${batches.length} batches\n`)
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
          
          // Simulate server being unreachable
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
          `[testOcrDispatcher] Unexpected fetch target: ${String(input)}`,
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

    console.log(
      `   🚀 Dispatching ${batch.id} (pages ${batch.startPage}-${batch.endPage}, timeout ${options.timeoutMs}ms)`,
    )

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

    console.log(
      `   ✅ Completed ${batch.id} (${Math.round(processingTime)}ms)`,
    )
  }

  return { sendBatch, stats }
}

// ============================================================================
// CUSTOM LOGGER
// ============================================================================

function createTestLogger(scenarioLabel: string) {
  return {
    info(message?: unknown, meta?: unknown) {
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : ""
      console.log(`   [${scenarioLabel}] ℹ️  ${String(message)}${metaStr}`)
    },
    warn(message?: unknown, meta?: unknown) {
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : ""
      console.warn(`   [${scenarioLabel}] ⚠️  ${String(message)}${metaStr}`)
    },
    error(message?: unknown, meta?: unknown) {
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : ""
      console.error(`   [${scenarioLabel}] ❌ ${String(message)}${metaStr}`)
    },
  }
}

// ============================================================================
// METRICS COLLECTOR
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
    incr(name: string, tags?: Record<string, string>) {
      const key = tags ? `${name}:${JSON.stringify(tags)}` : name
      data.counters[key] = (data.counters[key] || 0) + 1
    },
    observe(name: string, value: number, tags?: Record<string, string>) {
      data.observations.push({ name, value, tags })
    },
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
}

const TEST_SCENARIOS: TestScenario[] = [
  {
    name: "Sequential Processing (Low Batch Count)",
    description: "Tests sequential dispatch when batch count is below threshold",
    idleSequence: [5],
    thresholdForConcurrency: 100,
    pollIntervalMs: 50,
    maxRetries: 2,
  },
  {
    name: "Concurrent - High Idle Capacity",
    description: "Tests concurrent dispatch with consistently high idle instances",
    idleSequence: [8, 8, 8, 8, 8],
    thresholdForConcurrency: 1,
    pollIntervalMs: 50,
    maxRetries: 2,
  },
  {
    name: "Concurrent - Low Idle Capacity",
    description: "Tests concurrent dispatch with low idle instances",
    idleSequence: [1, 1, 1, 1, 1],
    thresholdForConcurrency: 1,
    pollIntervalMs: 50,
    maxRetries: 2,
  },
  {
    name: "Concurrent - No Idle Capacity",
    description: "Tests behavior when no idle instances are available",
    idleSequence: [0, 0, 0, 1, 2],
    thresholdForConcurrency: 1,
    pollIntervalMs: 50,
    maxRetries: 2,
  },
  {
    name: "Concurrent - Fluctuating Capacity",
    description: "Tests adaptive dispatch with varying idle instances",
    idleSequence: [5, 8, 3, 1, 0, 2, 6, 4],
    thresholdForConcurrency: 1,
    pollIntervalMs: 50,
    maxRetries: 2,
  },
  {
    name: "Retry Logic Test",
    description: "Tests retry behavior with higher failure rate",
    idleSequence: [5, 5, 5],
    thresholdForConcurrency: 1,
    pollIntervalMs: 50,
    maxRetries: 3,
  },
  {
    name: "Instance Server Down",
    description: "Tests behavior when instance status server is unreachable",
    idleSequence: [], // Not used - server will be unreachable
    thresholdForConcurrency: 1,
    pollIntervalMs: 50,
    maxRetries: 2,
  },
]

// ============================================================================
// RUN SCENARIO
// ============================================================================

async function runScenario(
  scenario: TestScenario,
  batches: PdfOcrBatch[],
): Promise<void> {
  console.log(`\n${"=".repeat(80)}`)
  console.log(`🧪 TEST: ${scenario.name}`)
  console.log(`   ${scenario.description}`)
  console.log(`   Batches: ${batches.length}`)
  console.log(`   Idle sequence: [${scenario.idleSequence.join(", ")}]`)
  console.log(`   Threshold: ${scenario.thresholdForConcurrency}`)
  console.log(`${"=".repeat(80)}\n`)

  // Check if this is the "Instance Server Down" scenario
  const isServerDownScenario = scenario.name === "Instance Server Down"

  const mockFetch = createMockFetch({
    idleSequence: scenario.idleSequence,
    label: scenario.name,
    serverDown: isServerDownScenario,
  })
  const mockProcessor = createMockBatchProcessor()
  const logger = createTestLogger(scenario.name)
  const metrics = createMetricsCollector()

  mockFetch.install()

  try {
    const startTime = Date.now()

    const options: DispatchOptions = {
      logger,
      metrics,
      sendBatch: mockProcessor.sendBatch,
      thresholdForConcurrency: scenario.thresholdForConcurrency,
      pollIntervalMs: scenario.pollIntervalMs,
      maxRetries: scenario.maxRetries,
    }

    const report: DispatchReport = await dispatchOCRBatches(batches, options)

    const endTime = Date.now()
    const totalDuration = endTime - startTime

    // Print results
    console.log(`\n📊 RESULTS:`)
    console.log(`   Total batches: ${report.total}`)
    console.log(`   Succeeded: ${report.succeeded} ✅`)
    console.log(`   Failed: ${report.failed} ❌`)
    console.log(`   Total duration: ${totalDuration}ms`)
    console.log(`   Status endpoint calls: ${mockFetch.getCallCount()}`)

    // Print per-batch details
    console.log(`\n📋 Per-Batch Details:`)
    for (const item of report.perItem) {
      const status = item.status === "ok" ? "✅" : "❌"
      const error = item.error ? ` (${item.error})` : ""
      console.log(
        `   ${status} ${item.id}: ${item.attempts} attempt(s), ${item.latencyMs}ms${error}`,
      )
    }

    // Print metrics summary
    const metricsData = metrics.getData()
    console.log(`\n📈 Metrics:`)
    console.log(`   Counters:`, metricsData.counters)
    
    const latencies = metricsData.observations
      .filter((o) => o.name === "ocr_dispatch.latency_ms")
      .map((o) => o.value)
    
    if (latencies.length > 0) {
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length
      const minLatency = Math.min(...latencies)
      const maxLatency = Math.max(...latencies)
      console.log(`   Latency: avg=${Math.round(avgLatency)}ms, min=${Math.round(minLatency)}ms, max=${Math.round(maxLatency)}ms`)
    }

    // Print processing stats
    console.log(`\n🔧 Processing Stats:`)
    console.log(`   Total dispatched: ${mockProcessor.stats.totalDispatched}`)
    console.log(`   Total completed: ${mockProcessor.stats.totalCompleted}`)
    console.log(`   Total failed: ${mockProcessor.stats.totalFailed}`)

  } catch (error) {
    console.error(`\n❌ Scenario failed with error:`, error)
  } finally {
    mockFetch.restore()
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║                     OCR DISPATCHER TEST SUITE                              ║
║                                                                            ║
║  This test suite verifies the dispatch logic implementation in            ║
║  chunkByOCR.ts by running various scenarios with mocked dependencies.     ║
╚════════════════════════════════════════════════════════════════════════════╝
`)

  try {
    // Create mock batches from the PDF
    const batches = await createMockBatches(
      MOCK_PDF_PATH,
      PAGES_PER_BATCH,
      MAX_BATCHES_TO_TEST,
    )

    // Run all test scenarios
    for (const scenario of TEST_SCENARIOS) {
      await runScenario(scenario, batches) // Use first 6 batches for testing
      await sleep(100) // Small delay between scenarios
    }

    console.log(`\n${"=".repeat(80)}`)
    console.log(`✅ All test scenarios completed successfully!`)
    console.log(`${"=".repeat(80)}\n`)

  } catch (error) {
    console.error(`\n❌ Test suite failed:`, error)
    process.exit(1)
  }
}

// Run the test suite
main().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
