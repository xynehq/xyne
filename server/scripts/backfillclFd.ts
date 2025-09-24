import { createId } from "@paralleldrive/cuid2"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config, { CLUSTER, NAMESPACE } from "@/config"
import { db } from "@/db/client"
import { collectionItems } from "@/db/schema"
import { eq } from "drizzle-orm"
// import { UpdateDocument } from "@/search/vespa"
// import { KbItemsSchema } from "@xyne/vespa-ts/types"

const Logger = getLogger(Subsystem.Vespa).child({ module: "backfill-clfd" })

interface VisitOptions {
  namespace?: string
  schema?: string
  continuation?: string
  wantedDocumentCount?: number
  fieldSet?: string
  concurrency?: number
  cluster?: string
}

interface VisitResponse {
  documents: any[]
  continuation?: string
  documentCount: number
}

interface VespaDocument {
  id: string
  fields: {
    docId: string
    clId: string
    itemId: string
    clFd?: string
    [key: string]: any
  }
}

interface BatchStats {
  processed: number
  updated: number
  skipped: number
  errors: number
}

class clFdBackfillService {
  private vespaEndpoint: string

  constructor() {
    this.vespaEndpoint = config.vespaEndpoint
  }

  private async fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, options)
        return response
      } catch (error) {
        lastError = error as Error
        Logger.warn(`Fetch attempt ${attempt} failed: ${lastError.message}`)
        
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError || new Error('Max retries exceeded')
  }

  async visit(options: VisitOptions): Promise<VisitResponse> {
    const {
      namespace = NAMESPACE,
      schema = "kb_items",
      continuation,
      wantedDocumentCount = 200,
      fieldSet = `${schema}:*`,
      concurrency = 1,
      cluster = CLUSTER
    } = options

    const params = new URLSearchParams({
      wantedDocumentCount: wantedDocumentCount.toString(),
      cluster: cluster,
      selection: schema,
      ...(continuation ? { continuation } : {})
    })

    const url = `${this.vespaEndpoint}/document/v1/${namespace}/${schema}/docid?${params.toString()}`

    try {
      Logger.info(`Visiting documents: ${url}`)
      if (continuation) {
        Logger.info(`Using continuation token: ${continuation}`)
      }
      
      const response = await this.fetchWithRetry(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Visit failed: ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      const data = await response.json()
      
      // Log the continuation token for recovery purposes
      if (data.continuation) {
        Logger.info(`Received continuation token: ${data.continuation}`)
        Logger.info(`RECOVERY_TOKEN: ${data.continuation}`) // Special log for easy grep
      } else {
        Logger.info("No continuation token received - this might be the last batch")
      }
      
      return {
        documents: data.documents || [],
        continuation: data.continuation,
        documentCount: data.documentCount || 0
      }
    } catch (error) {
      const errMessage = (error as Error).message
      Logger.error(error, `Error visiting documents: ${errMessage}`)
      throw new Error(`Error visiting documents: ${errMessage}`)
    }
  }

  async getParentIdFromDatabase(itemId: string): Promise<string | null> {
    try {
      const item = await db
        .select({
          parentId: collectionItems.parentId
        })
        .from(collectionItems)
        .where(eq(collectionItems.id, itemId))
        .limit(1)

      if (item.length > 0 && item[0].parentId) {
        return item[0].parentId // Return raw parentId without prefix
      }
      return null
    } catch (error) {
      Logger.error(error, `Failed to get parentId for itemId: ${itemId}`)
      return null
    }
  }

  async updateDocumentclFd(docId: string, clfdValue: string): Promise<boolean> {
    const updateDoc = {
      fields: {
        clFd: {
          assign: clfdValue
        }
      }
    }

    try {
      Logger.debug(`Updating document ${docId} with clFd: ${clfdValue}`)
      
      // Use direct HTTP call instead of UpdateDocument function
      const url = `${this.vespaEndpoint}/document/v1/${NAMESPACE}/kb_items/docid/${docId}`
      const response = await this.fetchWithRetry(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateDoc)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Update failed: ${response.status} ${response.statusText} - ${errorText}`)
      }

      return true
    } catch (error) {
      Logger.error(error, `Failed to update document ${docId} with clFd: ${clfdValue}. Update payload: ${JSON.stringify(updateDoc)}`)
      
      // Check if it's a schema issue
      if (error instanceof Error && error.message.includes('400 Bad Request')) {
        Logger.error(`Possible schema issue: clFd field might not exist in deployed Vespa schema for document ${docId}`)
      }
      
      return false
    }
  }

  async processDocumentBatch(documents: VespaDocument[]): Promise<BatchStats> {
    const batchId = createId()
    Logger.info(`Processing batch ${batchId} with ${documents.length} documents`)

    const stats: BatchStats = {
      processed: 0,
      updated: 0,
      skipped: 0,
      errors: 0
    }

    for (const doc of documents) {
      try {
        const { docId, itemId, clFd } = doc.fields

        // Skip if clFd already exists (already migrated)
        if (clFd !== undefined && clFd !== null) {
          stats.skipped++
          Logger.debug(`Skipping document ${docId} - clFd already exists: ${clFd}`)
          continue
        }

        // Get parentId from PostgreSQL
        const parentclFd = await this.getParentIdFromDatabase(itemId)
        
        // Skip update if parentclFd is null (files at collection root)
        if (parentclFd === null) {
          stats.skipped++
          Logger.debug(`Skipping document ${docId} - no parentId (collection root file)`)
          continue
        }
        
        // Update document with clFd field
        const success = await this.updateDocumentclFd(docId, parentclFd)
        
        if (success) {
          stats.updated++
          Logger.debug(`Updated document ${docId} with clFd: ${parentclFd}`)
        } else {
          stats.errors++
        }

        stats.processed++

        // Add small delay to avoid overwhelming Vespa
        if (stats.processed % 50 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100))
          Logger.info(`Batch ${batchId} progress: ${stats.processed}/${documents.length} processed`)
        }

      } catch (error) {
        stats.errors++
        Logger.error(error, `Error processing document ${doc.id}`)
      }
    }

    Logger.info(`Batch ${batchId} complete:`, stats)
    return stats
  }

  async backfillAllDocuments(startContinuation?: string): Promise<void> {
    Logger.info("Starting clFd backfill process for kb_items schema")
    
    if (startContinuation) {
      Logger.info(`Resuming from continuation token: ${startContinuation}`)
      Logger.info(`RESUMING_FROM_TOKEN: ${startContinuation}`) // Special log for tracking
    }
    
    let totalStats: BatchStats = {
      processed: 0,
      updated: 0,
      skipped: 0,
      errors: 0
    }
    
    let continuation: string | undefined = startContinuation
    let batchCount = 0
    const startTime = Date.now()

    try {
      do {
        batchCount++
        const batchStartTime = Date.now()
        
        Logger.info(`Processing batch ${batchCount}...`)
        Logger.info(`BATCH_START: ${batchCount} - TOKEN: ${continuation || 'INITIAL'}`)

        // Visit documents with continuation
        const visitResult = await this.visit({
          schema: "kb_items",
          continuation,
          wantedDocumentCount: 200 
        })

        if (visitResult.documents.length === 0) {
          Logger.info("No more documents to process")
          break
        }

        // Process the batch
        const batchStats = await this.processDocumentBatch(visitResult.documents)
        
        // Update total counters
        totalStats.processed += batchStats.processed
        totalStats.updated += batchStats.updated
        totalStats.skipped += batchStats.skipped
        totalStats.errors += batchStats.errors
        
        // Set continuation for next batch
        continuation = visitResult.continuation
        
        const batchDuration = Date.now() - batchStartTime
        const totalDuration = Date.now() - startTime

        Logger.info(`Batch ${batchCount} summary:`, {
          batchStats,
          totalStats,
          batchDurationMs: batchDuration,
          totalDurationMs: totalDuration,
          documentsInBatch: visitResult.documents.length,
          nextContinuation: continuation || 'NONE'
        })

        // Log special recovery information
        Logger.info(`BATCH_COMPLETE: ${batchCount} - NEXT_TOKEN: ${continuation || 'FINAL'}`)

        // Add delay between batches to be gentle on the system
        await new Promise(resolve => setTimeout(resolve, 500))

      } while (continuation)

      const totalDuration = Date.now() - startTime
      Logger.info(`Backfill complete!`, {
        totalStats,
        totalBatches: batchCount,
        totalDurationMs: totalDuration,
        averageDocsPerSecond: Math.round((totalStats.processed / (totalDuration / 1000)) * 100) / 100
      })

      Logger.info(`BACKFILL_COMPLETE: Total processed=${totalStats.processed}, updated=${totalStats.updated}, skipped=${totalStats.skipped}, errors=${totalStats.errors}`)

    } catch (error) {
      Logger.error(error, `Backfill process failed at batch ${batchCount}`)
      Logger.error(`BACKFILL_FAILED: batch=${batchCount}, continuation=${continuation}`)
      throw error
    }
  }
}

// Main execution function
async function runBackfill(resumeToken?: string) {
  const backfillService = new clFdBackfillService()
  
  try {
    await backfillService.backfillAllDocuments(resumeToken)
    Logger.info("clFd backfill completed successfully!")
    process.exit(0)
  } catch (error) {
    Logger.error(error, "clFd backfill failed!")
    process.exit(1)
  }
}

// Export for use as module or run directly
export { clFdBackfillService }

// Run if called directly
if (require.main === module) {
  // Check for resume token in command line arguments
  const resumeToken = process.argv[2]
  if (resumeToken) {
    console.log(`Resuming backfill from token: ${resumeToken}`)
  }
  runBackfill(resumeToken)
}

/*
Usage:
- Fresh start: bun run scripts/backfillclFd.ts
- Resume from token: bun run scripts/backfillclFd.ts "CONTINUATION_TOKEN_HERE"

Recovery:
If the process fails, look for logs containing "RECOVERY_TOKEN:" or "BATCH_COMPLETE:" 
to find the last successful continuation token and resume from there.

Example recovery log search:
grep "RECOVERY_TOKEN:" logs/app.log | tail -1
grep "BATCH_COMPLETE:" logs/app.log | tail -1
*/