/**
 * Migration Script: Datasource to Knowledge Base
 *
 * This script migrates all datasource files from agents' app_integrations
 * to the knowledge base feature as collections.
 *
 * For each datasource:
 * 1. Finds all agents that have the datasource mapped in app_integrations
 * 2. Creates a collection in knowledge_base with the datasource name + timestamp
 * 3. Fetches all files from the datasource (from datasource_file schema in Vespa)
 * 4. Creates collection_items for each file (without storage key as files don't exist physically)
 * 5. Inserts each file into Vespa's kb_items schema
 * 6. Updates agent's app_integrations to include the new collection under knowledge_base
 * 7. Optionally removes the DataSource object from app_integrations (use --remove-datasource flag)
 *
 * Usage:
 *   bun run scripts/migrate-datasources-to-kb.ts [--dry-run] [--remove-datasource]
 *
 * Flags:
 *   --dry-run             Preview what will be migrated without making changes
 *   --remove-datasource   Remove DataSource objects after successful migration (CAUTION: use only after verifying migration)
 *
 * NOTE: This script does NOT delete datasources or datasource files from Vespa
 */

import { db } from "@/db/client"
import {
  createCollection,
  createFileItem,
  generateFileVespaDocId,
} from "@/db/knowledgeBase"
import { agents, collectionItems, collections } from "@/db/schema"
import { getUserByEmail } from "@/db/user"
import { getLogger } from "@/logger"
import {
  insert,
  GetDocument,
} from "@/search/vespa"
import { UploadStatus } from "@/shared/types"
import { Subsystem } from "@/types"
import { Apps, KnowledgeBaseEntity, KbItemsSchema } from "@xyne/vespa-ts/types"
import type { VespaDataSource, VespaDataSourceFile } from "@xyne/vespa-ts/types"
import { eq, isNull, sql } from "drizzle-orm"

const Logger = getLogger(Subsystem.Api).child({
  module: "datasource-to-kb-migration",
})

interface MigrationStats {
  totalAgentsProcessed: number
  totalDatasourcesProcessed: number
  totalFilesCreated: number
  totalCollectionsCreated: number
  errors: Array<{
    agentId: number
    datasourceId: string
    error: string
  }>
}

/**
 * Main migration function
 */
async function migrateDatasourcesToKnowledgeBase(removeDataSource = false) {
  const stats: MigrationStats = {
    totalAgentsProcessed: 0,
    totalDatasourcesProcessed: 0,
    totalFilesCreated: 0,
    totalCollectionsCreated: 0,
    errors: [],
  }

  Logger.info("Starting datasource to knowledge base migration...")

  try {
    // Get all agents with datasource integrations
    const agentsWithDatasources = await db
      .select()
      .from(agents)
      .where(isNull(agents.deletedAt))

    Logger.info(
      `Found ${agentsWithDatasources.length} agents (including those without datasources)`,
    )

    for (const agent of agentsWithDatasources) {
      try {
        stats.totalAgentsProcessed++

        // Parse app_integrations
        const appIntegrations = agent.appIntegrations as any

        // Check if agent has DataSource in app_integrations
        if (
          !appIntegrations ||
          typeof appIntegrations !== "object" ||
          !appIntegrations.DataSource
        ) {
          Logger.debug(
            `Agent ${agent.id} (${agent.name}) has no datasource integrations, skipping...`,
          )
          continue
        }

        const datasourceIntegration = appIntegrations.DataSource
        const datasourceIds = datasourceIntegration.itemIds as string[]

        if (!datasourceIds || datasourceIds.length === 0) {
          Logger.debug(
            `Agent ${agent.id} (${agent.name}) has empty datasource itemIds, skipping...`,
          )
          continue
        }

        Logger.info(
          `Processing agent ${agent.id} (${agent.name}) with ${datasourceIds.length} datasources`,
        )

        // Get user info for the agent owner
        const user = await db.query.users.findFirst({
          where: (users, { eq }) => eq(users.id, agent.userId),
        })

        if (!user) {
          Logger.error(`User ${agent.userId} not found for agent ${agent.id}`)
          stats.errors.push({
            agentId: agent.id,
            datasourceId: "N/A",
            error: `User ${agent.userId} not found`,
          })
          continue
        }

        // Track migrated collection IDs for this agent
        const migratedCollectionIds: string[] = []

        // Process each datasource
        for (const datasourceId of datasourceIds) {
          try {
            stats.totalDatasourcesProcessed++

            Logger.info(`Processing datasource: ${datasourceId}`)

            // Fetch datasource document directly by ID from Vespa
            let datasource: VespaDataSource | null = null
            let datasourceName: string = `Datasource_${datasourceId}`

            try {
              const datasourceDoc = await GetDocument("datasource", datasourceId)

              if (datasourceDoc && datasourceDoc.fields) {
                datasource = datasourceDoc.fields as VespaDataSource
                datasourceName = datasource.name || datasourceName
                Logger.info(
                  `Found datasource: "${datasourceName}" (${datasourceId})`,
                )
              } else {
                Logger.warn(
                  `Datasource ${datasourceId} not found in Vespa, will use ID as name`,
                )
              }
            } catch (fetchError) {
              Logger.warn(
                `Error fetching datasource ${datasourceId}: ${fetchError}`,
              )
            }

            if (!datasource) {
              Logger.warn(
                `Could not fetch datasource ${datasourceId}, using ID as name for collection`,
              )
            }

            // Generate unique collection name with timestamp
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
            const uniqueCollectionName = `${datasourceName}_${timestamp}`

            // Check if collection already exists for this datasource (by original datasource ID in metadata)
            // Check across ALL users, not just the current user, since datasources can be shared
            const existingCollection = await db.query.collections.findFirst({
              where: (collections, { and, isNull, sql }) =>
                and(
                  sql`${collections.metadata}->>'originalDatasourceId' = ${datasourceId}`,
                  isNull(collections.deletedAt),
                ),
            })

            let collection
            if (existingCollection) {
              Logger.info(
                `Collection for datasource "${datasourceId}" already exists with name "${existingCollection.name}", using existing collection. Skipping file migration.`,
              )
              collection = existingCollection

              // Skip file migration, just add collection to agent
              migratedCollectionIds.push(`cl-${collection.id}`)
              continue // Skip to next datasource
            } else {
              // Create new collection with unique name
              collection = await createCollection(db, {
                workspaceId: user.workspaceId,
                ownerId: user.id,
                name: uniqueCollectionName,
                description: `Migrated from datasource: ${datasourceName} (${datasourceId})`,
                isPrivate: true,
                uploadStatus: UploadStatus.PROCESSING,
                metadata: {
                  migratedFrom: "datasource",
                  originalDatasourceName: datasourceName,
                  originalDatasourceId: datasourceId,
                  migratedAt: new Date().toISOString(),
                },
              })

              stats.totalCollectionsCreated++
              Logger.info(
                `Created collection: ${collection.name} (${collection.id})`,
              )
            }

            migratedCollectionIds.push(`cl-${collection.id}`) // "cl-" prefix + PostgreSQL UUID for app_integrations

            // Fetch all files from datasource by querying Vespa with dataSourceRef filter
            Logger.info(
              `Fetching files for datasource ${datasourceId} from Vespa...`,
            )

            const datasourceFilesSearch = await fetchDatasourceFiles(
              datasourceId,
              user.email,
            )

            if (!datasourceFilesSearch || datasourceFilesSearch.length === 0) {
              Logger.warn(
                `No files found in datasource ${datasourceId}, skipping...`,
              )
              continue
            }

            Logger.info(
              `Found ${datasourceFilesSearch.length} files in datasource ${datasourceName}`,
            )

            // Process each file
            for (const dsFileSearchResult of datasourceFilesSearch) {
              try {
                // Extract docId from search result
                const docId = (dsFileSearchResult as any).fields?.docId ||
                             (dsFileSearchResult as any).docId

                if (!docId) {
                  Logger.warn('File search result missing docId, skipping...')
                  continue
                }

                Logger.debug(`Fetching full document from Vespa for file: ${docId}`)

                // Fetch the full document from Vespa to get ALL fields including chunks
                const fullFileDoc = await GetDocument(
                  "datasource_file",
                  docId,
                )

                if (!fullFileDoc || !fullFileDoc.fields) {
                  Logger.warn(
                    `Could not fetch full document for ${docId}, skipping...`,
                  )
                  continue
                }

                await migrateFileToKnowledgeBase(
                  fullFileDoc.fields as VespaDataSourceFile,
                  collection.id,
                  user.id,
                  user.email,
                  user.workspaceId,
                )
                stats.totalFilesCreated++
              } catch (fileError) {
                const fileId = (dsFileSearchResult as any).fields?.docId ||
                              (dsFileSearchResult as any).docId ||
                              'unknown'
                Logger.error(`Error migrating file ${fileId}:`, fileError)
                stats.errors.push({
                  agentId: agent.id,
                  datasourceId,
                  error: `Failed to migrate file ${fileId}: ${fileError}`,
                })
              }
            }

            // Update collection status to completed
            await db
              .update(collections)
              .set({
                uploadStatus: UploadStatus.COMPLETED,
                statusMessage: `Migration completed: ${datasourceFilesSearch.length} files migrated`,
                updatedAt: sql`NOW()`,
              })
              .where(eq(collections.id, collection.id))

            Logger.info(
              `Successfully migrated datasource ${datasourceName} with ${datasourceFilesSearch.length} files`,
            )
          } catch (datasourceError) {
            Logger.error(
              `Error processing datasource ${datasourceId}:`,
              datasourceError,
            )
            stats.errors.push({
              agentId: agent.id,
              datasourceId,
              error: `${datasourceError}`,
            })
          }
        }

        // Update agent's app_integrations to include knowledge_base collections
        // and optionally remove DataSource object (controlled by CLI flag)
        if (migratedCollectionIds.length > 0) {
          await updateAgentWithKnowledgeBase(
            agent.id,
            migratedCollectionIds,
            removeDataSource, // from CLI flag
          )
          Logger.info(
            `Updated agent ${agent.id} with ${migratedCollectionIds.length} knowledge base collections${removeDataSource ? " and removed DataSource integration" : ""}`,
          )
        }
      } catch (agentError) {
        Logger.error(`Error processing agent ${agent.id}:`, agentError)
        stats.errors.push({
          agentId: agent.id,
          datasourceId: "N/A",
          error: `${agentError}`,
        })
      }
    }

    // Print migration summary
    Logger.info("=" + "=".repeat(60))
    Logger.info("Migration Summary:")
    Logger.info(`Total agents processed: ${stats.totalAgentsProcessed}`)
    Logger.info(
      `Total datasources processed: ${stats.totalDatasourcesProcessed}`,
    )
    Logger.info(`Total collections created: ${stats.totalCollectionsCreated}`)
    Logger.info(`Total files migrated: ${stats.totalFilesCreated}`)
    Logger.info(`Total errors: ${stats.errors.length}`)
    Logger.info("=" + "=".repeat(60))

    if (stats.errors.length > 0) {
      Logger.warn("Errors encountered during migration:")
      stats.errors.forEach((error, index) => {
        Logger.warn(
          `${index + 1}. Agent ${error.agentId}, Datasource ${error.datasourceId}: ${error.error}`,
        )
      })
    }

    return stats
  } catch (error) {
    Logger.error("Fatal error during migration:", error)
    throw error
  }
}

/**
 * Migrate a single file from datasource to knowledge base
 */
async function migrateFileToKnowledgeBase(
  dsFile: VespaDataSourceFile,
  collectionId: string,
  userId: number,
  userEmail: string,
  workspaceId: number,
) {
  const fileName = dsFile.fileName || `file_${dsFile.docId}`

  Logger.debug(`Migrating file: ${fileName} (${dsFile.docId})`)

  // Generate new vespa doc ID for knowledge base
  const kbVespaDocId = generateFileVespaDocId()

  // Create collection item in PostgreSQL
  const fileItem = await createFileItem(
    db,
    collectionId,
    null, // parentId - root level
    fileName,
    kbVespaDocId,
    fileName, // originalName
    "", // storagePath - empty as file doesn't exist physically
    "", // storageKey - empty as file doesn't exist physically
    dsFile.mimeType || null,
    dsFile.fileSize || null,
    null, // checksum - null as we don't have the original file
    {
      migratedFrom: "datasource",
      originalDatasourceFileId: dsFile.docId,
      migratedAt: new Date().toISOString(),
    },
    userId,
    userEmail,
    `Migrated from datasource file: ${dsFile.docId}`,
  )

  // Get collection to fetch vespaDocId
  const collection = await db.query.collections.findFirst({
    where: (collections, { eq }) => eq(collections.id, collectionId),
  })

  if (!collection) {
    throw new Error(`Collection ${collectionId} not found`)
  }

  // Create Vespa document for kb_items schema matching the correct structure
  const vespaDoc = {
    docId: kbVespaDocId,
    clId: collection.vespaDocId, // Collection Vespa ID with "cl-" prefix
    itemId: fileItem.id, // PostgreSQL item ID
    fileName: fileName,
    app: Apps.KnowledgeBase as const,
    entity: KnowledgeBaseEntity.File,
    description: dsFile.description || "",
    storagePath: "", // Empty as no physical file
    chunks: dsFile.chunks || [],
    chunks_pos: dsFile.chunks_pos || [],
    image_chunks: dsFile.image_chunks || [],
    image_chunks_pos: dsFile.image_chunks_pos || [],
    chunks_map: [], // No chunks_map for migrated files
    image_chunks_map: [], // No image_chunks_map for migrated files
    metadata: JSON.stringify({
      migratedFrom: "datasource",
      originalDatasourceFileId: dsFile.docId,
      originalFileName: dsFile.fileName,
      uploadedBy: userEmail,
      chunksCount: (dsFile.chunks || []).length + (dsFile.image_chunks || []).length,
      imageChunksCount: (dsFile.image_chunks || []).length,
      lastModified: Date.now(),
    }),
    createdBy: userEmail,
    duration: dsFile.duration || 0,
    mimeType: dsFile.mimeType || "text/plain",
    fileSize: dsFile.fileSize || 0,
    createdAt: dsFile.createdAt || Date.now(),
    updatedAt: Date.now(),
  }

  // Insert into Vespa using the correct function
  await insert(vespaDoc, KbItemsSchema)

  // Update collection item to mark as completed
  await db
    .update(collectionItems)
    .set({
      uploadStatus: UploadStatus.COMPLETED,
      processedAt: new Date(),
      updatedAt: sql`NOW()`,
    })
    .where(eq(collectionItems.id, fileItem.id))

  Logger.debug(`Successfully migrated file ${fileName} to knowledge base`)
}

/**
 * Update agent's app_integrations to include knowledge base collections
 * and optionally remove DataSource object
 */
async function updateAgentWithKnowledgeBase(
  agentId: number,
  collectionVespaIds: string[],
  removeDataSource: boolean = false,
) {
  // Get current agent
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId))

  if (!agent) {
    throw new Error(`Agent ${agentId} not found`)
  }

  // Parse current app_integrations
  const appIntegrations = (agent.appIntegrations as any) || {}

  // Add or update knowledge_base entry
  if (!appIntegrations.knowledge_base) {
    Logger.debug(
      `Creating new knowledge_base entry for agent ${agentId} with ${collectionVespaIds.length} collections`,
    )
    appIntegrations.knowledge_base = {
      itemIds: collectionVespaIds,
      selectedAll: false,
    }
  } else {
    // Merge with existing knowledge base collections (preserves existing ones!)
    const existingIds = appIntegrations.knowledge_base.itemIds || []
    const mergedIds = [...new Set([...existingIds, ...collectionVespaIds])]
    Logger.debug(
      `Merging knowledge_base collections for agent ${agentId}: ${existingIds.length} existing + ${collectionVespaIds.length} new = ${mergedIds.length} total`,
    )
    appIntegrations.knowledge_base.itemIds = mergedIds
  }

  // Remove DataSource object if requested (controlled by CLI flag)
  if (removeDataSource && appIntegrations.DataSource) {
    Logger.info(`✓ Removing DataSource integration from agent ${agentId}`)
    delete appIntegrations.DataSource
  } else if (removeDataSource && !appIntegrations.DataSource) {
    Logger.debug(`DataSource already removed from agent ${agentId}`)
  } else if (!removeDataSource && appIntegrations.DataSource) {
    Logger.debug(`Preserving DataSource integration for agent ${agentId} (use --remove-datasource to remove)`)
  }

  // Update agent
  await db
    .update(agents)
    .set({
      appIntegrations: appIntegrations,
      updatedAt: sql`NOW()`,
    })
    .where(eq(agents.id, agentId))

  Logger.debug(
    `Updated agent ${agentId} with knowledge base collections: ${collectionVespaIds.join(", ")}${removeDataSource ? " (DataSource removed)" : ""}`,
  )
}

/**
 * Fetch all files for a datasource from Vespa by dataSourceRef with pagination
 */
async function fetchDatasourceFiles(
  datasourceId: string,
  _userEmail: string,
): Promise<any[]> {
  try {
    // Import config
    const configModule = await import("@/config")
    const CLUSTER = configModule.CLUSTER

    // Build YQL query to find all files for this datasource
    // Note: Using dataSourceId field with contains for string matching
    // Format: my_content.datasource_file (just CLUSTER.schema, no namespace)
    const yql = `select * from ${CLUSTER}.datasource_file where dataSourceId contains "${datasourceId}"`

    Logger.info(`Executing Vespa query: ${yql}`)

    // Make direct fetch to Vespa
    const vespaEndpoint = configModule.default.vespaEndpoint
    const searchUrl = `${vespaEndpoint}/search/`

    Logger.debug(`Vespa endpoint: ${searchUrl}`)

    // Pagination parameters
    const hitsPerPage = 400 // Maximum allowed by Vespa
    let offset = 0
    let allFiles: any[] = []
    let totalCount = 0
    let hasMore = true

    // Fetch all files with pagination
    while (hasMore) {
      Logger.debug(`Fetching files with offset ${offset}, hits ${hitsPerPage}`)

      const response = await fetch(searchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          yql,
          hits: hitsPerPage,
          offset: offset,
          timeout: 10000,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        Logger.error(`Vespa HTTP error: ${response.status} ${response.statusText}`)
        Logger.error(`Vespa error response: ${errorText}`)
        throw new Error(
          `Vespa query failed: ${response.status} ${response.statusText}`,
        )
      }

      const results = await response.json()

      if (results && results.root) {
        // Store total count from first response
        if (offset === 0 && results.root.fields && results.root.fields.totalCount !== undefined) {
          totalCount = results.root.fields.totalCount
          Logger.info(`Total files in datasource ${datasourceId}: ${totalCount}`)
        }

        // Check for errors
        if (results.root.errors && results.root.errors.length > 0) {
          Logger.error(`Vespa query errors: ${JSON.stringify(results.root.errors)}`)
        }

        // Add children to results
        if (results.root.children && results.root.children.length > 0) {
          allFiles = allFiles.concat(results.root.children)
          Logger.debug(`Fetched ${results.root.children.length} files in this batch (total so far: ${allFiles.length})`)

          // Check if there are more files to fetch
          offset += results.root.children.length
          hasMore = results.root.children.length === hitsPerPage && offset < totalCount
        } else {
          // No more results
          hasMore = false
        }
      } else {
        // Invalid response
        hasMore = false
      }
    }

    if (allFiles.length > 0) {
      Logger.info(
        `Found ${allFiles.length} files for datasource ${datasourceId}`,
      )
      return allFiles
    }

    Logger.warn(
      `No files found for datasource ${datasourceId} (query returned no results)`,
    )
    return []
  } catch (error) {
    Logger.error(
      `Error fetching files for datasource ${datasourceId}:`,
      error,
    )
    if (error instanceof Error) {
      Logger.error(`Error message: ${error.message}`)
      Logger.error(`Error stack: ${error.stack}`)
    }
    return []
  }
}

/**
 * Dry run mode - shows what would be migrated without making changes
 */
async function dryRun() {
  Logger.info("Running in DRY RUN mode - no changes will be made")

  const agentsWithDatasources = await db
    .select()
    .from(agents)
    .where(isNull(agents.deletedAt))

  let totalDatasources = 0
  let agentsWithDsCount = 0

  for (const agent of agentsWithDatasources) {
    const appIntegrations = agent.appIntegrations as any

    if (
      appIntegrations &&
      typeof appIntegrations === "object" &&
      appIntegrations.DataSource
    ) {
      const datasourceIds = appIntegrations.DataSource.itemIds as string[]
      if (datasourceIds && datasourceIds.length > 0) {
        agentsWithDsCount++
        totalDatasources += datasourceIds.length
        Logger.info(
          `Agent ${agent.id} (${agent.name}): ${datasourceIds.length} datasources - ${datasourceIds.join(", ")}`,
        )
      }
    }
  }

  Logger.info("=" + "=".repeat(60))
  Logger.info("Dry Run Summary:")
  Logger.info(`Total agents: ${agentsWithDatasources.length}`)
  Logger.info(`Agents with datasources: ${agentsWithDsCount}`)
  Logger.info(`Total datasources to migrate: ${totalDatasources}`)
  Logger.info("=" + "=".repeat(60))
}

// Main execution
const args = process.argv.slice(2)
const isDryRun = args.includes("--dry-run")
const removeDataSource = args.includes("--remove-datasource")

// Log CLI flags
Logger.info("Migration Script Configuration:")
Logger.info(`  Dry run: ${isDryRun}`)
Logger.info(`  Remove DataSource after migration: ${removeDataSource}`)
if (!removeDataSource) {
  Logger.warn("  ⚠️  DataSource objects will NOT be removed (use --remove-datasource to remove)")
}
Logger.info("=" + "=".repeat(60))

if (isDryRun) {
  dryRun()
    .then(() => {
      Logger.info("Dry run completed successfully")
      process.exit(0)
    })
    .catch((error) => {
      Logger.error("Dry run failed:", error)
      process.exit(1)
    })
} else {
  migrateDatasourcesToKnowledgeBase(removeDataSource)
    .then(() => {
      Logger.info("Migration completed successfully")
      process.exit(0)
    })
    .catch((error) => {
      Logger.error("Migration failed:", error)
      process.exit(1)
    })
}
