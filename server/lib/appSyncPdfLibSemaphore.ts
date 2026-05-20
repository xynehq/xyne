import { randomUUID } from "node:crypto"
import {
  isMainThread,
  parentPort,
  threadId,
  workerData,
} from "node:worker_threads"
import { recordWorkerPhase } from "@/lib/appSyncDiagnostics"

export const APP_SYNC_PDF_LIB_PERMIT_REQUEST =
  "app_sync_pdf_lib_permit_request"
export const APP_SYNC_PDF_LIB_PERMIT_GRANTED =
  "app_sync_pdf_lib_permit_granted"
export const APP_SYNC_PDF_LIB_PERMIT_RELEASE =
  "app_sync_pdf_lib_permit_release"
export const APP_SYNC_PDF_LIB_PERMIT_CANCEL =
  "app_sync_pdf_lib_permit_cancel"

type DiagnosticDetails = Record<string, unknown>

export class AppSyncPdfLibSemaphoreTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Timed out waiting ${timeoutMs}ms for app-sync PDF-lib semaphore permit`,
    )
    this.name = "AppSyncPdfLibSemaphoreTimeoutError"
  }
}

export const isAppSyncPdfLibSemaphoreTimeoutError = (
  error: unknown,
): error is AppSyncPdfLibSemaphoreTimeoutError =>
  error instanceof AppSyncPdfLibSemaphoreTimeoutError ||
  (error instanceof Error &&
    error.name === "AppSyncPdfLibSemaphoreTimeoutError")

export type AppSyncPdfLibPermitMessage = {
  type:
    | typeof APP_SYNC_PDF_LIB_PERMIT_REQUEST
    | typeof APP_SYNC_PDF_LIB_PERMIT_GRANTED
    | typeof APP_SYNC_PDF_LIB_PERMIT_RELEASE
    | typeof APP_SYNC_PDF_LIB_PERMIT_CANCEL
  requestId: string
  workerThreadId?: number
  workerType?: string
  workerIndex?: number
  details?: DiagnosticDetails
}

type PendingPermit = {
  resolve: (release: () => void) => void
  timer: ReturnType<typeof setTimeout>
  details: DiagnosticDetails
}

const pendingPermits = new Map<string, PendingPermit>()
let listenerInstalled = false

const parsePositiveInteger = (
  value: string | undefined,
  fallback: number,
): number => {
  const parsed = Number.parseInt(value || "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const getSemaphoreTimeoutMs = () =>
  parsePositiveInteger(process.env.APP_SYNC_PDF_LIB_SEMAPHORE_TIMEOUT_MS, 600000)

const getWorkerIdentity = () => {
  const data = (workerData || {}) as {
    workerType?: string
    workerIndex?: number
  }

  return {
    workerThreadId: threadId,
    workerType: data.workerType,
    workerIndex: data.workerIndex,
  }
}

const isPermitMessage = (
  message: unknown,
): message is AppSyncPdfLibPermitMessage => {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    typeof (message as { type?: unknown }).type === "string" &&
    "requestId" in message &&
    typeof (message as { requestId?: unknown }).requestId === "string"
  )
}

export const isAppSyncPdfLibPermitMessage = isPermitMessage

const ensurePermitListener = () => {
  if (!parentPort || listenerInstalled) return

  listenerInstalled = true
  parentPort.on("message", (message) => {
    if (!isPermitMessage(message)) return
    if (message.type !== APP_SYNC_PDF_LIB_PERMIT_GRANTED) return

    const pending = pendingPermits.get(message.requestId)
    if (!pending) return

    pendingPermits.delete(message.requestId)
    clearTimeout(pending.timer)
    recordWorkerPhase("pdf_lib_permit_granted", {
      requestId: message.requestId,
      ...pending.details,
    })

    let released = false
    pending.resolve(() => {
      if (released) return
      released = true
      recordWorkerPhase("pdf_lib_permit_released", {
        requestId: message.requestId,
        ...pending.details,
      })
      parentPort?.postMessage({
        type: APP_SYNC_PDF_LIB_PERMIT_RELEASE,
        requestId: message.requestId,
        ...getWorkerIdentity(),
        details: pending.details,
      } satisfies AppSyncPdfLibPermitMessage)
    })
  })
}

const acquirePdfLibPermit = async (
  details: DiagnosticDetails,
): Promise<() => void> => {
  if (isMainThread || !parentPort) {
    return () => {}
  }

  ensurePermitListener()

  const requestId = randomUUID()
  const timeoutMs = getSemaphoreTimeoutMs()

  recordWorkerPhase("pdf_lib_permit_waiting", {
    requestId,
    timeoutMs,
    ...details,
  })

  return new Promise<() => void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPermits.delete(requestId)
      recordWorkerPhase("pdf_lib_permit_timeout", {
        requestId,
        timeoutMs,
        ...details,
      })
      parentPort?.postMessage({
        type: APP_SYNC_PDF_LIB_PERMIT_CANCEL,
        requestId,
        ...getWorkerIdentity(),
        details,
      } satisfies AppSyncPdfLibPermitMessage)
      reject(new AppSyncPdfLibSemaphoreTimeoutError(timeoutMs))
    }, timeoutMs)

    pendingPermits.set(requestId, {
      resolve,
      timer,
      details,
    })

    parentPort?.postMessage({
      type: APP_SYNC_PDF_LIB_PERMIT_REQUEST,
      requestId,
      ...getWorkerIdentity(),
      details,
    } satisfies AppSyncPdfLibPermitMessage)
  })
}

export const withAppSyncPdfLibPermit = async <T>(
  details: DiagnosticDetails,
  fn: () => Promise<T>,
): Promise<T> => {
  const release = await acquirePdfLibPermit(details)

  try {
    return await fn()
  } finally {
    release()
  }
}
