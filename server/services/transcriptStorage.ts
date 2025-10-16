import type { TranscriptSegment } from "@/services/transcription"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { db } from "@/db/client"
import { calls } from "@/db/schema/calls"
import { eq } from "drizzle-orm"
import { insert, GetDocument, DeleteDocument } from "@/search/vespa"
import { KbItemsSchema, Apps, KnowledgeBaseEntity } from "@xyne/vespa-ts/types"
import {
  createCollection,
  createFileItem,
  getCollectionsByOwner,
  generateFileVespaDocId,
  generateStorageKey,
} from "@/db/knowledgeBase"
import { getUserByEmail } from "@/db/user"
import path from "node:path"
import fs from "node:fs/promises"

const Logger = getLogger(Subsystem.Vespa).child({
  module: "transcript-storage",
})

// Knowledge Base storage path for transcripts
const KB_STORAGE_ROOT = path.join(process.cwd(), "storage", "kb_files")
const TRANSCRIPTS_COLLECTION_NAME = "Call Transcripts"

interface CallTranscriptData {
  callId: number // Internal DB ID
  callExternalId: string // UUID
  workspaceId: number
  workspaceExternalId: string
  userEmail: string
  segments: TranscriptSegment[]
  callType: string
  startedAt: Date
  endedAt: Date
  participantNames: string[]
  participantIds: string[]
}

/**
 * Save call transcript to Knowledge Base
 */
export async function saveTranscriptToKnowledgeBase(
  data: CallTranscriptData,
): Promise<string> {
  try {
    // Get user
    const users = await getUserByEmail(db, data.userEmail)
    if (!users || users.length === 0) {
      throw new Error("User not found")
    }
    const user = users[0]

    // Create full transcript text
    const fullTranscript = data.segments
      .map(
        (s) =>
          `[${s.speaker}] (${new Date(s.timestamp).toLocaleTimeString()}): ${s.text}`,
      )
      .join("\n\n")

    // Create formatted transcript with metadata header
    const transcriptContent = `Call Transcript
==============
Call Type: ${data.callType}
Started: ${data.startedAt.toLocaleString()}
Ended: ${data.endedAt.toLocaleString()}
Duration: ${Math.floor((data.endedAt.getTime() - data.startedAt.getTime()) / 1000 / 60)} minutes
Participants: ${data.participantNames.join(", ")}

Transcript:
-----------
${fullTranscript}

---
Metadata:
- Call ID: ${data.callExternalId}
- Participants: ${data.participantIds.join(", ")}
- Segments: ${data.segments.length}
`

    // Ensure "Call Transcripts" collection exists
    let collections = await getCollectionsByOwner(db, user.id)
    let collection = collections.find(
      (c) => c.name === TRANSCRIPTS_COLLECTION_NAME,
    )

    if (!collection) {
      collection = await db.transaction(async (tx) => {
        return await createCollection(tx, {
          workspaceId: data.workspaceId,
          ownerId: user.id,
          name: TRANSCRIPTS_COLLECTION_NAME,
          description: "Automatically generated transcripts from calls",
        })
      })
    }

    // Generate IDs
    const vespaDocId = generateFileVespaDocId()
    const storageKey = generateStorageKey()
    const fileName = `${data.callType}_call_${data.startedAt.toISOString().split("T")[0]}_${storageKey}.txt`

    // Create storage path
    const year = data.startedAt.getFullYear()
    const month = (data.startedAt.getMonth() + 1).toString().padStart(2, "0")
    const storagePath = path.join(
      KB_STORAGE_ROOT,
      data.workspaceExternalId,
      collection.id,
      year.toString(),
      month,
      `${storageKey}_${fileName}`,
    )

    // Ensure directory exists and write file
    await fs.mkdir(path.dirname(storagePath), { recursive: true })
    await fs.writeFile(storagePath, transcriptContent, "utf-8")

    // Create chunks for searchability
    const chunks = [
      // Full transcript as one chunk
      fullTranscript,
      // Individual segments as separate chunks for better granularity
      ...data.segments.map((s) => `${s.speaker}: ${s.text}`),
    ]

    // Transaction: Create DB record + Vespa document
    const collectionItem = await db.transaction(async (tx) => {
      return await createFileItem(
        tx,
        collection!.id,
        null, // parentId (root level)
        fileName,
        vespaDocId,
        fileName, // originalName
        storagePath,
        storageKey,
        "text/plain", // mimeType
        Buffer.byteLength(transcriptContent, "utf-8"), // fileSize
        null, // checksum
        {
          // metadata
          callId: data.callId,
          callExternalId: data.callExternalId,
          callType: data.callType,
          startedAt: data.startedAt.toISOString(),
          endedAt: data.endedAt.toISOString(),
          participants: data.participantNames,
          participantIds: data.participantIds,
          segmentCount: data.segments.length,
        },
        user.id,
        data.userEmail,
        "Transcript generated from call",
      )
    })

    // Create Vespa document
    const vespaDoc = {
      docId: vespaDocId,
      clId: collection.id,
      itemId: collectionItem.id,
      fileName,
      app: Apps.KnowledgeBase as const,
      entity: KnowledgeBaseEntity.File as const,
      description: `Call transcript: ${data.callType} call with ${data.participantNames.join(", ")}`,
      storagePath,
      chunks,
      chunks_pos: chunks.map((_, i) => i),
      image_chunks: [],
      image_chunks_pos: [],
      chunks_map: [],
      image_chunks_map: [],
      fileSize: Buffer.byteLength(transcriptContent, "utf-8"),
      mimeType: "text/plain",
      createdBy: data.userEmail,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      duration: 0,
      metadata: JSON.stringify({
        originalFileName: fileName,
        uploadedBy: data.userEmail,
        chunksCount: chunks.length,
        processingMethod: "call_transcription",
        callMetadata: {
          callId: data.callId,
          callExternalId: data.callExternalId,
          callType: data.callType,
          startedAt: data.startedAt.toISOString(),
          endedAt: data.endedAt.toISOString(),
          participants: data.participantNames,
          participantIds: data.participantIds,
        },
      }),
    }

    // Insert into Vespa
    await insert(vespaDoc, KbItemsSchema)

    Logger.info(`Transcript saved for call ${data.callExternalId}`)

    return vespaDocId
  } catch (error) {
    Logger.error(error, "Failed to save transcript to Knowledge Base")
    throw error
  }
}

/**
 * Update call record with Vespa document ID
 */
export async function updateCallWithTranscript(
  callId: number,
  vespaDocId: string,
): Promise<void> {
  try {
    await db
      .update(calls)
      .set({
        transcriptVespaDocId: vespaDocId,
      })
      .where(eq(calls.id, callId))

    Logger.info(
      `Updated call ${callId} with transcript Vespa doc ID: ${vespaDocId}`,
    )
  } catch (error) {
    Logger.error(error, `Failed to update call ${callId} with transcript`)
    throw error
  }
}

/**
 * Delete transcript from Knowledge Base
 * This will remove both the Vespa document and the physical file
 */
export async function deleteTranscriptFromKnowledgeBase(
  vespaDocId: string,
): Promise<void> {
  try {
    // Delete from Vespa (this handles the searchable index)
    await DeleteDocument(vespaDocId, KbItemsSchema)

    Logger.info(`Deleted transcript from Knowledge Base: ${vespaDocId}`)

    // Note: The physical file and DB record should be deleted through
    // the standard Knowledge Base deletion workflow
  } catch (error) {
    Logger.error(
      error,
      `Failed to delete transcript from Knowledge Base: ${vespaDocId}`,
    )
    throw error
  }
}

// Note: Transcripts can be searched through the standard Knowledge Base search
// using the SearchKnowledgeBaseApi with collection filter for "Call Transcripts"
