import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { insert } from "@/search/vespa"
import { Apps, KbItemsSchema, KnowledgeBaseEntity } from "@xyne/vespa-ts/types"
import { createId } from "@paralleldrive/cuid2"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

export const ProviderIngestApi = async (c: Context) => {
  const { collection_id, documents } = c.req.valid("json" as never)
  const workspaceId = c.get("workspaceId") as string

  try {
    const results: Array<{ docId: string; title: string; status: string }> = []

    for (const doc of documents as Array<{
      doc_id?: string
      title: string
      content: string
      access_tags: string[]
      source_url?: string
      metadata?: Record<string, unknown>
    }>) {
      const vespaDocId = doc.doc_id ?? `provider-${createId()}`

      const vespaDoc = {
        docId: vespaDocId,
        clId: collection_id as string,
        itemId: vespaDocId,
        clFd: "",
        fileName: doc.title,
        app: Apps.KnowledgeBase as const,
        entity: KnowledgeBaseEntity.File,
        description: doc.content.slice(0, 500),
        storagePath: doc.source_url ?? "",
        chunks: [doc.content],
        chunks_pos: [],
        image_chunks: [],
        image_chunks_pos: [],
        chunks_map: [],
        image_chunks_map: [],
        metadata: JSON.stringify({
          source: "provider",
          workspaceId,
          ...(doc.metadata ?? {}),
        }),
        createdBy: workspaceId,
        duration: 0,
        mimeType: "text/plain",
        fileSize: doc.content.length,
        access_tags: doc.access_tags,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      await insert(vespaDoc, KbItemsSchema)

      results.push({
        docId: vespaDocId,
        title: doc.title,
        status: "ingested",
      })
    }

    return c.json({
      collection_id,
      documents: results,
      total: results.length,
    })
  } catch (error) {
    Logger.error(error, "Provider document ingestion failed")
    throw new HTTPException(500, { message: "Document ingestion failed" })
  }
}
