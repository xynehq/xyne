#!/usr/bin/env node
/**
 * Knowledge Base File Status Migration using proper Drizzle ORM patterns
 * Updates existing collections and collection_items with default status fields
 */

import { db } from "@/db/client"
import { collections, collectionItems } from "@/db/schema"
import { eq, sql } from "drizzle-orm"
import { UploadStatus } from "@/shared/types"
import type { TxnOrClient } from "@/types"

const BATCH_SIZE = 100

async function migrateCollectionItems(trx: TxnOrClient = db) {
  console.log("🔄 Starting collection_items migration...")

  let totalUpdated = 0
  let batchCount = 0

  while (true) {
    batchCount++
    console.log(`Processing collection_items batch ${batchCount}...`)

    // Update batch of collection_items using Drizzle schema
    const result = await trx
      .update(collectionItems)
      .set({
        statusMessage: sql`CASE 
          WHEN ${collectionItems.statusMessage} IS NULL OR ${collectionItems.statusMessage} = '' 
          THEN 'Successfully uploaded' 
          ELSE ${collectionItems.statusMessage} 
        END`,
        uploadStatus: sql`CASE 
          WHEN ${collectionItems.uploadStatus} IS NULL OR ${collectionItems.uploadStatus} = '' 
          THEN ${UploadStatus.COMPLETED} 
          ELSE ${collectionItems.uploadStatus} 
        END`,
        retryCount: sql`CASE 
          WHEN ${collectionItems.retryCount} IS NULL 
          THEN 0 
          ELSE ${collectionItems.retryCount} 
        END`,
        updatedAt: sql`NOW()`,
      })
      .where(
        sql`${collectionItems.id} IN (
          SELECT id FROM ${collectionItems} 
          WHERE ${collectionItems.deletedAt} IS NULL 
            AND (
              ${collectionItems.statusMessage} IS NULL 
              OR ${collectionItems.statusMessage} = '' 
              OR ${collectionItems.uploadStatus} IS NULL 
              OR ${collectionItems.uploadStatus} = ''
              OR ${collectionItems.retryCount} IS NULL
            )
          LIMIT ${BATCH_SIZE}
        )`
      )
      .returning({ id: collectionItems.id })

    const updatedRows = result.length
    totalUpdated += updatedRows

    console.log(`Batch ${batchCount}: Updated ${updatedRows} collection_items`)

    if (updatedRows === 0) {
      console.log("✅ No more collection_items to update")
      break
    }

    // Small delay between batches
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  console.log(
    `📊 Collection_items migration complete: ${totalUpdated} total records updated`,
  )
  return totalUpdated
}

async function migrateCollections(trx: TxnOrClient = db) {
  console.log("🔄 Starting collections migration...")

  let totalUpdated = 0
  let batchCount = 0

  while (true) {
    batchCount++
    console.log(`Processing collections batch ${batchCount}...`)

    // Update batch of collections using Drizzle schema
    const result = await trx
      .update(collections)
      .set({
        statusMessage: sql`CASE 
          WHEN ${collections.statusMessage} IS NULL OR ${collections.statusMessage} = '' 
          THEN 'Collection created successfully' 
          ELSE ${collections.statusMessage} 
        END`,
        uploadStatus: sql`CASE 
          WHEN ${collections.uploadStatus} IS NULL OR ${collections.uploadStatus} = '' 
          THEN ${UploadStatus.COMPLETED} 
          ELSE ${collections.uploadStatus} 
        END`,
        retryCount: sql`CASE 
          WHEN ${collections.retryCount} IS NULL 
          THEN 0 
          ELSE ${collections.retryCount} 
        END`,
        updatedAt: sql`NOW()`,
      })
      .where(
        sql`${collections.id} IN (
          SELECT id FROM ${collections} 
          WHERE ${collections.deletedAt} IS NULL 
            AND (
              ${collections.statusMessage} IS NULL 
              OR ${collections.statusMessage} = '' 
              OR ${collections.uploadStatus} IS NULL 
              OR ${collections.uploadStatus} = ''
              OR ${collections.retryCount} IS NULL
            )
          LIMIT ${BATCH_SIZE}
        )`
      )
      .returning({ id: collections.id })

    const updatedRows = result.length
    totalUpdated += updatedRows

    console.log(`Batch ${batchCount}: Updated ${updatedRows} collections`)

    if (updatedRows === 0) {
      console.log("✅ No more collections to update")
      break
    }

    // Small delay between batches
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  console.log(
    `📊 Collections migration complete: ${totalUpdated} total records updated`,
  )
  return totalUpdated
}

async function showStatus(trx: TxnOrClient = db) {
  console.log("📋 Checking current status...")

  // Check collection_items needing migration using Drizzle schema
  const [itemsResult] = await trx
    .select({ count: sql<number>`count(*)` })
    .from(collectionItems)
    .where(
      sql`${collectionItems.deletedAt} IS NULL 
        AND (
          ${collectionItems.statusMessage} IS NULL 
          OR ${collectionItems.statusMessage} = '' 
          OR ${collectionItems.uploadStatus} IS NULL 
          OR ${collectionItems.uploadStatus} = ''
          OR ${collectionItems.retryCount} IS NULL
        )`
    )

  // Check collections needing migration using Drizzle schema
  const [collectionsResult] = await trx
    .select({ count: sql<number>`count(*)` })
    .from(collections)
    .where(
      sql`${collections.deletedAt} IS NULL 
        AND (
          ${collections.statusMessage} IS NULL 
          OR ${collections.statusMessage} = '' 
          OR ${collections.uploadStatus} IS NULL 
          OR ${collections.uploadStatus} = ''
          OR ${collections.retryCount} IS NULL
        )`
    )

  const itemsCount = itemsResult?.count || 0
  const collectionsCount = collectionsResult?.count || 0

  console.log(`📊 Records needing migration:`)
  console.log(`   - Collection items: ${itemsCount}`)
  console.log(`   - Collections: ${collectionsCount}`)
  console.log("")

  return { itemsCount, collectionsCount }
}

async function main() {
  try {
    console.log("🚀 Status Fields Migration Script")
    console.log("=================================")

    // Show initial status
    const initialStatus = await showStatus()

    if (
      initialStatus.itemsCount === 0 &&
      initialStatus.collectionsCount === 0
    ) {
      console.log("✅ No records need migration!")
      process.exit(0)
    }

    // Migrate collection_items
    const itemsUpdated = await migrateCollectionItems()

    // Migrate collections
    const collectionsUpdated = await migrateCollections()

    // Show final status
    console.log("🔍 Verifying migration...")
    const finalStatus = await showStatus()

    if (finalStatus.itemsCount === 0 && finalStatus.collectionsCount === 0) {
      console.log("🎉 Migration completed successfully!")
      console.log(
        `📊 Total updated: ${itemsUpdated + collectionsUpdated} records`,
      )
    } else {
      console.log("⚠️  Some records still need migration:")
      console.log(`   - Collection items: ${finalStatus.itemsCount}`)
      console.log(`   - Collections: ${finalStatus.collectionsCount}`)
    }

    process.exit(0)
  } catch (error) {
    console.error("❌ Migration failed:", error)
    process.exit(1)
  }
}

/**
 * Update a specific collection's status fields
 */
export async function updateCollectionStatus(
  collectionId: string,
  updates: {
    statusMessage?: string
    uploadStatus?: UploadStatus
    retryCount?: number
  },
  trx: TxnOrClient = db
) {
  const [result] = await trx
    .update(collections)
    .set({
      ...updates,
      updatedAt: sql`NOW()`,
    })
    .where(eq(collections.id, collectionId))
    .returning()

  return result
}

/**
 * Update a specific collection item's status fields
 */
export async function updateCollectionItemStatus(
  itemId: string,
  updates: {
    statusMessage?: string
    uploadStatus?: UploadStatus
    retryCount?: number
  },
  trx: TxnOrClient = db
) {
  const [result] = await trx
    .update(collectionItems)
    .set({
      ...updates,
      updatedAt: sql`NOW()`,
    })
    .where(eq(collectionItems.id, itemId))
    .returning()

  return result
}

// Run the migration
main()
