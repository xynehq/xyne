import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { insert } from "@/search/vespa"
import { Apps, KbItemsSchema, KnowledgeBaseEntity } from "@xyne/vespa-ts/types"
import { createId } from "@paralleldrive/cuid2"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { FileProcessorService } from "@/services/fileProcessor"
import { detectMimeType } from "@/api/knowledgeBase"
import { mapChunkMeta } from "@/queue/fileProcessor"
import { expandAccessTags } from "@/api/provider/accessTags"

const Logger = getLogger(Subsystem.Server)

function resolveWorkspaceId(c: Context): string {
  // ApiKeyMiddleware sets "workspaceId", dashboard JWT sets "jwtPayload"
  const fromApiKey = c.get("workspaceId") as string | undefined
  if (fromApiKey) return fromApiKey
  const payload = c.get("jwtPayload") as { workspaceId?: string } | undefined
  if (payload?.workspaceId) return payload.workspaceId
  throw new HTTPException(401, { message: "Could not resolve workspace" })
}

function resolveAccessTags(
  visibility: string,
  accessTags: string[],
): string[] {
  const expandedTags = expandAccessTags(accessTags)
  // When visibility is "authenticated" with no granular tags, add sentinel
  // so Vespa can match "any authenticated user" docs efficiently.
  if (visibility === "authenticated" && expandedTags.length === 0) {
    return ["__all_authenticated__"]
  }
  return expandedTags
}

export const ProviderIngestApi = async (c: Context) => {
  const { collection_id, documents } = c.req.valid("json" as never)
  const workspaceId = resolveWorkspaceId(c)

  try {
    const results: Array<{ docId: string; title: string; status: string }> = []

    for (const doc of documents as Array<{
      doc_id?: string
      title: string
      content: string
      visibility?: string
      access_tags: string[]
      source_url?: string
      metadata?: Record<string, unknown>
    }>) {
      const vespaDocId = doc.doc_id ?? `provider-${createId()}`
      const visibility = doc.visibility ?? "public"
      const buffer = Buffer.from(doc.content, "utf-8")

      const processingResults = await FileProcessorService.processFile(
        buffer,
        "text/plain",
        doc.title,
        vespaDocId,
        undefined,
        false, // extractImages
        false, // describeImages
        false, // useOCR
      )

      for (const result of processingResults) {
        const resultDocId =
          "docId" in result ? (result as any).docId : vespaDocId

        const vespaDoc = {
          docId: resultDocId,
          clId: collection_id as string,
          itemId: resultDocId,
          clFd: "",
          fileName: doc.title,
          app: Apps.KnowledgeBase as const,
          entity: KnowledgeBaseEntity.File,
          description: doc.content.slice(0, 500),
          storagePath: doc.source_url ?? "",
          chunks: result.chunks,
          chunks_pos: result.chunks_pos,
          image_chunks: result.image_chunks,
          image_chunks_pos: result.image_chunks_pos,
          toc_chunks: result.toc_chunks ?? [],
          chunks_map:
            result.chunks_map?.map((m) => mapChunkMeta(m, true)) ?? [],
          image_chunks_map:
            result.image_chunks_map?.map((m) => mapChunkMeta(m, false)) ?? [],
          metadata: JSON.stringify({
            source: "provider",
            workspaceId,
            chunksCount: result.chunks.length,
            ...(doc.metadata ?? {}),
          }),
          createdBy: workspaceId,
          duration: 0,
          mimeType: "text/plain",
          fileSize: doc.content.length,
          visibility,
          access_tags: resolveAccessTags(visibility, doc.access_tags),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

        await insert(vespaDoc, KbItemsSchema)

        results.push({
          docId: resultDocId,
          title: doc.title,
          status: "ingested",
        })
      }
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

export const ProviderFileUploadApi = async (c: Context) => {
  const workspaceId = resolveWorkspaceId(c)
  const formData = await c.req.formData()

  const files = formData.getAll("files") as File[]
  const collectionId = formData.get("collection_id") as string
  const visibilityRaw = formData.get("visibility") as string | null
  const visibility = visibilityRaw === "authenticated" ? "authenticated" : "public"
  const accessTagsRaw = formData.get("access_tags") as string | null
  const accessTags: string[] = accessTagsRaw
    ? JSON.parse(accessTagsRaw)
    : []
  const docIdOverride = formData.get("doc_id") as string | null

  if (!collectionId || files.length === 0) {
    throw new HTTPException(400, {
      message: "collection_id and at least one file required",
    })
  }

  try {
    const results: Array<{ docId: string; title: string; status: string }> = []

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const mimeType = await detectMimeType(file.name, buffer, file.type)
      const vespaDocId =
        docIdOverride && files.length === 1
          ? docIdOverride
          : `provider-${createId()}`

      const processingResults = await FileProcessorService.processFile(
        buffer,
        mimeType,
        file.name,
        vespaDocId,
        undefined,
        true,
        true,
        true,
      )

      for (const result of processingResults) {
        const resultDocId =
          "docId" in result ? (result as any).docId : vespaDocId

        const vespaDoc = {
          docId: resultDocId,
          clId: collectionId,
          itemId: resultDocId,
          clFd: "",
          fileName: file.name,
          app: Apps.KnowledgeBase as const,
          entity: KnowledgeBaseEntity.File,
          description: (result.chunks[0] ?? "").slice(0, 500),
          storagePath: "",
          chunks: result.chunks,
          chunks_pos: result.chunks_pos,
          image_chunks: result.image_chunks,
          image_chunks_pos: result.image_chunks_pos,
          toc_chunks: result.toc_chunks ?? [],
          chunks_map:
            result.chunks_map?.map((m) => mapChunkMeta(m, true)) ?? [],
          image_chunks_map:
            result.image_chunks_map?.map((m) => mapChunkMeta(m, false)) ?? [],
          metadata: JSON.stringify({
            source: "provider",
            workspaceId,
            mimeType,
            originalFileName: file.name,
            chunksCount: result.chunks.length,
            processingMethod: result.processingMethod,
          }),
          createdBy: workspaceId,
          duration: 0,
          mimeType,
          fileSize: buffer.length,
          visibility,
          access_tags: resolveAccessTags(visibility, accessTags),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

        await insert(vespaDoc, KbItemsSchema)
        results.push({
          docId: resultDocId,
          title: file.name,
          status: "ingested",
        })
      }
    }

    return c.json({
      collection_id: collectionId,
      documents: results,
      total: results.length,
    })
  } catch (error) {
    Logger.error(error, "Provider file upload ingestion failed")
    throw new HTTPException(500, { message: "File ingestion failed" })
  }
}
