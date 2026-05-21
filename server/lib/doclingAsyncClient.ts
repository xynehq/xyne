import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "doclingAsyncClient",
})

type BunFetchInit = Omit<RequestInit, "timeout"> & {
  timeout?: false | number
}

export type SubmitDoclingAsyncJobInput = {
  buffer: Buffer
  fileName: string
  jobId: string
  fileId: string
  docId: string
  vespaDocId: string
}

const parsePositiveInteger = (
  value: string | undefined,
  fallback: number,
): number => {
  const parsed = Number.parseInt(value || "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const retryAfterMs = (response: Response): number | null => {
  const retryAfter = response.headers.get("retry-after")
  if (!retryAfter) {
    return null
  }

  const seconds = Number.parseInt(retryAfter, 10)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000
  }

  const retryAt = Date.parse(retryAfter)
  if (Number.isFinite(retryAt)) {
    return Math.max(retryAt - Date.now(), 0)
  }

  return null
}

const SUBMIT_RETRIES = parsePositiveInteger(
  process.env.DOCLING_ASYNC_SUBMIT_RETRIES,
  5,
)
const SUBMIT_RETRY_DELAY_MS = parsePositiveInteger(
  process.env.DOCLING_ASYNC_SUBMIT_RETRY_DELAY_MS,
  1000,
)
const SUBMIT_TIMEOUT_MS = parsePositiveInteger(
  process.env.DOCLING_ASYNC_SUBMIT_TIMEOUT_MS,
  120000,
)

export const submitDoclingAsyncJob = async (
  input: SubmitDoclingAsyncJobInput,
) => {
  const baseUrl = config.doclingServiceUrl.replace(/\/+$/, "")
  const apiUrl = `${baseUrl}/process_async`
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= SUBMIT_RETRIES; attempt++) {
    let submitTimer: ReturnType<typeof setTimeout> | null = null
    const formData = new FormData()
    const blob = new Blob([input.buffer as unknown as BlobPart], {
      type: "application/pdf",
    })

    formData.append("file", blob, input.fileName)
    formData.append("job_id", input.jobId)
    formData.append("file_id", input.fileId)
    formData.append("doc_id", input.docId)
    formData.append("vespa_doc_id", input.vespaDocId)

    try {
      Logger.info(
        {
          jobId: input.jobId,
          fileId: input.fileId,
          docId: input.docId,
          vespaDocId: input.vespaDocId,
          fileName: input.fileName,
          fileSizeBytes: input.buffer.length,
          attempt,
          submitRetries: SUBMIT_RETRIES,
          apiUrl,
        },
        "Submitting async Docling job",
      )

      const controller = new AbortController()
      submitTimer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS)
      const fetchOptions: BunFetchInit = {
        method: "POST",
        body: formData,
        signal: controller.signal,
        timeout: false,
      }
      const response = await fetch(apiUrl, fetchOptions as RequestInit)
      clearTimeout(submitTimer)
      submitTimer = null

      if (response.ok) {
        return await response.json().catch(() => ({
          status: "accepted",
          job_id: input.jobId,
        }))
      }

      const body = await response.text().catch(() => "")
      const retriable = response.status === 429 || response.status >= 500
      const retryDelayMs =
        response.status === 429
          ? (retryAfterMs(response) ?? SUBMIT_RETRY_DELAY_MS * attempt)
          : SUBMIT_RETRY_DELAY_MS * attempt
      lastError = new Error(
        `Docling async submit failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`,
      )

      if (!retriable || attempt === SUBMIT_RETRIES) {
        throw lastError
      }

      Logger.warn(
        {
          jobId: input.jobId,
          fileId: input.fileId,
          status: response.status,
          attempt,
          retryDelayMs,
          error: lastError.message,
        },
        "Async Docling submit rejected; retrying",
      )
      await sleep(retryDelayMs)
    } catch (error) {
      if (submitTimer) {
        clearTimeout(submitTimer)
        submitTimer = null
      }
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt === SUBMIT_RETRIES) {
        break
      }

      Logger.warn(
        {
          jobId: input.jobId,
          fileId: input.fileId,
          attempt,
          error: lastError.message,
        },
        "Async Docling submit failed; retrying",
      )
      await sleep(SUBMIT_RETRY_DELAY_MS * attempt)
    }
  }

  throw lastError || new Error("Unknown async Docling submit failure")
}
