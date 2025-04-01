import { loadConnectorState, saveConnectorState } from "@/db/connector"
import type { IngestionStateUnion } from "@/db/schema"
import type { TxnOrClient } from "@/types"
import { Mutex } from "async-mutex"

export class IngestionState<T extends IngestionStateUnion> {
  private state: T
  private connectorId: number
  private workspaceId: number
  private userId: number
  private db: TxnOrClient
  private lock: Mutex
  // private saveIntervalMs: number;
  // private timer: NodeJS.Timeout | null = null;

  constructor(
    connectorId: number,
    workspaceId: number,
    userId: number,
    db: TxnOrClient,
    initialState: T,
  ) {
    this.connectorId = connectorId
    this.db = db
    this.workspaceId = workspaceId
    this.userId = userId
    this.state = { ...initialState, lastUpdated: new Date().toISOString() }
    this.lock = new Mutex()
  }

  get(): T {
    return { ...this.state }
  }

  // Update specific fields of the state
  async update(updates: Partial<T>): Promise<void> {
    const release = await this.lock.acquire()
    try {
      this.state = {
        ...this.state,
        ...updates,
        lastUpdated: new Date().toISOString(),
      }
    } finally {
      release()
    }
  }
  // Persist state to database
  async save(): Promise<void> {
    const release = await this.lock.acquire()
    try {
      await saveConnectorState(
        this.db,
        this.connectorId,
        this.workspaceId,
        this.userId,
        this.state,
      )
    } finally {
      release()
    }
  }

  // Load state from database
  async load(): Promise<void> {
    const release = await this.lock.acquire()
    try {
      const loadedState = await loadConnectorState<T>(
        this.db,
        this.connectorId,
        this.workspaceId,
        this.userId,
      )
      if (loadedState) {
        this.state = {
          ...this.state,
          ...loadedState,
          lastUpdated: new Date().toISOString(),
        }
      }
    } finally {
      release()
    }
  }
}
