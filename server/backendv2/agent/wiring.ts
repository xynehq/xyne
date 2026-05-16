// Composition root. Reads `AGENT_STORAGE` and assembles concrete strategies.
//
// Each strategy axis can be flipped independently as durable implementations
// land — e.g. `AGENT_STORAGE_MSGS=postgres AGENT_STORAGE_STREAM=redis`.

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type {
  BlobStore,
  ConversationRepo,
  MessageRepo,
  StreamBus,
  UnitOfWork,
} from "./storage/types"
import {
  InMemoryBlobStore,
  InMemoryConversationRepo,
  InMemoryMessageRepo,
  InMemoryStreamBus,
  InMemoryUnitOfWork,
} from "./storage/inMemory"

const Logger = getLogger(Subsystem.Api).child({ module: "agent/wiring" })

export type AgentDeps = {
  convs: ConversationRepo
  msgs: MessageRepo
  stream: StreamBus
  blobs: BlobStore
  uow: UnitOfWork
}

const memoryDeps = (): AgentDeps => ({
  convs: new InMemoryConversationRepo(),
  msgs: new InMemoryMessageRepo(),
  stream: new InMemoryStreamBus(),
  blobs: new InMemoryBlobStore(),
  uow: new InMemoryUnitOfWork(),
})

export function buildAgentDeps(): AgentDeps {
  const driver = process.env["AGENT_STORAGE"] ?? "memory"
  switch (driver) {
    case "memory":
      Logger.info("AgentDeps: in-memory storage")
      return memoryDeps()
    // case "postgres": …  ← lands here when PostgresMessageRepo/etc. exist
    default:
      Logger.warn(
        { driver },
        "Unknown AGENT_STORAGE value — falling back to memory",
      )
      return memoryDeps()
  }
}

// Singleton so the rest of the app shares the same in-memory state across
// requests within a process. Postgres/Redis impls are stateless so the
// singleton is harmless there too.
let cached: AgentDeps | null = null

export function agentDeps(): AgentDeps {
  if (!cached) {
    cached = buildAgentDeps()
  }
  return cached
}
