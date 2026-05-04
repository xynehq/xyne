import { describe, expect, test } from "bun:test"
import {
  SyncQueueRegistry,
  getQueueDefinition,
  listRegisteredQueues,
  workspaceGuardForQueue,
} from "@/sync-control/registry"
import { adminActor, superAdminActor } from "./syncControlTestHelpers"

describe("sync control registry", () => {
  test("registers every sync-control queue that workers expose", () => {
    expect(Object.keys(SyncQueueRegistry).sort()).toEqual(
      [
        "check-downloads-folder",
        "cleanup-attachments",
        "file-processing",
        "file-processing-pdf",
        "ingestion-SaaS",
        "process-zoho-desk-attachment",
        "process-zoho-desk-ticket",
        "sync-SaaS-oauth",
        "sync-SaaS-service_account",
        "sync-SaaS-service_account-per-user",
        "sync-SaaS-service_account-scheduler",
        "sync-google-workspace-service_account",
        "sync-slack-oauth",
        "sync-slack-oauth-per-user",
        "sync-slack-oauth-scheduler",
        "sync-tools",
        "sync-zoho-desk-oauth",
      ].sort(),
    )
  })

  test("exposes worker groups and queue policies used by worker intake", () => {
    expect(getQueueDefinition("file-processing").workerGroup).toBe(
      "file-processing",
    )
    expect(getQueueDefinition("file-processing-pdf").workerGroup).toBe(
      "pdf-file-processing",
    )
    expect(getQueueDefinition("sync-slack-oauth-per-user").workerGroup).toBe(
      "sync-slack-per-user",
    )
    expect(
      getQueueDefinition("sync-SaaS-service_account-scheduler").pauseBehavior,
    ).toBe("checkpoint_only")
  })

  test("keeps scoped mutations disabled for maintenance queues", () => {
    expect(getQueueDefinition("sync-tools").mutationPolicy.canPauseScoped).toBe(
      false,
    )
    expect(
      getQueueDefinition("cleanup-attachments").mutationPolicy.canPauseScoped,
    ).toBe(false)
    expect(
      getQueueDefinition("check-downloads-folder").mutationPolicy
        .canPauseScoped,
    ).toBe(false)
  })

  test("extracts job identity for supported queue payload shapes", () => {
    expect(
      getQueueDefinition(
        "sync-SaaS-service_account-per-user",
      ).jobIdentityExtractor({
        email: "person@example.com",
        app: "drive",
        authType: "service_account",
      }),
    ).toMatchObject({
      email: "person@example.com",
      app: "drive",
      authType: "service_account",
    })

    expect(
      getQueueDefinition("sync-zoho-desk-oauth").jobIdentityExtractor({
        connectorId: "42",
        email: "owner@example.com",
      }),
    ).toMatchObject({ connectorId: 42, email: "owner@example.com" })

    expect(
      getQueueDefinition("file-processing").jobIdentityExtractor({
        fileId: "file-1",
        collectionId: "collection-1",
        email: "uploader@example.com",
      }),
    ).toMatchObject({
      fileId: "file-1",
      collectionId: "collection-1",
      email: "uploader@example.com",
    })
  })

  test("matches controls only when identity and scope align", () => {
    const definition = getQueueDefinition("sync-SaaS-service_account-per-user")
    const identity = {
      jobId: "job-1",
      queueName: definition.queueName,
      email: "person@example.com",
    }

    expect(
      definition.controlMatcher(
        {
          scopeType: "email",
          scopeValue: "person@example.com",
          queueName: null,
        } as any,
        identity,
        {},
        definition.queueName,
      ),
    ).toBe(true)
    expect(
      definition.controlMatcher(
        {
          scopeType: "job",
          scopeValue: "other-job",
          queueName: null,
        } as any,
        identity,
        {},
        definition.queueName,
      ),
    ).toBe(false)
  })

  test("uses workspace guards for workspace-scoped actors only", () => {
    const perUserDefinition = getQueueDefinition(
      "sync-SaaS-service_account-per-user",
    )
    const globalDefinition = getQueueDefinition("sync-SaaS-service_account")

    expect(
      workspaceGuardForQueue(perUserDefinition, superAdminActor),
    ).toBeNull()
    expect(workspaceGuardForQueue(perUserDefinition, adminActor)).not.toBeNull()
    expect(workspaceGuardForQueue(globalDefinition, adminActor)).not.toBeNull()
  })

  test("listRegisteredQueues returns the registry definitions", () => {
    expect(
      listRegisteredQueues()
        .map((queue) => queue.queueName)
        .sort(),
    ).toEqual(Object.keys(SyncQueueRegistry).sort())
  })
})
