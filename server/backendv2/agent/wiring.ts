// Composition root. Reads `AGENT_STORAGE` and assembles concrete strategies.
//
// Each strategy axis can be flipped independently as durable implementations
// land — e.g. `AGENT_STORAGE_MSGS=postgres AGENT_STORAGE_STREAM=redis`.

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type {
  BlobStore,
  ConversationRepo,
  MessageFeedbackRepo,
  MessageRepo,
  StreamBus,
  UnitOfWork,
} from "./storage/types"
import {
  InMemoryBlobStore,
  InMemoryConversationRepo,
  InMemoryMessageFeedbackRepo,
  InMemoryMessageRepo,
  InMemoryStreamBus,
  InMemoryUnitOfWork,
} from "./storage/inMemory"
import {
  PostgresConversationRepo,
  PostgresMessageFeedbackRepo,
  PostgresMessageRepo,
  PostgresUnitOfWork,
} from "./storage/postgres"

const Logger = getLogger(Subsystem.Api).child({ module: "agent/wiring" })

export type AgentDeps = {
  convs: ConversationRepo
  msgs: MessageRepo
  feedback: MessageFeedbackRepo
  stream: StreamBus
  blobs: BlobStore
  uow: UnitOfWork
}

const memoryDeps = (): AgentDeps => ({
  convs: new InMemoryConversationRepo(),
  msgs: new InMemoryMessageRepo(),
  feedback: new InMemoryMessageFeedbackRepo(),
  stream: new InMemoryStreamBus(),
  blobs: new InMemoryBlobStore(),
  uow: new InMemoryUnitOfWork(),
})

const postgresDeps = (): AgentDeps => ({
  convs: new PostgresConversationRepo(),
  msgs: new PostgresMessageRepo(),
  feedback: new PostgresMessageFeedbackRepo(),
  stream: new InMemoryStreamBus(),
  blobs: new InMemoryBlobStore(),
  uow: new PostgresUnitOfWork(),
})

export function buildAgentDeps(): AgentDeps {
  const driver = process.env["AGENT_STORAGE"] ?? "postgres"
  switch (driver) {
    case "memory":
      Logger.info("AgentDeps: in-memory storage")
      return memoryDeps()
    case "postgres":
      Logger.info("AgentDeps: postgres storage")
      return postgresDeps()
    default:
      Logger.warn(
        { driver },
        "Unknown AGENT_STORAGE value — falling back to postgres",
      )
      return postgresDeps()
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
