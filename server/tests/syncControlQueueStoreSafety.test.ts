import { describe, expect, test } from "bun:test"

const readSource = (relativePath: string) =>
  Bun.file(new URL(relativePath, import.meta.url)).text()

describe("sync control queue-store safety invariants", () => {
  test("does not use approximate pg-boss queue sizes for per-state counts", async () => {
    const source = await readSource("../sync-control/queueStore.ts")
    expect(source).not.toContain("getQueueSize")
  })

  test("does not use broad pg-boss clearStorage for clear operations", async () => {
    const queueStoreSource = await readSource("../sync-control/queueStore.ts")
    const apiSource = await readSource("../api/syncControl.ts")

    expect(queueStoreSource).not.toContain("clearStorage")
    expect(apiSource).not.toContain("clearStorage")
  })
})
