import config from "@/config"
import { getRedisClient } from "@/lib/redisClient"

const FILE_PREFIX = "docling:async:file"

export type DoclingAsyncFileState = {
  fileId: string
  vespaDocId: string
  runId: string
  splitFingerprint: string
  fileName: string
  collectionId: string
  collectionName: string
  parentId: string
  path: string
  storagePath: string
  mimeType: string
  baseMimeType: string
  fileSize: string
  originalName: string
  uploadedByEmail: string
  metadataJson: string
  pageTitle: string
  totalPages: string
  totalParts: string
  pageChunkSize: string
  stageDir: string
  partsDir: string
  nextPartToApply: string
  nextPartToSubmit: string
  textChunksCount: string
  imageChunksCount: string
  tocChunksCount: string
  status: "submitting" | "submitted" | "applying" | "completed" | "failed"
  initialVespaInserted: "true" | "false"
  createdAt: string
  updatedAt: string
}

export type DoclingAsyncPartState = {
  fileId: string
  vespaDocId: string
  runId: string
  splitFingerprint: string
  jobId: string
  docId: string
  partIndex: string
  startPage: string
  endPage: string
  totalPages: string
  totalParts: string
  fileName: string
  partPath: string
  partSizeBytes: string
  status:
    | "queued"
    | "pending"
    | "submitted"
    | "ready"
    | "applying"
    | "applied"
    | "completed"
    | "failed"
  resultKey: string
  eventId: string
  error: string
  submitCount: string
  createdAt: string
  updatedAt: string
  appliedAt: string
}

export const doclingAsyncFileKey = (fileId: string) =>
  `${FILE_PREFIX}:${fileId}`

export const doclingAsyncPartKey = (fileId: string, partIndex: number) =>
  `${doclingAsyncFileKey(fileId)}:part:${partIndex}`

export const doclingAsyncPartResultKey = (fileId: string, partIndex: number) =>
  `${doclingAsyncPartKey(fileId, partIndex)}:result`

export const doclingAsyncApplyLockKey = (fileId: string) =>
  `${doclingAsyncFileKey(fileId)}:apply-lock`

export const nullableFromRedis = (value?: string | null) =>
  value && value.length > 0 ? value : null

export const numberFromRedis = (
  value: string | undefined,
  fallback = 0,
): number => {
  const parsed = Number.parseInt(value || "", 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const parseJsonFromRedis = <T>(
  value: string | undefined,
  fallback: T,
): T => {
  if (!value) {
    return fallback
  }

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export const expireDoclingAsyncKeys = async (
  fileId: string,
  totalParts: number,
) => {
  const redis = await getRedisClient()
  const ttl = config.doclingAsyncStateTtlSeconds
  const keys = [doclingAsyncFileKey(fileId)]

  for (let partIndex = 0; partIndex < totalParts; partIndex++) {
    keys.push(doclingAsyncPartKey(fileId, partIndex))
    keys.push(doclingAsyncPartResultKey(fileId, partIndex))
  }

  await Promise.all(keys.map((key) => redis.expire(key, ttl)))
}

export const getDoclingAsyncFileState = async (
  fileId: string,
): Promise<Partial<DoclingAsyncFileState> | null> => {
  const redis = await getRedisClient()
  const state = (await redis.hGetAll(
    doclingAsyncFileKey(fileId),
  )) as Partial<DoclingAsyncFileState>
  return Object.keys(state).length > 0 ? state : null
}

export const setDoclingAsyncFileState = async (
  state: DoclingAsyncFileState,
) => {
  const redis = await getRedisClient()
  await redis.hSet(doclingAsyncFileKey(state.fileId), state)
  await redis.expire(
    doclingAsyncFileKey(state.fileId),
    config.doclingAsyncStateTtlSeconds,
  )
}

export const patchDoclingAsyncFileState = async (
  fileId: string,
  updates: Partial<DoclingAsyncFileState>,
) => {
  const redis = await getRedisClient()
  await redis.hSet(doclingAsyncFileKey(fileId), {
    ...updates,
    updatedAt: new Date().toISOString(),
  })
  await redis.expire(
    doclingAsyncFileKey(fileId),
    config.doclingAsyncStateTtlSeconds,
  )
}

export const getDoclingAsyncPartState = async (
  fileId: string,
  partIndex: number,
): Promise<Partial<DoclingAsyncPartState> | null> => {
  const redis = await getRedisClient()
  const state = (await redis.hGetAll(
    doclingAsyncPartKey(fileId, partIndex),
  )) as Partial<DoclingAsyncPartState>
  return Object.keys(state).length > 0 ? state : null
}

export const patchDoclingAsyncPartState = async (
  fileId: string,
  partIndex: number,
  updates: Partial<DoclingAsyncPartState>,
) => {
  const redis = await getRedisClient()
  await redis.hSet(doclingAsyncPartKey(fileId, partIndex), {
    ...updates,
    updatedAt: new Date().toISOString(),
  })
  await redis.expire(
    doclingAsyncPartKey(fileId, partIndex),
    config.doclingAsyncStateTtlSeconds,
  )
}

export const putDoclingAsyncPartResult = async (
  fileId: string,
  partIndex: number,
  result: unknown,
) => {
  const redis = await getRedisClient()
  await redis.set(
    doclingAsyncPartResultKey(fileId, partIndex),
    JSON.stringify(result),
    {
      EX: config.doclingAsyncStateTtlSeconds,
    },
  )
}

export const getDoclingAsyncPartResult = async <T>(
  fileId: string,
  partIndex: number,
): Promise<T | null> => {
  const redis = await getRedisClient()
  const payload = await redis.get(doclingAsyncPartResultKey(fileId, partIndex))
  return payload ? (JSON.parse(payload) as T) : null
}

export const deleteDoclingAsyncPartResult = async (
  fileId: string,
  partIndex: number,
) => {
  const redis = await getRedisClient()
  await redis.del(doclingAsyncPartResultKey(fileId, partIndex))
}

export const deleteDoclingAsyncPartState = async (
  fileId: string,
  partIndex: number,
) => {
  const redis = await getRedisClient()
  await redis.del([
    doclingAsyncPartKey(fileId, partIndex),
    doclingAsyncPartResultKey(fileId, partIndex),
  ])
}

export const listDoclingAsyncPartIndexes = async (
  fileId: string,
): Promise<number[]> => {
  const redis = await getRedisClient()
  const match = `${doclingAsyncFileKey(fileId)}:part:*`
  const indexes = new Set<number>()
  let cursor = "0"

  do {
    const response = (await redis.sendCommand([
      "SCAN",
      cursor,
      "MATCH",
      match,
      "COUNT",
      "100",
    ])) as [string, string[]]
    cursor = response[0]
    const keys = response[1] || []

    for (const key of keys) {
      const matched = key.match(/:part:(\d+)$/)
      if (!matched) {
        continue
      }
      indexes.add(Number.parseInt(matched[1] || "", 10))
    }
  } while (cursor !== "0")

  return [...indexes].sort((left, right) => left - right)
}
