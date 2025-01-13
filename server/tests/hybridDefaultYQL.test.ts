import { Apps, DriveEntity } from "@/search/types"
import { HybridDefaultProfile } from "@/search/vespa"
import { expect, test, describe } from "bun:test"

describe("HybridDefaultProfile", () => {
  test("basic query without optional parameters", () => {
    const result = HybridDefaultProfile(10, null, null)
    expect(result.profile).toBe("default")
    expect(result.yql).toContain("{targetHits:10}")
    expect(result.yql).toContain("permissions contains @email")
    expect(result.yql).toContain(`and app contains "${Apps.GoogleWorkspace}"`)

    expect(result.yql).not.toContain("entity contains")
    expect(result.yql).not.toContain("!(docId contains")
    expect(result.yql).not.toContain("!(labels contains",)
  })

  test("query with app filter", () => {
    const result = HybridDefaultProfile(5, Apps.Gmail, null)
    expect(result.yql).toContain("app contains @app")
    expect(result.yql).not.toContain("entity contains")
  })

  test("query with entity filter", () => {
    const result = HybridDefaultProfile(5, null, DriveEntity.Docs)
    expect(result.yql).toContain("entity contains @entity")
    expect(result.yql).not.toContain("app contains")
  })

  test("query with timestamp range", () => {
    const timestampRange = { from: 1000, to: 2000 }
    const result = HybridDefaultProfile(
      5,
      null,
      null,
      "default",
      timestampRange,
    )
    expect(result.yql).toContain("updatedAt >= 1000 and updatedAt <= 2000")
    expect(result.yql).toContain("timestamp >= 1000 and timestamp <= 2000")
    expect(result.yql).toContain(
      "creationTime >= 1000 and creationTime <= 2000",
    )
    expect(result.yql).toContain("startTime >= 1000 and startTime <= 2000")
  })

  test("query with only 'from' in timestamp range", () => {
    const timestampRange = { from: 1000, to: null }
    const result = HybridDefaultProfile(
      5,
      null,
      null,
      "default",
      timestampRange,
    )
    expect(result.yql).not.toContain("updatedAt <= 1000")

    expect(result.yql).toContain("updatedAt >= 1000")
    expect(result.yql).toContain("timestamp >= 1000")
    expect(result.yql).toContain("creationTime >= 1000")
    expect(result.yql).toContain("startTime >= 1000")
  })

  test("query with only 'to' in timestamp range", () => {
    const timestampRange = { from: null, to: 1000 }
    const result = HybridDefaultProfile(
      5,
      null,
      null,
      "default",
      timestampRange,
    )
    expect(result.yql).not.toContain("updatedAt >= 1000")

    expect(result.yql).toContain("updatedAt <= 1000")
    expect(result.yql).toContain("timestamp <= 1000")
    expect(result.yql).toContain("creationTime <= 1000")
    expect(result.yql).toContain("startTime <= 1000")
  })

  test("query with excluded IDs", () => {
    const excludedIds = ["id1", "id2"]
    const result = HybridDefaultProfile(
      5,
      null,
      null,
      "default",
      null,
      excludedIds,
    )
    expect(result.yql).toContain(
      "!(docId contains 'id1' or docId contains 'id2')",
    )
  })

  test("query with mail labels exclusion", () => {
    const notInMailLabels = ["SPAM", "TRASH"]
    const result = HybridDefaultProfile(
      5,
      null,
      null,
      "default",
      null,
      [],
      notInMailLabels,
    )
    expect(result.yql).toContain(
      "!(labels contains 'SPAM' or labels contains 'TRASH')",
    )
  })

  test("query with no timerange", () => {
    const invalidTimestampRange = null
    const result = HybridDefaultProfile(
      5,
      null,
      null,
      "default",
      invalidTimestampRange,
    )
    expect(result.yql).not.toContain("updatedAt")
    expect(result.yql).not.toContain("timestamp")
    expect(result.yql).not.toContain("creationTime")
    expect(result.yql).not.toContain("startTime")
  })
  test("complex query with multiple parameters", () => {
    const timestampRange = { from: 1000, to: 2000 }
    const excludedIds = ["id1"]
    const notInMailLabels = ["SPAM"]

    const result = HybridDefaultProfile(
      5,
      Apps.GoogleWorkspace,
      DriveEntity.PDF,
      "default",
      timestampRange,
      excludedIds,
      notInMailLabels,
    )

    expect(result.yql).toContain("app contains @app")
    expect(result.yql).toContain("entity contains @entity")
    expect(result.yql).toContain("!(docId contains 'id1')")
    expect(result.yql).toContain("!(labels contains 'SPAM')")
    expect(result.yql).toContain("updatedAt >= 1000 and updatedAt <= 2000")
  })

  test("query with null timestamp", () => {
    const timestampRange = { from: null, to: null }
    expect(() =>
      HybridDefaultProfile(5, null, null, "default", timestampRange),
    ).toThrow("Invalid timestamp range")
  })
})
