import { describe, expect, test } from "bun:test"
import {
  Apps,
  KnowledgeBaseEntity,
  MailEntity,
  SlackEntity,
} from "@xyne/vespa-ts/types"
import { formatFragmentsWithMetadata } from "@/api/chat/message-agents-metadata"
import type { MinimalAgentFragment } from "@/api/chat/types"
import {
  checkAndYieldCitationsForAgent,
  processMessage,
} from "@/api/chat/utils"

const makeFragment = (
  index: number,
  overrides: Partial<MinimalAgentFragment> = {},
): MinimalAgentFragment => ({
  id: `doc-${index}`,
  content: `[0] Chunk ${index} content`,
  confidence: 0.9,
  source: {
    docId: `doc-${index}`,
    title: `Doc ${index}`,
    url: `https://example.com/doc-${index}`,
    app: Apps.KnowledgeBase,
    entity: KnowledgeBaseEntity.File,
    itemId: `item-${index}`,
    clId: `cl-${index}`,
  },
  ...overrides,
})

async function collectCitations(text: string, results: MinimalAgentFragment[]) {
  const yielded: Array<{
    citation?: { index: number; item: MinimalAgentFragment["source"] }
  }> = []
  for await (const event of checkAndYieldCitationsForAgent(
    text,
    new Set<number>(),
    results,
    new Map(),
    "tester@example.com",
  )) {
    yielded.push(event as any)
  }
  return yielded
}

describe("message-agents citation extraction", () => {
  test("resolves numeric KB chunk citations to the cited document", async () => {
    const fragments = [
      makeFragment(1),
      makeFragment(2, { content: "[10] Model Context Protocol appears here" }),
    ]

    const yielded = await collectCitations(
      "Model Context Protocol appears here K[2_10].",
      fragments,
    )

    expect(yielded).toHaveLength(1)
    expect(yielded[0]?.citation?.index).toBe(2)
    expect(yielded[0]?.citation?.item?.docId).toBe("doc-2")
  })

  test("resolves doc-key KB citations via docId matching", async () => {
    const fragments = [
      makeFragment(1),
      makeFragment(2, { content: "[4] The answer is grounded here." }),
    ]

    const yielded = await collectCitations(
      "The answer is grounded in K[doc-2_4].",
      fragments,
    )

    expect(yielded).toHaveLength(1)
    expect(yielded[0]?.citation?.index).toBe(2)
    expect(yielded[0]?.citation?.item?.docId).toBe("doc-2")
  })

  test("recognizes the first KB chunk marker when it appears after the Content label", async () => {
    const fragments = [
      makeFragment(1, {
        content:
          "Source: Knowledge Base\nFile: Runbook.md\nContent: [11] The first visible chunk is here.\n[12] Another chunk follows.",
      }),
    ]

    const yielded = await collectCitations(
      "The first visible chunk is here K[1_11].",
      fragments,
    )

    expect(yielded).toHaveLength(1)
    expect(yielded[0]?.citation?.index).toBe(1)
    expect(yielded[0]?.citation?.item?.docId).toBe("doc-1")
  })

  test("rejects impossible chunk indexes even when the doc resolves", async () => {
    const fragments = [makeFragment(1)]

    const yielded = await collectCitations(
      "This still maps to the document K[1_999].",
      fragments,
    )

    expect(yielded).toHaveLength(0)
  })

  test("resolves regular Gmail and Slack citations alongside KB chunk citations", async () => {
    const fragments = [
      makeFragment(1, {
        id: "gmail-1",
        source: {
          docId: "gmail-1",
          title: "Subject: Budget follow-up",
          url: "https://mail.google.com/mail/u/0/#inbox/gmail-1",
          app: Apps.Gmail,
          entity: MailEntity.Email,
          threadId: "thread-1",
        },
      }),
      makeFragment(2, {
        id: "kb-1",
        content: "[4] KB says that",
        source: {
          docId: "kb-1",
          title: "Runbook",
          url: "https://example.com/kb-1",
          app: Apps.KnowledgeBase,
          entity: KnowledgeBaseEntity.File,
          itemId: "item-kb-1",
          clId: "cl-kb-1",
        },
      }),
      makeFragment(3, {
        id: "slack-1",
        source: {
          docId: "slack-1",
          title: "ops escalation",
          url: "https://juspay.slack.com/archives/C1/p123",
          app: Apps.Slack,
          entity: SlackEntity.Message,
          threadId: "1710000000.000100",
        },
      }),
    ]

    const yielded = await collectCitations(
      "Email says this[1]. KB says that K[2_4]. Slack confirms it[3].",
      fragments,
    )

    expect(yielded).toHaveLength(3)
    expect(yielded.map((event) => event.citation?.item?.app)).toEqual([
      Apps.Gmail,
      Apps.Slack,
      Apps.KnowledgeBase,
    ])
    expect(yielded.map((event) => event.citation?.item?.docId)).toEqual([
      "gmail-1",
      "slack-1",
      "kb-1",
    ])
  })

  test("deduplicates mixed citations by document index even when cited repeatedly", async () => {
    const fragments = [
      makeFragment(1, {
        id: "gmail-1",
        source: {
          docId: "gmail-1",
          title: "Subject: Budget follow-up",
          url: "https://mail.google.com/mail/u/0/#inbox/gmail-1",
          app: Apps.Gmail,
          entity: MailEntity.Email,
          threadId: "thread-1",
        },
      }),
      makeFragment(2, {
        id: "kb-1",
        content: "[4] Runbook detail\n[7] Follow-up detail",
        source: {
          docId: "kb-1",
          title: "Runbook",
          url: "https://example.com/kb-1",
          app: Apps.KnowledgeBase,
          entity: KnowledgeBaseEntity.File,
          itemId: "item-kb-1",
          clId: "cl-kb-1",
        },
      }),
    ]

    const yielded = await collectCitations(
      "Repeat email[1] and again[1]. Repeat KB K[2_4] and again K[2_7].",
      fragments,
    )

    expect(yielded).toHaveLength(2)
    expect(yielded.map((event) => event.citation?.item?.docId)).toEqual([
      "gmail-1",
      "kb-1",
    ])
  })
})

describe("message-agents citation remapping", () => {
  test("remaps numeric KB chunk citations during persistence", () => {
    const processed = processMessage(
      "Prompt Chaining is chapter one K[2_10].",
      { 2: 0 },
    )

    expect(processed).toBe("Prompt Chaining is chapter one K[1_10].")
  })

  test("leaves doc-key KB chunk citations untouched on the server path", () => {
    const processed = processMessage(
      "Get Started summary K[doc-1_0].",
      { 1: 0 },
    )

    expect(processed).toBe("Get Started summary K[doc-1_0].")
  })

  test("remaps mixed regular and KB citations in one pass", () => {
    const processed = processMessage(
      "Slack update[3] and KB note K[2_4] and Gmail follow-up[1].",
      { 3: 0, 2: 1, 1: 2 },
    )

    expect(processed).toBe(
      "Slack update[1] and KB note K[2_4] and Gmail follow-up[3].",
    )
  })
})

describe("final synthesis fragment formatting", () => {
  test("hides internal metadata fields from answer-view fragment formatting", () => {
    const formatted = formatFragmentsWithMetadata([
      makeFragment(1, {
        source: {
          ...makeFragment(1).source,
          page_title: "Quarterly Planning Sheet",
          status: "Open",
          threadId: "thread-1",
          parentThreadId: "parent-thread-1",
        },
      }),
    ])

    expect(formatted).toContain("- title: Doc 1")
    expect(formatted).toContain("- page_title: Quarterly Planning Sheet")
    expect(formatted).toContain("- status: Open")
    expect(formatted).not.toContain("docId")
    expect(formatted).not.toContain("url")
    expect(formatted).not.toContain("threadId")
    expect(formatted).not.toContain("itemId")
    expect(formatted).not.toContain("clId")
    expect(formatted).not.toContain("parentThreadId")
    expect(formatted).not.toContain("fragmentId")
    expect(formatted).not.toContain("confidence")
  })

  test("uses numeric indexes in fragment headers instead of doc ids", () => {
    const formatted = formatFragmentsWithMetadata([
      makeFragment(7, {
        id: "clf-123",
        source: {
          ...makeFragment(7).source,
          docId: "clf-123",
        },
      }),
    ])

    expect(formatted).toContain("index 1 {file context begins here...}")
    expect(formatted).not.toContain("Index clf-123")
  })

  test("formats Gmail fragments without chunk markers", () => {
    const formatted = formatFragmentsWithMetadata([
      makeFragment(1, {
        id: "gmail-1",
        content:
          "App: gmail\nEntity: mail\nSubject: Budget follow-up\nContent: Here is the full email body",
        source: {
          docId: "gmail-1",
          title: "Budget follow-up",
          url: "https://mail.google.com/mail/u/0/#inbox/gmail-1",
          app: Apps.Gmail,
          entity: MailEntity.Email,
          threadId: "thread-1",
        },
      }),
    ])

    expect(formatted).toContain("index 1 {file context begins here...}")
    expect(formatted).toContain("Subject: Budget follow-up")
    expect(formatted).not.toContain("[0]")
  })
})
