import path from "node:path"
import { describe, expect, test } from "bun:test"
import {
  buildDoclingSchedulerSourceReference,
  resolveDoclingSchedulerSourcePath,
} from "@/lib/doclingSchedulerStorage"

describe("Docling scheduler source storage helpers", () => {
  test("stores Knowledge Base files as relative storage keys", () => {
    const knowledgeBaseRoot = "/srv/app/server/storage/kb_files"
    const sourcePath = path.join(
      knowledgeBaseRoot,
      "workspace-1",
      "collection-1",
      "2026",
      "05",
      "abc_report.pdf",
    )

    const reference = buildDoclingSchedulerSourceReference(
      sourcePath,
      knowledgeBaseRoot,
    )

    expect(reference).toEqual({
      sourcePath: path.join(
        "workspace-1",
        "collection-1",
        "2026",
        "05",
        "abc_report.pdf",
      ),
      sourceStorageKey: path.join(
        "workspace-1",
        "collection-1",
        "2026",
        "05",
        "abc_report.pdf",
      ),
    })
  })

  test("resolves durable storage keys against the worker KB root", () => {
    const storageKey = path.join(
      "workspace-1",
      "collection-1",
      "2026",
      "05",
      "abc_report.pdf",
    )

    expect(
      resolveDoclingSchedulerSourcePath(
        storageKey,
        storageKey,
        "/mnt/scheduler/storage/kb_files",
      ),
    ).toBe(
      path.join(
        "/mnt/scheduler/storage/kb_files",
        "workspace-1",
        "collection-1",
        "2026",
        "05",
        "abc_report.pdf",
      ),
    )
  })

  test("leaves non-KB absolute paths untouched", () => {
    const sourcePath = "/private/tmp/manual-upload/report.pdf"

    expect(
      buildDoclingSchedulerSourceReference(
        sourcePath,
        "/srv/app/server/storage/kb_files",
      ),
    ).toEqual({
      sourcePath,
      sourceStorageKey: null,
    })

    expect(
      resolveDoclingSchedulerSourcePath(
        sourcePath,
        null,
        "/mnt/scheduler/storage/kb_files",
      ),
    ).toBe(sourcePath)
  })
})
