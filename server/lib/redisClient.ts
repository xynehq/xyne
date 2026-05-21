import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { createClient } from "redis"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "redisClient",
})

type RedisClient = ReturnType<typeof createClient>

let client: RedisClient | null = null
let connectPromise: Promise<RedisClient> | null = null

export const getRedisClient = async (): Promise<RedisClient> => {
  if (client?.isOpen) {
    return client
  }

  if (connectPromise) {
    return connectPromise
  }

  const nextClient = createClient({
    url: config.redisUrl,
  })

  nextClient.on("error", (error) => {
    Logger.error(error, "Redis client error")
  })

  connectPromise = nextClient
    .connect()
    .then(() => {
      client = nextClient
      Logger.info({ redisUrl: config.redisUrl }, "Redis client connected")
      return nextClient
    })
    .finally(() => {
      connectPromise = null
    })

  return connectPromise
}

export const closeRedisClient = async () => {
  if (!client) {
    return
  }

  const current = client
  client = null
  if (current.isOpen) {
    await current.quit()
  }
}
