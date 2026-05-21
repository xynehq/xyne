import { randomUUID } from "node:crypto"
import { getRedisClient } from "@/lib/redisClient"

const PERMIT_PREFIX = "docling:scheduler:permit"

const ACQUIRE_SCRIPT = `
local active_key = KEYS[1]
local meta_key = KEYS[2]
local now_ms = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local expires_at_ms = tonumber(ARGV[3])
local ttl_ms = tonumber(ARGV[4])
local permit_id = ARGV[5]

redis.call("ZREMRANGEBYSCORE", active_key, "-inf", now_ms)

if redis.call("ZCARD", active_key) >= capacity then
  return 0
end

redis.call("ZADD", active_key, expires_at_ms, permit_id)
redis.call("HSET", meta_key, "permitId", permit_id, "kind", ARGV[6], "owner", ARGV[7], "createdAt", ARGV[8], "expiresAt", ARGV[3], "metadata", ARGV[9])
redis.call("PEXPIRE", meta_key, ttl_ms)
return 1
`

const RELEASE_SCRIPT = `
local removed = redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("DEL", KEYS[2])
return removed
`

export type DoclingSchedulerPermit = {
  kind: string
  permitId: string
}

const activeKey = (kind: string) => `${PERMIT_PREFIX}:${kind}:active`
const metaKey = (kind: string, permitId: string) =>
  `${PERMIT_PREFIX}:${kind}:${permitId}`

export const tryAcquireDoclingSchedulerPermit = async (input: {
  kind: string
  capacity: number
  ttlMs: number
  owner: string
  metadata?: Record<string, unknown>
}): Promise<DoclingSchedulerPermit | null> => {
  if (input.capacity <= 0) {
    return {
      kind: input.kind,
      permitId: `disabled:${input.kind}:${randomUUID()}`,
    }
  }

  const now = Date.now()
  const permitId = randomUUID()
  const redis = await getRedisClient()
  const acquired = await redis.sendCommand([
    "EVAL",
    ACQUIRE_SCRIPT,
    "2",
    activeKey(input.kind),
    metaKey(input.kind, permitId),
    String(now),
    String(input.capacity),
    String(now + input.ttlMs),
    String(input.ttlMs),
    permitId,
    input.kind,
    input.owner,
    new Date(now).toISOString(),
    JSON.stringify(input.metadata || {}),
  ])

  return Number(acquired) > 0 ? { kind: input.kind, permitId } : null
}

export const releaseDoclingSchedulerPermit = async (
  permit: DoclingSchedulerPermit | { kind: string; permitId?: string | null },
) => {
  if (!permit.permitId || permit.permitId.startsWith("disabled:")) {
    return
  }

  const redis = await getRedisClient()
  await redis.sendCommand([
    "EVAL",
    RELEASE_SCRIPT,
    "2",
    activeKey(permit.kind),
    metaKey(permit.kind, permit.permitId),
    permit.permitId,
  ])
}
