import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import PgBoss from "pg-boss"
import postgres from "postgres"
import { adminActor } from "./syncControlTestHelpers"

const enabled = process.env.RUN_SYNC_CONTROL_INTEGRATION === "1"
const integrationTest = enabled ? test : test.skip
const databaseUrl = process.env.DATABASE_URL

let sql: postgres.Sql
let boss: PgBoss
let queueStore: typeof import("@/sync-control/queueStore")
let closeDbClient: (() => Promise<void>) | undefined

const queues = [
  "sync-SaaS-service_account-per-user",
  "sync-zoho-desk-oauth",
  "file-processing",
]

const seedJob = async (
  queueName: string,
  state: string,
  data: Record<string, unknown>,
) => {
  const id = await boss.send(queueName, data, { retryLimit: 0 })
  await sql`
    UPDATE pgboss.job
    SET
      state = ${state}::pgboss.job_state,
      started_on = CASE
        WHEN ${state} = 'active' THEN NOW()
        ELSE NULL
      END,
      completed_on = CASE
        WHEN ${state} IN ('completed', 'cancelled', 'failed') THEN NOW()
        ELSE NULL
      END
    WHERE id = ${id}::uuid
  `
  return id as string
}

beforeAll(async () => {
  if (!enabled) return
  if (!databaseUrl) throw new Error("DATABASE_URL is required")

  sql = postgres(databaseUrl)
  boss = new PgBoss({ connectionString: databaseUrl })
  await boss.start()
  for (const queueName of queues) {
    await boss.createQueue(queueName)
  }

  await sql`
    CREATE TABLE IF NOT EXISTS sync_jobs (
      email text NOT NULL,
      workspace_id integer NOT NULL
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS connectors (
      id integer PRIMARY KEY,
      workspace_id integer NOT NULL
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS collection_items (
      id uuid PRIMARY KEY,
      collection_id uuid NOT NULL,
      uploaded_by_email text,
      workspace_id integer NOT NULL
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS collections (
      id uuid PRIMARY KEY,
      workspace_id integer NOT NULL
    )
  `

  queueStore = await import("@/sync-control/queueStore")
  closeDbClient = (await import("@/db/client")).closeDbClient
})

beforeEach(async () => {
  if (!enabled) return
  await sql`DELETE FROM pgboss.job`
  await sql`DELETE FROM sync_jobs`
  await sql`DELETE FROM connectors`
  await sql`DELETE FROM collection_items`
  await sql`DELETE FROM collections`
})

afterAll(async () => {
  if (!enabled) return
  await boss.stop()
  await closeDbClient?.()
  await sql.end()
})

describe("sync control pg-boss integration", () => {
  integrationTest("counts exact pg-boss states with direct SQL", async () => {
    const queueName = "sync-SaaS-service_account-per-user"
    for (const state of [
      "created",
      "retry",
      "active",
      "completed",
      "cancelled",
      "failed",
    ]) {
      await seedJob(queueName, state, { email: `${state}@example.com` })
    }

    const counts = await queueStore.getQueueStateCounts(queueName)

    expect(
      Object.fromEntries(counts.map((row) => [row.state, row.count])),
    ).toEqual({
      active: 1,
      cancelled: 1,
      completed: 1,
      created: 1,
      failed: 1,
      retry: 1,
    })
  })

  integrationTest(
    "enforces workspace isolation for per-user queue jobs",
    async () => {
      await sql`
      INSERT INTO sync_jobs (email, workspace_id)
      VALUES ('inside@example.com', 10), ('outside@example.com', 20)
    `
      await seedJob("sync-SaaS-service_account-per-user", "created", {
        email: "inside@example.com",
        workspaceId: 10,
      })
      await seedJob("sync-SaaS-service_account-per-user", "created", {
        email: "outside@example.com",
        workspaceId: 20,
      })

      const jobs = await queueStore.listJobs({
        queueName: "sync-SaaS-service_account-per-user",
        actor: adminActor,
      })

      expect(jobs.map((job) => (job.data as any).email)).toEqual([
        "inside@example.com",
      ])
    },
  )

  integrationTest(
    "enforces workspace isolation for connector queues",
    async () => {
      await sql`
      INSERT INTO connectors (id, workspace_id)
      VALUES (101, 10), (202, 20)
    `
      await seedJob("sync-zoho-desk-oauth", "created", { connectorId: 101 })
      await seedJob("sync-zoho-desk-oauth", "created", { connectorId: 202 })

      const jobs = await queueStore.listJobs({
        queueName: "sync-zoho-desk-oauth",
        actor: adminActor,
      })

      expect(jobs.map((job) => (job.data as any).connectorId)).toEqual([101])
    },
  )

  integrationTest(
    "enforces workspace isolation for KB file queues",
    async () => {
      const insideFileId = "00000000-0000-0000-0000-000000000001"
      const outsideFileId = "00000000-0000-0000-0000-000000000002"
      await sql`
      INSERT INTO collection_items
        (id, collection_id, uploaded_by_email, workspace_id)
      VALUES
        (${insideFileId}::uuid, '10000000-0000-0000-0000-000000000001'::uuid, 'inside@example.com', 10),
        (${outsideFileId}::uuid, '20000000-0000-0000-0000-000000000002'::uuid, 'outside@example.com', 20)
    `
      await seedJob("file-processing", "created", { fileId: insideFileId })
      await seedJob("file-processing", "created", { fileId: outsideFileId })

      const jobs = await queueStore.listJobs({
        queueName: "file-processing",
        actor: adminActor,
      })

      expect(jobs.map((job) => (job.data as any).fileId)).toEqual([
        insideFileId,
      ])
    },
  )

  integrationTest(
    "defers an active job by updating the existing row only",
    async () => {
      const queueName = "sync-SaaS-service_account-per-user"
      const jobData = { email: "paused@example.com", marker: "same-row" }
      const jobId = await seedJob(queueName, "active", jobData)

      const deferred = await queueStore.deferActiveJob({
        queueName,
        jobId,
        delaySeconds: 120,
        reason: "paused by integration test",
      })
      const rows = await sql`
      SELECT id::text, state::text, data, started_on, start_after
      FROM pgboss.job
      WHERE name = ${queueName}
        AND data->>'marker' = 'same-row'
    `

      expect(deferred).toBe(true)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        id: jobId,
        state: "created",
        data: jobData,
        started_on: null,
      })
      expect(new Date(rows[0].start_after).getTime()).toBeGreaterThan(
        Date.now(),
      )
    },
  )
})
