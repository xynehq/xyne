import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Apps, KnowledgeBaseEntity } from "@xyne/vespa-ts/types"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { Subsystem } from "@/types"

const warn = mock(() => {})
const info = mock(() => {})
const error = mock(() => {})
const debug = mock(() => {})

const loggerStub = {
  warn,
  info,
  error,
  debug,
  child: () => loggerStub,
}

mock.module("@/logger", () => ({
  Subsystem,
  getLoggerWithChild: () => () => loggerStub,
  getLogger: () => loggerStub,
}))

const { checkAndYieldCitationsForAgent } = await import("@/api/chat/utils")

const fragment: MinimalAgentFragment = {
  id: "doc-1",
  content:
    "Source: Knowledge Base\nFile: Runbook.md\nContent: [4] Visible chunk.\n[7] Another chunk.",
  confidence: 0.9,
  source: {
    docId: "doc-1",
    title: "Doc 1",
    url: "https://example.com/doc-1",
    app: Apps.KnowledgeBase,
    entity: KnowledgeBaseEntity.File,
    itemId: "item-1",
    clId: "cl-1",
  },
}

describe("message-agents citation logging", () => {
  beforeEach(() => {
    warn.mockClear()
    info.mockClear()
    error.mockClear()
    debug.mockClear()
  })

  test("logs a malformed KB chunk citation only once across repeated streaming rescans", async () => {
    const yieldedCitations = new Set<number>()

    for await (const _event of checkAndYieldCitationsForAgent(
      "This cites a missing chunk K[1_999].",
      yieldedCitations,
      [fragment],
      new Map(),
      "tester@example.com",
    )) {
      // No-op: this test only cares about warning deduplication.
    }

    for await (const _event of checkAndYieldCitationsForAgent(
      "This cites a missing chunk K[1_999]. Additional streamed text arrives later.",
      yieldedCitations,
      [fragment],
      new Map(),
      "tester@example.com",
    )) {
      // No-op: this test only cares about warning deduplication.
    }

    const missingChunkWarnings = warn.mock.calls.filter((call) =>
      String((call as readonly unknown[])[0] ?? "").includes(
        "Dropping KB chunk citation with missing chunk marker",
      ),
    )

    expect(missingChunkWarnings).toHaveLength(1)
    expect(
      String((missingChunkWarnings[0] as readonly unknown[] | undefined)?.[0] ?? ""),
    ).toContain(
      "Dropping KB chunk citation with missing chunk marker",
    )
    expect(
      (missingChunkWarnings[0] as readonly unknown[] | undefined)?.[1],
    ).toMatchObject({
      rawChunkKey: "1_999",
      citationText: "K[1_999]",
    })
    expect(
      String(
        (
          (missingChunkWarnings[0] as readonly unknown[] | undefined)?.[1] as
            | { answerExcerpt?: string }
            | undefined
        )?.answerExcerpt ?? "",
      ),
    ).toContain("K[1_999]")
  })
})
